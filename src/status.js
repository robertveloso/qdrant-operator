import { k8sCustomApi } from './k8s-client.js';
import { settingStatus, pendingEvents } from './state.js';
import { log } from './utils.js';

/**
 * Status Update Lock System
 *
 * During status updates, we use settingStatus as a lock to prevent concurrent reconciles.
 * Events that occur during status updates are queued in pendingEvents and processed after
 * the status update completes. This prevents:
 * - Race conditions on status updates
 * - Lost events during status update windows
 * - Concurrent reconciles modifying the same resource
 *
 * See state.js for more details on settingStatus and pendingEvents.
 */

// Set cleanup status with phase and attempt count (for retry tracking)
export const setCleanupStatus = async (apiObj, phase, attempt = null, error = null) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  settingStatus.set(resourceKey, 'update');

  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const readObj = await k8sCustomApi.getNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name
      });
      const resCurrent = readObj;
      const newStatus = {
        apiVersion: apiObj.apiVersion,
        kind: apiObj.kind,
        metadata: {
          name: apiObj.metadata.name,
          resourceVersion: resCurrent.metadata.resourceVersion
        },
        status: {
          qdrantStatus: resCurrent.status?.qdrantStatus || 'Pending',
          cleanupPhase: phase,
          ...(attempt !== null && { cleanupAttempts: attempt }),
          ...(error && { cleanupError: error })
        }
      };

      await k8sCustomApi.replaceNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name,
        body: newStatus
      });
      setTimeout(() => settingStatus.delete(resourceKey), 300);

      // Process any pending events that occurred during cleanup status update
      if (pendingEvents.has(resourceKey)) {
        const events = pendingEvents.get(resourceKey);
        pendingEvents.delete(resourceKey);
        log(
          `Processing ${events.length} pending event(s) for "${name}" that occurred during cleanup status update`
        );

        // Import dynamically to avoid circular dependency
        const { onEventCluster } = await import('./events.js');
        // Process events asynchronously (don't await to avoid blocking)
        for (const event of events) {
          setTimeout(async () => {
            try {
              await onEventCluster(event.phase, event.apiObj);
            } catch (err) {
              log(`Error processing pending cleanup event for "${name}": ${err.message}`);
            }
          }, 100);
        }
      }

      return;
    } catch (err) {
      const errorCode = err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      if (errorCode === 409 || (err.message && err.message.includes('Conflict'))) {
        retries++;
        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * retries));
          continue;
        }
      } else {
        setTimeout(() => settingStatus.delete(resourceKey), 300);
        return;
      }
    }
  }
  setTimeout(() => settingStatus.delete(resourceKey), 300);
};

