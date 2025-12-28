import {
  k8sAppsApi,
  k8sCoreApi,
  k8sCustomApi,
  k8sPolicyApi,
  k8sBatchApi
} from './k8s-client.js';
import {
  applyQueue,
  statefulSetCache,
  collectionCache,
  shuttingDown,
  activeReconciles
} from './state.js';
import {
  applyCluster,
  applyConfigmapCluster,
  applyReadSecretCluster,
  applySecretCluster,
  applyAuthSecretCluster,
  applyServiceHeadlessCluster,
  applyServiceCluster,
  applyPdbCluster
} from './cluster-ops.js';
import {
  createCollection,
  updateCollection,
  applyJobs
} from './collection-ops.js';
import { setStatus, updateResourceVersion } from './status.js';
import { calculateSpecHash, updateLastAppliedHash } from './spec-hash.js';
import { waitForClusterReadiness } from './readiness.js';
import {
  errorsTotal,
  driftDetectedTotal,
  reconcileQueueDepth
} from './metrics.js';
import { log } from './utils.js';

// Schedule reconciliation (declarative model - replaces scheduleApplying)
export const scheduleReconcile = (apiObj, resourceType) => {
  // Don't start new reconciles if we're shutting down
  if (shuttingDown.value) {
    log('Skipping reconcile scheduling - operator is shutting down');
    return;
  }

  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  // If already scheduled for this resource, skip (prevents duplicate processing)
  if (applyQueue.has(resourceKey)) {
    return;
  }
  // Schedule reconcile with debounce (1 second delay)
  const timeout = setTimeout(async () => {
    // Check again before starting reconcile (may have started shutting down during debounce)
    if (shuttingDown.value) {
      log(
        `Skipping reconcile for "${resourceKey}" - operator is shutting down`
      );
      applyQueue.delete(resourceKey);
      reconcileQueueDepth.set(applyQueue.size);
      return;
    }

    applyQueue.delete(resourceKey);
    reconcileQueueDepth.set(applyQueue.size); // Update queue depth metric

    // Mark as active reconcile
    activeReconciles.add(resourceKey);

    try {
      if (resourceType === 'cluster') {
        await reconcileCluster(apiObj);
      } else if (resourceType === 'collection') {
        await reconcileCollection(apiObj);
      }
    } finally {
      // Remove from active reconciles when done
      activeReconciles.delete(resourceKey);
    }
  }, 1000);
  applyQueue.set(resourceKey, timeout);
  reconcileQueueDepth.set(applyQueue.size); // Update queue depth metric
};

// Legacy function kept for backward compatibility (now calls reconcile)
export const scheduleApplying = (apiObj) => {
  scheduleReconcile(apiObj, 'cluster');
};

