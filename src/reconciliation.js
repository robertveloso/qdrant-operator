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
    log(
      `Reconciliation already scheduled for ${resourceType} "${name}", skipping...`
    );
    return;
  }
  log(
    `Scheduling reconciliation for ${resourceType} "${name}" in namespace "${namespace}"`
  );
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
      log(`Starting reconciliation for ${resourceType} "${name}"...`);
      if (resourceType === 'cluster') {
        await reconcileCluster(apiObj);
      } else if (resourceType === 'collection') {
        await reconcileCollection(apiObj);
      }
      log(`✅ Completed reconciliation for ${resourceType} "${name}"`);
    } catch (err) {
      log(
        `❌ Error in reconciliation for ${resourceType} "${name}": ${err.message}`
      );
      if (err.stack) {
        log(`   Stack: ${err.stack}`);
      }
      throw err;
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
      const res = await k8sAppsApi.readNamespacedStatefulSet({
        name: name,
        namespace: namespace
      });
      observedStatefulSet = res;
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
      const res = await k8sAppsApi.readNamespacedStatefulSet({
        name: name,
        namespace: namespace
      });
      statefulSetCache.set(resourceKey, res);
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
    const statusRes = await k8sCustomApi.getNamespacedCustomObjectStatus({
      group: 'qdrant.operator',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'qdrantclusters',
      name: name
    });
    lastAppliedHash = statusRes.status?.lastAppliedHash;
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
      const res = await k8sAppsApi.readNamespacedStatefulSet({
        name: name,
        namespace: namespace
      });
      statefulSetCache.set(resourceKey, res);
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
      const currentStatus = await k8sCustomApi.getNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name
      });
      // Only update status if it's not already Running
      if (currentStatus.status?.qdrantStatus !== 'Running') {
        // Check if StatefulSet is actually ready
        const stsRes = await k8sAppsApi.readNamespacedStatefulSet({
          name: name,
          namespace: namespace
        });
        const sts = stsRes;
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
  const resourceKey = `${namespace}/${name}`;
  const clusterName = apiObj.spec?.cluster;

  if (!clusterName) {
    log(
      `❌ Collection "${name}" has no cluster specified in spec.cluster. Cannot reconcile.`
    );
    return;
  }

  log(
    `🔄 Starting reconciliation for collection "${name}" in namespace "${namespace}" (cluster: "${clusterName}")`
  );

  // For collections, reconciliation is simpler - just ensure it exists in Qdrant
  // The actual collection creation/update is handled by createCollection/updateCollection
  try {
    // CRITICAL: Fetch latest collection object from Kubernetes to ensure we have current state
    let currentCollection = apiObj;
    try {
      const latestCollection = await k8sCustomApi.getNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantcollections',
        name: name
      });
      currentCollection = latestCollection;
      // Update cache with latest object
      collectionCache.set(resourceKey, currentCollection);
    } catch (err) {
      log(
        `⚠️ Error fetching latest collection object for "${name}": ${err.message}. Using provided object.`
      );
      // Continue with provided object if fetch fails
    }

    // CRITICAL: Check if cluster is ready before attempting to create/update collection
    // Collections can only be created when the cluster is in "Running" status
    let clusterStatus = null;
    try {
      const clusterStatusRes =
        await k8sCustomApi.getNamespacedCustomObjectStatus({
          group: 'qdrant.operator',
          version: 'v1alpha1',
          namespace: namespace,
          plural: 'qdrantclusters',
          name: clusterName
        });
      clusterStatus = clusterStatusRes.status?.qdrantStatus;
    } catch (err) {
      log(
        `⚠️ Error checking cluster status for "${clusterName}": ${err.message}. Will retry later.`
      );
      // Cluster might not exist yet or API error - schedule retry
      setTimeout(() => {
        scheduleReconcile(currentCollection, 'collection');
      }, 10000); // Retry in 10 seconds
      return;
    }

    // If cluster is not ready, schedule a retry
    if (clusterStatus !== 'Running') {
      log(
        `⚠️ Cluster "${clusterName}" is not ready (status: ${clusterStatus || 'unknown'}). Collection "${name}" will be created when cluster is ready.`
      );
      // Schedule retry after delay
      setTimeout(() => {
        scheduleReconcile(currentCollection, 'collection');
      }, 10000); // Retry in 10 seconds
      return;
    }

    log(
      `✅ Cluster "${clusterName}" is ready (status: ${clusterStatus}), proceeding with collection reconciliation...`
    );
    log(
      `📋 Collection spec: cluster="${clusterName}", vectorSize=${currentCollection.spec.vectorSize || 'undefined'}, shardNumber=${currentCollection.spec.shardNumber || 'undefined'}, replicationFactor=${currentCollection.spec.replicationFactor || 'undefined'}`
    );

    // CRITICAL FIX: Always try createCollection first
    // PUT is idempotent in Qdrant - if collection exists, it will succeed anyway
    // Don't use cache to decide between create/update - cache is only for performance
    // The issue was: when collection is created, it's added to cache in onEventCollection
    // before reconciliation runs, so reconcileCollection would find it in cache
    // and try to update (PATCH) instead of create (PUT), but PATCH doesn't create
    // collections that don't exist yet

    // Always try to create first (PUT is idempotent in Qdrant)
    // If collection already exists, PUT will succeed and update it if needed
    log(
      `🚀 Attempting to create/update collection "${name}" in cluster "${clusterName}"...`
    );
    try {
      await createCollection(currentCollection, k8sCustomApi, k8sCoreApi);
      log(`✅ Collection "${name}" creation/update completed successfully`);
    } catch (createErr) {
      log(
        `❌ Failed to create collection "${name}": ${createErr.message}. Will retry...`
      );
      throw createErr; // Re-throw to be caught by outer catch
    }
    try {
      await applyJobs(currentCollection, k8sCustomApi, k8sBatchApi);
      log(`✅ Jobs applied successfully for collection "${name}"`);
    } catch (jobsErr) {
      log(
        `⚠️ Error applying jobs for collection "${name}": ${jobsErr.message}. Collection was created but jobs failed.`
      );
      // Don't throw - jobs are optional, collection creation is the critical part
    }
    log(`✅ Completed reconciliation for collection "${name}"`);
  } catch (err) {
    log(`❌ Error reconciling collection "${name}": ${err.message}`);
    if (err.stack) {
      log(`   Stack: ${err.stack}`);
    }
    errorsTotal.inc({ type: 'reconcile' });
    // Don't throw - schedule retry instead to allow recovery
    // This prevents the error from being lost if it's a transient issue
    // Fetch latest object before retrying
    try {
      const latestCollection = await k8sCustomApi.getNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantcollections',
        name: name
      });
      setTimeout(() => {
        scheduleReconcile(latestCollection, 'collection');
      }, 10000); // Retry in 10 seconds
    } catch (fetchErr) {
      // If we can't fetch latest, use provided object
      setTimeout(() => {
        scheduleReconcile(apiObj, 'collection');
      }, 10000); // Retry in 10 seconds
    }
  }
};

// Legacy function kept for backward compatibility (now calls reconcile)
export const applyNow = async (apiObj) => {
  await reconcileCluster(apiObj);
};