// Set the customresource status with phase and optional conditions
export const setStatusWithPhase = async (
  apiObj,
  phase,
  conditions = null,
  resourceType = 'cluster'
) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  settingStatus.set(resourceKey, 'update');

  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const plural = resourceType === 'cluster' ? 'qdrantclusters' : 'qdrantcollections';
      const readObj = await k8sCustomApi.getNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: plural,
        name: name
      });
      const resCurrent = readObj;
      const newStatus = {
        apiVersion: apiObj.apiVersion,
        kind: apiObj.kind,
        metadata: {
          name: apiObj.metadata.name,
          resourceVersion: resCurrent.metadata.resourceVersion
        },
        status: {
          ...(resCurrent.status || {}),
          qdrantStatus: phase,
          ...(conditions && { conditions })
        }
      };

      await k8sCustomApi.replaceNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: plural,
        name: name,
        body: newStatus
      });
      log(`The ${resourceType} "${name}" status now is ${phase}.`);
      setTimeout(() => settingStatus.delete(resourceKey), 300);

      // Process any pending events that occurred during status update
      if (pendingEvents.has(resourceKey)) {
        const events = pendingEvents.get(resourceKey);
        pendingEvents.delete(resourceKey);
        log(
          `Processing ${events.length} pending event(s) for "${name}" that occurred during status update`
        );

        const { onEventCluster } = await import('./events.js');
        for (const event of events) {
          setTimeout(async () => {
            try {
              await onEventCluster(event.phase, event.apiObj);
            } catch (err) {
              log(`Error processing pending event for "${name}": ${err.message}`);
            }
          }, 100);
        }
      }

      return;
    } catch (err) {
      const errorCode = err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      if (errorCode === 409 || (err.message && err.message.includes('Conflict'))) {
        retries++;
        if (retries < maxRetries) {
          log(`Status update conflict for "${name}", retrying (${retries}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, 100 * retries));
          continue;
        } else {
          log(`Failed to update status for "${name}" after ${maxRetries} retries: ${err.message}`);
        }
      } else {
        log(`Error updating status for "${name}": ${err.message}`);
        setTimeout(() => settingStatus.delete(resourceKey), 300);
        return;
      }
    }
  }
  setTimeout(() => settingStatus.delete(resourceKey), 300);
};

// Set the customresource status, clusters only at the moment
// This is kept for backward compatibility, but now uses richer phases
export const setStatus = async (apiObj, status) => {
  // Map old status values to new phases
  let phase = status;
  if (status === 'Running') {
    // Check if cluster is actually healthy (all replicas ready)
    try {
      const name = apiObj.metadata.name;
      const namespace = apiObj.metadata.namespace;
      const { k8sAppsApi } = await import('./k8s-client.js');
      const stsRes = await k8sAppsApi.readNamespacedStatefulSet({
        name: name,
        namespace: namespace
      });
      const sts = stsRes;
      if (
        sts.status?.availableReplicas >= sts.spec.replicas &&
        sts.status?.updatedReplicas >= sts.spec.replicas &&
        sts.status?.readyReplicas >= sts.spec.replicas
      ) {
        phase = 'Healthy';
      } else {
        phase = 'OperationInProgress';
      }
    } catch (err) {
      // If we can't check, default to Running
      phase = 'Running';
    }
  }

  await setStatusWithPhase(apiObj, phase);
};

// Set error status with message (for invalid spec or other errors)
// Uses patch directly on the received object (no cache lookup) to avoid 404 issues
export const setErrorStatus = async (
  apiObj,
  errorMessage,
  resourceType = 'cluster',
  reason = 'InvalidSpec'
) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  settingStatus.set(resourceKey, 'update');

  const plural = resourceType === 'cluster' ? 'qdrantclusters' : 'qdrantcollections';

  // Build status patch using the object we received (no cache lookup needed)
  // observedGeneration tracks which spec generation was observed (never use resourceVersion as fallback)
  // Always include observedGeneration when available - this allows kubectl/UI to know if status matches current spec
  const statusPatch = {
    qdrantStatus: 'Error',
    errorMessage: errorMessage,
    reason: reason,
    observedGeneration: apiObj.metadata.generation,
    conditions: [
      {
        type: 'Ready',
        status: 'False',
        reason: reason,
        message: errorMessage,
        lastTransitionTime: new Date().toISOString()
      }
    ]
  };

  // CRITICAL: Always use /status subresource for CRDs with status subresource enabled.
  // Patching status via the main object endpoint does NOT work when subresources.status is enabled.
  // The API server will silently ignore or reject it depending on version.
  // Rule: If CRD has subresources.status, ALWAYS write status via /status endpoint.
  const patchStatus = async () => {
    await k8sCustomApi.patchNamespacedCustomObjectStatus(
      'qdrant.operator',
      'v1alpha1',
      namespace,
      plural,
      name,
      { status: statusPatch },
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/merge-patch+json' }
      }
    );
  };

  // Retry with exponential backoff for 404 (eventual consistency - /status may not exist yet for newly created CRs)
  const MAX_RETRIES = 5;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await patchStatus();
      log(`Set error status for ${resourceType} "${name}": ${errorMessage} (reason: ${reason})`);
      setTimeout(() => settingStatus.delete(resourceKey), 300);
      return;
    } catch (err) {
      const errorCode = err.statusCode || err.code || (err.body && JSON.parse(err.body)?.code);

      // Handle 404 (Not Found) - /status subresource may not exist yet (eventual consistency)
      if (errorCode === 404) {
        if (i < MAX_RETRIES - 1) {
          const delay = 200 * (i + 1);
          log(
            `Status endpoint not available yet for "${name}", retrying in ${delay}ms (attempt ${i + 1}/${MAX_RETRIES})...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        } else {
          log(
            `⚠️ Failed to set error status for "${name}" after ${MAX_RETRIES} retries (status endpoint may not be available yet). Error: ${errorMessage}`
          );
          setTimeout(() => settingStatus.delete(resourceKey), 300);
          return;
        }
      }

      // Handle 409 (Conflict) - resource version conflict
      if (errorCode === 409) {
        // For conflicts, try replace as fallback (requires getting current resource)
        try {
          const resCurrent = await k8sCustomApi.getNamespacedCustomObjectStatus({
            group: 'qdrant.operator',
            version: 'v1alpha1',
            namespace: namespace,
            plural: plural,
            name: name
          });

          const newStatus = {
            apiVersion: apiObj.apiVersion,
            kind: apiObj.kind,
            metadata: {
              name: apiObj.metadata.name,
              resourceVersion: resCurrent.metadata.resourceVersion
            },
            status: {
              ...(resCurrent.status || {}),
              ...statusPatch
            }
          };

          await k8sCustomApi.replaceNamespacedCustomObjectStatus({
            group: 'qdrant.operator',
            version: 'v1alpha1',
            namespace: namespace,
            plural: plural,
            name: name,
            body: newStatus
          });
          log(
            `Set error status for ${resourceType} "${name}": ${errorMessage} (reason: ${reason})`
          );
          setTimeout(() => settingStatus.delete(resourceKey), 300);
          return;
        } catch (replaceErr) {
          const replaceCode =
            replaceErr.statusCode ||
            replaceErr.code ||
            (replaceErr.body && JSON.parse(replaceErr.body)?.code);
          log(
            `Error setting error status for "${name}": ${replaceErr.message} (code: ${replaceCode || 'unknown'})`
          );
          setTimeout(() => settingStatus.delete(resourceKey), 300);
          return;
        }
      }

      // Other errors (403 RBAC, 500 server error, etc.) - don't retry, log with code
      log(
        `Error setting error status for "${name}": ${err.message} (code: ${errorCode || 'unknown'})`
      );
      setTimeout(() => settingStatus.delete(resourceKey), 300);
      return;
    }
  }
};

// Update the version of last caught cluster
export const updateResourceVersion = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  const res = await k8sCustomApi.getNamespacedCustomObjectStatus({
    group: 'qdrant.operator',
    version: 'v1alpha1',
    namespace: namespace,
    plural: 'qdrantclusters',
    name: name
  });
  const resCurrent = res;
  // Import dynamically to avoid circular dependency
  const { lastClusterResourceVersion } = await import('./state.js');
  lastClusterResourceVersion.set(resourceKey, resCurrent.metadata.resourceVersion);
};