// Declarative reconciliation: compare desired (CR spec) vs observed (actual state)
export const reconcileCluster = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;

  // Get desired state from CR spec
  const desired = apiObj.spec;

  // Get observed state from cache (fast read) with API fallback (source of truth)
  // Cache is used for performance, but API is always checked for critical decisions
  let observedStatefulSet = null;
  const cachedSts = statefulSetCache.get(resourceKey);
  if (cachedSts) {
    observedStatefulSet = cachedSts;
  } else {
    // Fallback to API call if not in cache (source of truth)
    try {
      const res = await k8sAppsApi.readNamespacedStatefulSet(name, namespace);
      observedStatefulSet = res.body;
      statefulSetCache.set(resourceKey, observedStatefulSet);
    } catch (err) {
      if (!err.message.includes('not found')) {
        log(`Error reading StatefulSet "${name}": ${err.message}`);
        errorsTotal.inc({ type: 'api_read' });
      }
      // StatefulSet doesn't exist - will be created
    }
  }

  // Phase 1: If StatefulSet doesn't exist, create everything
  // NOTE: We verify via API (not just cache) before creating - cache is not source of truth
  if (!observedStatefulSet) {
    log(`StatefulSet "${name}" not found, creating all resources...`);
    await setStatus(apiObj, 'Pending');
    await applyConfigmapCluster(apiObj, k8sCoreApi);
    const readApikey = await applyReadSecretCluster(apiObj, k8sCoreApi);
    const apikey = await applySecretCluster(apiObj, k8sCoreApi);
    await applyAuthSecretCluster(apiObj, k8sCoreApi, apikey, readApikey);
    await applyServiceHeadlessCluster(apiObj, k8sCoreApi);
    await applyServiceCluster(apiObj, k8sCoreApi);
    await applyPdbCluster(apiObj, k8sPolicyApi);
    await applyCluster(apiObj, k8sAppsApi, k8sCoreApi);

    // Update cache after creating
    try {
      const res = await k8sAppsApi.readNamespacedStatefulSet(name, namespace);
      statefulSetCache.set(resourceKey, res.body);
    } catch (err) {
      // Ignore cache update errors
    }

    // Update hash after successful creation
    const desiredHash = calculateSpecHash(desired);
    await updateLastAppliedHash(apiObj, desiredHash);
    await updateResourceVersion(apiObj);
    waitForClusterReadiness(apiObj);
    return;
  }

  // Phase 2: Check if StatefulSet needs reconciliation using hash comparison (fast path)
  // Get last applied hash from status (formalized observed state)
  let lastAppliedHash = null;
  try {
    const statusRes = await k8sCustomApi.getNamespacedCustomObjectStatus(
      'qdrant.operator',
      'v1alpha1',
      namespace,
      'qdrantclusters',
      name
    );
    lastAppliedHash = statusRes.body.status?.lastAppliedHash;
  } catch (err) {
    // Ignore errors reading status
  }

  // Calculate current desired hash
  const desiredHash = calculateSpecHash(desired);

  // Fast path: if hash matches, spec hasn't changed - skip expensive diff
  let needsStatefulSetReconcile = false;
  if (lastAppliedHash && lastAppliedHash === desiredHash) {
    log(
      `Spec hash unchanged for "${name}" (${desiredHash}), skipping StatefulSet reconciliation`
    );
    needsStatefulSetReconcile = false;
  } else {
    // Hash differs or not set - always reapply StatefulSet
    // Kubernetes is idempotent for resources/env/volumes, only triggers rollout if needed
    // This ensures all fields (not just replicas/image) are properly reconciled
    needsStatefulSetReconcile = true;

    if (lastAppliedHash) {
      log(
        `StatefulSet drift detected for "${name}" (hash changed: ${lastAppliedHash} -> ${desiredHash}), reconciling...`
      );
      // Increment drift detection metric
      driftDetectedTotal.inc({ resource_type: 'cluster' });
    } else {
      log(
        `No previous hash found for "${name}", initial reconciliation with hash ${desiredHash}`
      );
      // Don't count initial reconciliation as drift
    }
  }

  // Always apply "cheap" resources (ConfigMap, Service) - they're idempotent and low cost
  // These don't cause rollouts and are safe to apply frequently
  await applyConfigmapCluster(apiObj, k8sCoreApi);
  await applyServiceHeadlessCluster(apiObj, k8sCoreApi);
  await applyServiceCluster(apiObj, k8sCoreApi);
  await applyPdbCluster(apiObj, k8sPolicyApi);

  // Apply secrets only if they might have changed (they have their own idempotency logic)
  const readApikey = await applyReadSecretCluster(apiObj, k8sCoreApi);
  const apikey = await applySecretCluster(apiObj, k8sCoreApi);
  await applyAuthSecretCluster(apiObj, k8sCoreApi, apikey, readApikey);

  // Phase 3: Apply StatefulSet only if drift detected (avoids unnecessary rollouts)
  // Note: Kubernetes is idempotent - applying StatefulSet only triggers rollout if spec actually changed
  if (needsStatefulSetReconcile) {
    await setStatus(apiObj, 'Pending');
    await applyCluster(apiObj, k8sAppsApi, k8sCoreApi);

    // Update cache after applying
    try {
      const res = await k8sAppsApi.readNamespacedStatefulSet(name, namespace);
      statefulSetCache.set(resourceKey, res.body);
    } catch (err) {
      // Ignore cache update errors
    }

    // Update hash after successful reconciliation
    await updateLastAppliedHash(apiObj, desiredHash);
    await updateResourceVersion(apiObj);
    waitForClusterReadiness(apiObj);
    log(`Reconciliation completed for cluster "${name}"`);
  } else {
    // No drift detected (hash matches) - just ensure status is up to date
    // This avoids unnecessary writes and potential rollouts
    // Also update hash if it wasn't set before (initial state)
    if (!lastAppliedHash) {
      log(`Setting initial spec hash for "${name}": ${desiredHash}`);
      await updateLastAppliedHash(apiObj, desiredHash);
    }

    try {
      const currentStatus = await k8sCustomApi.getNamespacedCustomObjectStatus(
        'qdrant.operator',
        'v1alpha1',
        namespace,
        'qdrantclusters',
        name
      );
      // Only update status if it's not already Running
      if (currentStatus.body.status?.qdrantStatus !== 'Running') {
        // Check if StatefulSet is actually ready
        const stsRes = await k8sAppsApi.readNamespacedStatefulSet(
          name,
          namespace
        );
        const sts = stsRes.body;
        if (
          sts.status?.availableReplicas >= sts.spec.replicas &&
          sts.status?.updatedReplicas >= sts.spec.replicas
        ) {
          await setStatus(apiObj, 'Running');
          await updateResourceVersion(apiObj);
        }
      }
    } catch (err) {
      // If status check fails, it's not critical - will be updated on next reconcile
      log(`Note: Could not verify status for "${name}": ${err.message}`);
    }
  }
};

// Declarative reconciliation for collections
export const reconcileCollection = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;

  // For collections, reconciliation is simpler - just ensure it exists in Qdrant
  // The actual collection creation/update is handled by createCollection/updateCollection
  try {
    // Check if collection exists in cache (fast read for optimization)
    // NOTE: createCollection/updateCollection will verify actual state via Qdrant API (source of truth)
    // Cache rule: cache → fast reads, API → critical decisions
    const resourceKey = `${namespace}/${name}`;
    const cachedCollection = collectionCache.get(resourceKey);

    if (cachedCollection) {
      // Collection exists in cache, update if needed
      // updateCollection will verify actual state via Qdrant API
      await updateCollection(apiObj, k8sCustomApi, k8sCoreApi);
      await applyJobs(apiObj, k8sCustomApi, k8sBatchApi);
    } else {
      // Collection doesn't exist in cache, create it
      // createCollection will verify actual state via Qdrant API
      await createCollection(apiObj, k8sCustomApi, k8sCoreApi);
      await applyJobs(apiObj, k8sCustomApi, k8sBatchApi);
    }
  } catch (err) {
    log(`Error reconciling collection "${name}": ${err.message}`);
    errorsTotal.inc({ type: 'reconcile' });
    throw err;
  }
};

// Legacy function kept for backward compatibility (now calls reconcile)
export const applyNow = async (apiObj) => {
  await reconcileCluster(apiObj);
};
