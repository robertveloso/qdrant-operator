import { k8sCustomApi } from './k8s-client.js';
import { settingStatus, pendingEvents } from './state.js';
import { log } from './utils.js';

// Set cleanup status with phase and attempt count (for retry tracking)
export const setCleanupStatus = async (
  apiObj,
  phase,
  attempt = null,
  error = null
) => {
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
              log(
                `Error processing pending cleanup event for "${name}": ${err.message}`
              );
            }
          }, 100);
        }
      }

      return;
    } catch (err) {
      const errorCode =
        err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      if (
        errorCode === 409 ||
        (err.message && err.message.includes('Conflict'))
      ) {
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

// Set the customresource status, clusters only at the moment
export const setStatus = async (apiObj, status) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  // add cluster key to the map of currently updating resources
  settingStatus.set(resourceKey, 'update');

  // Retry logic for 409 conflicts (race conditions)
  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      // get current status
      const readObj = await k8sCustomApi.getNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name
      });
      const resCurrent = readObj;
      // prepare new payload
      const newStatus = {
        apiVersion: apiObj.apiVersion,
        kind: apiObj.kind,
        metadata: {
          name: apiObj.metadata.name,
          resourceVersion: resCurrent.metadata.resourceVersion
        },
        status: {
          qdrantStatus: status
        }
      };
      // set new status
      await k8sCustomApi.replaceNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name,
        body: newStatus
      });
      log(`The cluster "${name}" status now is ${status}.`);
      // job is done, remove this resource from the map
      setTimeout(() => settingStatus.delete(resourceKey), 300);

      // Process any pending events that occurred during status update
      if (pendingEvents.has(resourceKey)) {
        const events = pendingEvents.get(resourceKey);
        pendingEvents.delete(resourceKey);
        log(
          `Processing ${events.length} pending event(s) for "${name}" that occurred during status update`
        );

        // Import dynamically to avoid circular dependency
        const { onEventCluster } = await import('./events.js');
        // Process events asynchronously (don't await to avoid blocking)
        for (const event of events) {
          // Use setTimeout to ensure status update is fully complete
          setTimeout(async () => {
            try {
              await onEventCluster(event.phase, event.apiObj);
            } catch (err) {
              log(
                `Error processing pending event for "${name}": ${err.message}`
              );
            }
          }, 100);
        }
      }

      return; // Success, exit retry loop
    } catch (err) {
      const errorCode =
        err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      // If 409 Conflict (resource version changed), retry with fresh resourceVersion
      if (
        errorCode === 409 ||
        (err.message && err.message.includes('Conflict'))
      ) {
        retries++;
        if (retries < maxRetries) {
          log(
            `Status update conflict for "${name}", retrying (${retries}/${maxRetries})...`
          );
          // Small delay before retry
          await new Promise((resolve) => setTimeout(resolve, 100 * retries));
          continue;
        } else {
          log(
            `Failed to update status for "${name}" after ${maxRetries} retries: ${err.message}`
          );
        }
      } else {
        // Other errors, log and exit
        log(`Error updating status for "${name}": ${err.message}`);
        setTimeout(() => settingStatus.delete(resourceKey), 300);
        return;
      }
    }
  }
  // If we get here, all retries failed
  setTimeout(() => settingStatus.delete(resourceKey), 300);
};

// Set error status with message (for invalid spec or other errors)
export const setErrorStatus = async (
  apiObj,
  errorMessage,
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
      const plural =
        resourceType === 'cluster' ? 'qdrantclusters' : 'qdrantcollections';
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
          qdrantStatus: 'Error',
          errorMessage: errorMessage
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
      log(`Set error status for ${resourceType} "${name}": ${errorMessage}`);
      setTimeout(() => settingStatus.delete(resourceKey), 300);
      return;
    } catch (err) {
      const errorCode =
        err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      if (
        errorCode === 409 ||
        (err.message && err.message.includes('Conflict'))
      ) {
        retries++;
        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * retries));
          continue;
        }
      } else {
        log(`Error setting error status for "${name}": ${err.message}`);
        setTimeout(() => settingStatus.delete(resourceKey), 300);
        return;
      }
    }
  }
  setTimeout(() => settingStatus.delete(resourceKey), 300);
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
  lastClusterResourceVersion.set(
    resourceKey,
    resCurrent.metadata.resourceVersion
  );
};
