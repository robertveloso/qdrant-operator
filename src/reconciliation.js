import { k8sAppsApi, k8sCoreApi, k8sCustomApi, k8sPolicyApi, k8sBatchApi } from './k8s-client.js';
import {
  applyQueue,
  statefulSetCache,
  collectionCache,
  shuttingDown,
  activeReconciles,
  retryQueue
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
  applyJobs,
  getConnectionParameters
} from './collection-ops.js';
import { setStatus, updateResourceVersion, setErrorStatus } from './status.js';
import { calculateSpecHash, updateLastAppliedHash } from './spec-hash.js';
import { waitForClusterReadiness } from './readiness.js';
import { errorsTotal, driftDetectedTotal, reconcileQueueDepth } from './metrics.js';
import { log } from './utils.js';

// Schedule retry with persistent queue (survives reconnections)
// MAX_RETRIES: Maximum number of retry attempts before giving up (prevents infinite loops)
const MAX_RETRIES = 20;

const scheduleRetry = (apiObj, resourceType, delay = 5000, retryCount = 0) => {
  const resourceKey = `${apiObj.metadata.namespace}/${apiObj.metadata.name}`;
  const retryKey = `retry-${resourceKey}`;

  // Get existing retry count if retry already scheduled (preserve retry count across calls)
  let currentRetryCount = retryCount;
  if (retryQueue.has(retryKey)) {
    const existingRetry = retryQueue.get(retryKey);
    currentRetryCount = existingRetry.retryCount; // Use existing retry count
    clearTimeout(existingRetry.timeoutId);
  }

  // Check if we've exceeded max retries
  if (currentRetryCount >= MAX_RETRIES) {
    log(
      `⚠️ Max retries (${MAX_RETRIES}) reached for ${resourceType} "${apiObj.metadata.name}". Stopping retry attempts.`
    );
    retryQueue.delete(retryKey);
    return;
  }

  const timeoutId = setTimeout(() => {
    retryQueue.delete(retryKey);
    log(
      `🔄 Executing retry for ${resourceType} "${apiObj.metadata.name}" (attempt ${currentRetryCount + 1}/${MAX_RETRIES})...`
    );
    scheduleReconcile(apiObj, resourceType);
  }, delay);

  retryQueue.set(retryKey, {
    apiObj,
    resourceType,
    retryCount: currentRetryCount + 1,
    scheduledAt: Date.now(),
    timeoutId
  });

  log(
    `⏰ Scheduled retry for ${resourceType} "${apiObj.metadata.name}" in ${delay / 1000}s (attempt ${currentRetryCount + 1}/${MAX_RETRIES}, queue size: ${retryQueue.size})`
  );
};

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
      `⏭️ Reconciliation already scheduled for ${resourceType} "${name}", skipping... (queue size: ${applyQueue.size})`
    );
    return;
  }
  log(
    `📅 Scheduling reconciliation for ${resourceType} "${name}" in namespace "${namespace}" (queue size before: ${applyQueue.size}, retry queue size: ${retryQueue.size})`
  );
  // Schedule reconcile with debounce (1 second delay)
  const timeout = setTimeout(async () => {
    // Check again before starting reconcile (may have started shutting down during debounce)
    if (shuttingDown.value) {
      log(`Skipping reconcile for "${resourceKey}" - operator is shutting down`);
      applyQueue.delete(resourceKey);
      reconcileQueueDepth.set(applyQueue.size);
      return;
    }

    applyQueue.delete(resourceKey);
    reconcileQueueDepth.set(applyQueue.size); // Update queue depth metric
    log(
      `📊 Queue state: applyQueue size=${applyQueue.size}, retryQueue size=${retryQueue.size}, activeReconciles=${activeReconciles.size}`
    );

    // Mark as active reconcile
    activeReconciles.add(resourceKey);

    try {
      log(
        `🚀 Starting reconciliation for ${resourceType} "${name}"... (active reconciles: ${activeReconciles.size})`
      );
      if (resourceType === 'cluster') {
        await reconcileCluster(apiObj);
      } else if (resourceType === 'collection') {
        await reconcileCollection(apiObj);
      } else if (resourceType === 'restore') {
        await reconcileRestore(apiObj);
      }
      log(`✅ Completed reconciliation for ${resourceType} "${name}"`);
    } catch (err) {
      log(`❌ Error in reconciliation for ${resourceType} "${name}": ${err.message}`);
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

// Validate cluster spec
export const validateClusterSpec = (spec) => {
  if (!spec) {
    return 'Spec is required';
  }
  if (typeof spec.replicas !== 'undefined' && spec.replicas < 1) {
    return `Invalid replicas: ${spec.replicas}. Must be >= 1`;
  }
  if (!spec.image || spec.image.trim() === '') {
    return 'Image is required and cannot be empty';
  }
  return null; // Valid
};

// Validate collection spec
export const validateCollectionSpec = (spec) => {
  if (!spec) {
    return 'Spec is required';
  }
  if (!spec.cluster || spec.cluster.trim() === '') {
    return 'Cluster name is required';
  }
  if (typeof spec.vectorSize !== 'number' || spec.vectorSize < 1) {
    return `Invalid vectorSize: ${spec.vectorSize}. Must be >= 1`;
  }
  if (typeof spec.shardNumber !== 'undefined' && spec.shardNumber < 1) {
    return `Invalid shardNumber: ${spec.shardNumber}. Must be >= 1`;
  }
  if (typeof spec.replicationFactor !== 'undefined' && spec.replicationFactor < 1) {
    return `Invalid replicationFactor: ${spec.replicationFactor}. Must be >= 1`;
  }
  return null; // Valid
};

// Declarative reconciliation: compare desired (CR spec) vs observed (actual state)
export const reconcileCluster = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;

  // 🔒 Terminal state guard: if already in InvalidSpec Error state, skip reconciliation
  // This prevents concurrent reconciles from overwriting the Error status
  // Spec inválida é terminal e sticky - nenhum outro reconcile pode limpar ou ignorar isso
  if (apiObj.status?.qdrantStatus === 'Error' && apiObj.status?.reason === 'InvalidSpec') {
    log(`⏭️ Cluster "${name}" is in InvalidSpec Error state, skipping reconciliation`);
    return;
  }

  // ✅ Always validate spec (allows recovery when spec is fixed)
  const desired = apiObj.spec;
  const validationError = validateClusterSpec(desired);
  if (validationError) {
    log(`❌ Invalid spec for cluster "${name}": ${validationError}`);
    await setErrorStatus(apiObj, validationError, 'cluster', 'InvalidSpec');
    errorsTotal.inc({ type: 'validation' });
    // Don't requeue - spec error is terminal, user must fix the spec
    return;
  }

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
    const { k8sNetworkingApi } = await import('./k8s-client.js');
    const { applyNetworkPolicyCluster } = await import('./cluster-ops.js');
    await applyNetworkPolicyCluster(apiObj, k8sNetworkingApi);
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
    log(`Spec hash unchanged for "${name}" (${desiredHash}), skipping StatefulSet reconciliation`);
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
      log(`No previous hash found for "${name}", initial reconciliation with hash ${desiredHash}`);
      // Don't count initial reconciliation as drift
    }
  }

  // Always apply "cheap" resources (ConfigMap, Service) - they're idempotent and low cost
  // These don't cause rollouts and are safe to apply frequently
  await applyConfigmapCluster(apiObj, k8sCoreApi);
  await applyServiceHeadlessCluster(apiObj, k8sCoreApi);
  await applyServiceCluster(apiObj, k8sCoreApi);
  await applyPdbCluster(apiObj, k8sPolicyApi);
  const { k8sNetworkingApi } = await import('./k8s-client.js');
  const { applyNetworkPolicyCluster } = await import('./cluster-ops.js');
  await applyNetworkPolicyCluster(apiObj, k8sNetworkingApi);

  // Check and expand PVCs if size increased (automatic volume expansion)
  const { expandPVCIfNeeded, createClusterVolumeSnapshot, cleanupOldSnapshots } =
    await import('./pvc-ops.js');
  await expandPVCIfNeeded(apiObj);

  // Handle VolumeSnapshots if configured
  if (apiObj.spec.volumeSnapshots?.enabled) {
    const snapshotClassName =
      apiObj.spec.volumeSnapshots.snapshotClassName ||
      apiObj.spec.persistence?.volumeSnapshotClassName;

    // Create snapshot if requested (one-time trigger)
    if (apiObj.spec.volumeSnapshots.createNow) {
      const snapshotName = `${name}-snapshot-${Date.now()}`;
      await createClusterVolumeSnapshot(apiObj, snapshotName, snapshotClassName);

      // Reset createNow flag (would need to patch CR, but for now just log)
      log(`ℹ️ VolumeSnapshot created. Consider removing createNow flag from spec.`);
    }

    // Create/update CronJob for scheduled snapshots
    if (apiObj.spec.volumeSnapshots.schedule) {
      const { applyVolumeSnapshotCronJob } = await import('./pvc-ops.js');
      await applyVolumeSnapshotCronJob(apiObj);
    }

    // Cleanup old snapshots based on retention policy (if not using CronJob)
    if (!apiObj.spec.volumeSnapshots.schedule) {
      const retentionCount = apiObj.spec.volumeSnapshots.retentionCount || 7;
      await cleanupOldSnapshots(name, namespace, retentionCount);
    }
  }

  // Apply secrets only if they might have changed (they have their own idempotency logic)
  const readApikey = await applyReadSecretCluster(apiObj, k8sCoreApi);
  const apikey = await applySecretCluster(apiObj, k8sCoreApi);
  await applyAuthSecretCluster(apiObj, k8sCoreApi, apikey, readApikey);

  // Phase 3: Apply StatefulSet only if drift detected (avoids unnecessary rollouts)
  // Note: Kubernetes is idempotent - applying StatefulSet only triggers rollout if spec actually changed
  if (needsStatefulSetReconcile) {
    const { setStatusWithPhase } = await import('./status.js');
    await setStatusWithPhase(apiObj, 'OperationInProgress', [
      {
        type: 'Reconciling',
        status: 'True',
        lastTransitionTime: new Date().toISOString(),
        reason: 'StatefulSetUpdate',
        message: 'Updating StatefulSet to match desired state'
      }
    ]);
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
          sts.status?.updatedReplicas >= sts.spec.replicas &&
          sts.status?.readyReplicas >= sts.spec.replicas
        ) {
          const { setStatusWithPhase } = await import('./status.js');
          await setStatusWithPhase(apiObj, 'Healthy', [
            {
              type: 'Ready',
              status: 'True',
              lastTransitionTime: new Date().toISOString(),
              reason: 'AllReplicasReady',
              message: `All ${sts.spec.replicas} replicas are ready and available`
            }
          ]);
          await updateResourceVersion(apiObj);
        } else {
          // Cluster is running but not all replicas are ready yet
          const { setStatusWithPhase } = await import('./status.js');
          const available = sts.status?.availableReplicas || 0;
          const desired = sts.spec.replicas;
          await setStatusWithPhase(apiObj, 'OperationInProgress', [
            {
              type: 'Ready',
              status: 'False',
              lastTransitionTime: new Date().toISOString(),
              reason: 'ReplicasNotReady',
              message: `${available}/${desired} replicas are ready`
            }
          ]);
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

  // 🔒 Terminal state guard: if already in InvalidSpec Error state, skip reconciliation
  // This prevents concurrent reconciles from overwriting the Error status
  // Spec inválida é terminal e sticky - nenhum outro reconcile pode limpar ou ignorar isso
  if (apiObj.status?.qdrantStatus === 'Error' && apiObj.status?.reason === 'InvalidSpec') {
    log(`⏭️ Collection "${name}" is in InvalidSpec Error state, skipping reconciliation`);
    return;
  }

  // ✅ Always validate spec (allows recovery when spec is fixed)
  const validationError = validateCollectionSpec(apiObj.spec);
  if (validationError) {
    log(`❌ Invalid spec for collection "${name}": ${validationError}`);
    await setErrorStatus(apiObj, validationError, 'collection', 'InvalidSpec');
    errorsTotal.inc({ type: 'validation' });
    // Don't requeue - spec error is terminal, user must fix the spec
    return;
  }

  const clusterName = apiObj.spec?.cluster;

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
    // Collections can only be created when the cluster is in "Running" or "Healthy" status
    let clusterStatus = null;
    let clusterStatusRes = null;
    try {
      clusterStatusRes = await k8sCustomApi.getNamespacedCustomObjectStatus({
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
      // Try to get cluster object for debug info
      try {
        const clusterObj = await k8sCustomApi.getNamespacedCustomObject({
          group: 'qdrant.operator',
          version: 'v1alpha1',
          namespace: namespace,
          plural: 'qdrantclusters',
          name: clusterName
        });
        log(
          `🔍 Debug: Cluster "${clusterName}" exists but status check failed. Cluster spec: replicas=${clusterObj.spec?.replicas || 'undefined'}, image=${clusterObj.spec?.image || 'undefined'}`
        );
      } catch (debugErr) {
        log(`🔍 Debug: Could not fetch cluster object for debugging: ${debugErr.message}`);
      }
      // Cluster might not exist yet or API error - schedule retry
      scheduleRetry(currentCollection, 'collection', 5000, 0);
      return;
    }

    // If cluster is not ready, check StatefulSet directly as fallback
    // Status may be stale even when StatefulSet is actually ready
    if (clusterStatus !== 'Running' && clusterStatus !== 'Healthy') {
      // Verificar StatefulSet diretamente como fallback
      let stsReady = false;
      try {
        const stsRes = await k8sAppsApi.readNamespacedStatefulSet({
          name: clusterName,
          namespace: namespace
        });
        const sts = stsRes;
        stsReady =
          sts.status?.availableReplicas >= sts.spec?.replicas &&
          sts.status?.updatedReplicas >= sts.spec?.replicas;

        if (stsReady && clusterStatus !== 'Running' && clusterStatus !== 'Healthy') {
          log(
            `⚠️ Cluster status is "${clusterStatus}" but StatefulSet is ready. Proceeding with collection creation (status may be stale)...`
          );
          // Continue - StatefulSet is ready, status may just be stale
        } else if (!stsReady) {
          // StatefulSet not ready - use existing retry logic with debug info
          log(
            `⚠️ Cluster "${clusterName}" is not ready (status: ${clusterStatus || 'unknown'}). Collection "${name}" will be created when cluster is ready.`
          );

          // Debug: Get detailed cluster and StatefulSet information
          try {
            const clusterObj = await k8sCustomApi.getNamespacedCustomObject({
              group: 'qdrant.operator',
              version: 'v1alpha1',
              namespace: namespace,
              plural: 'qdrantclusters',
              name: clusterName
            });
            log(
              `🔍 Debug Cluster "${clusterName}": status=${clusterStatus || 'unknown'}, spec.replicas=${clusterObj.spec?.replicas || 'undefined'}, spec.image=${clusterObj.spec?.image || 'undefined'}`
            );
            log(
              `🔍 Debug StatefulSet "${clusterName}": replicas=${sts.spec?.replicas || 'undefined'}, readyReplicas=${sts.status?.readyReplicas || 0}, availableReplicas=${sts.status?.availableReplicas || 0}, updatedReplicas=${sts.status?.updatedReplicas || 0}`
            );
            if (
              sts.status?.availableReplicas < sts.spec?.replicas ||
              sts.status?.updatedReplicas < sts.spec?.replicas
            ) {
              log(
                `🔍 Debug: StatefulSet not fully ready - waiting for ${sts.spec?.replicas - (sts.status?.availableReplicas || 0)} more pod(s) to become available`
              );
            }

            // Check Pod status
            try {
              const podsRes = await k8sCoreApi.listNamespacedPod({
                namespace: namespace,
                labelSelector: `clustername=${clusterName}`
              });
              log(
                `🔍 Debug Pods: Found ${podsRes.items.length} pod(s) for cluster "${clusterName}"`
              );
              for (const pod of podsRes.items) {
                const podStatus = pod.status?.phase || 'unknown';
                const ready = pod.status?.conditions?.find((c) => c.type === 'Ready')?.status;
                log(
                  `🔍 Debug Pod "${pod.metadata.name}": phase=${podStatus}, ready=${ready || 'unknown'}, restartCount=${pod.status?.containerStatuses?.[0]?.restartCount || 0}`
                );
                if (pod.status?.containerStatuses?.[0]?.state?.waiting) {
                  log(
                    `🔍 Debug Pod "${pod.metadata.name}" waiting: reason=${pod.status.containerStatuses[0].state.waiting.reason || 'unknown'}, message=${pod.status.containerStatuses[0].state.waiting.message || 'none'}`
                  );
                }
              }
            } catch (podsErr) {
              log(`🔍 Debug: Could not list pods for cluster "${clusterName}": ${podsErr.message}`);
            }
          } catch (debugErr) {
            log(
              `🔍 Debug: Error getting debug info for cluster "${clusterName}": ${debugErr.message}`
            );
          }

          // Schedule retry after delay (reduced to 5 seconds for faster recovery)
          scheduleRetry(currentCollection, 'collection', 5000, 0);
          return;
        }
      } catch (stsErr) {
        // If can't check StatefulSet, fall back to status check
        log(
          `⚠️ Cluster "${clusterName}" is not ready (status: ${clusterStatus || 'unknown'}) and could not verify StatefulSet. Collection "${name}" will be created when cluster is ready.`
        );
        log(`🔍 Debug: Could not read StatefulSet "${clusterName}": ${stsErr.message}`);
        scheduleRetry(currentCollection, 'collection', 5000, 0);
        return;
      }
    }

    log(
      `✅ Cluster "${clusterName}" is ready (status: ${clusterStatus}), proceeding with collection reconciliation... (applyQueue size: ${applyQueue.size}, retryQueue size: ${retryQueue.size})`
    );
    log(
      `📋 Collection spec: cluster="${clusterName}", vectorSize=${currentCollection.spec.vectorSize || 'undefined'}, shardNumber=${currentCollection.spec.shardNumber || 'undefined'}, replicationFactor=${currentCollection.spec.replicationFactor || 'undefined'}`
    );

    // Quick health check - try to GET /collections to verify Qdrant is responding
    try {
      const parameters = await getConnectionParameters(currentCollection, k8sCustomApi, k8sCoreApi);
      const healthUrl = parameters.url.replace(/\/collections\/[^/]+$/, '/collections');
      const healthController = new AbortController();
      const healthTimeout = setTimeout(() => healthController.abort(), 5000);

      const healthResp = await fetch(healthUrl, {
        method: 'GET',
        headers: parameters.headers,
        signal: healthController.signal
      });
      clearTimeout(healthTimeout);

      if (!healthResp.ok && healthResp.status !== 404) {
        log(`⚠️ Qdrant health check returned ${healthResp.status}, but proceeding...`);
      } else {
        log(`✅ Qdrant is responding to API requests`);
      }
    } catch (healthErr) {
      log(`⚠️ Qdrant health check failed: ${healthErr.message}. Will retry in 5s...`);
      scheduleRetry(currentCollection, 'collection', 5000, 0);
      return;
    }

    // CRITICAL FIX: Always try createCollection first
    // PUT is idempotent in Qdrant - if collection exists, it will succeed anyway
    // Don't use cache to decide between create/update - cache is only for performance
    // The issue was: when collection is created, it's added to cache in onEventCollection
    // before reconciliation runs, so reconcileCollection would find it in cache
    // and try to update (PATCH) instead of create (PUT), but PATCH doesn't create
    // collections that don't exist yet

    // Always try to create first (PUT is idempotent in Qdrant)
    // If collection already exists, PUT will succeed and update it if needed
    log(`🚀 Attempting to create/update collection "${name}" in cluster "${clusterName}"...`);
    try {
      await createCollection(currentCollection, k8sCustomApi, k8sCoreApi);
      log(`✅ Collection "${name}" creation/update completed successfully`);
    } catch (createErr) {
      log(`❌ Failed to create collection "${name}": ${createErr.message}. Will retry...`);
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
      scheduleRetry(latestCollection, 'collection', 5000, 0);
    } catch (fetchErr) {
      // If we can't fetch latest, use provided object
      scheduleRetry(apiObj, 'collection', 5000, 0);
    }
  }
};

// Declarative reconciliation for restore operations
export const reconcileRestore = async (restoreObj) => {
  const name = restoreObj.metadata.name;
  const namespace = restoreObj.metadata.namespace;
  const collectionName = restoreObj.spec.collection;
  const backupId = restoreObj.spec.backupId;

  log(
    `🔄 Starting reconciliation for restore "${name}" (collection: "${collectionName}", backup: "${backupId}")`
  );

  // Get current status
  const currentPhase = restoreObj.status?.phase || 'Pending';

  // If already completed or failed, skip
  if (currentPhase === 'Completed' || currentPhase === 'Failed') {
    log(`⏭️ Restore "${name}" already ${currentPhase}, skipping`);
    return;
  }

  try {
    // Update status to InProgress
    if (currentPhase !== 'InProgress') {
      const { updateRestoreStatus } = await import('./restore-ops.js');
      await updateRestoreStatus(restoreObj, 'InProgress', 'Restore operation started');
    }

    // Execute restore
    const { executeRestore } = await import('./restore-ops.js');
    const jobName = await executeRestore(restoreObj, k8sCustomApi, k8sBatchApi);

    // Wait for job to complete (polling)
    log(`⏳ Waiting for restore job "${jobName}" to complete...`);
    let jobCompleted = false;
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes max (5s * 120)

    while (!jobCompleted && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

      try {
        const job = await k8sBatchApi.readNamespacedJob(jobName, namespace);
        const jobStatus = job.body.status;

        if (jobStatus.succeeded) {
          jobCompleted = true;
          const { updateRestoreStatus } = await import('./restore-ops.js');
          // Fetch latest restore object before updating status
          const latestRestore = await k8sCustomApi.getNamespacedCustomObject({
            group: 'qdrant.operator',
            version: 'v1alpha1',
            namespace: namespace,
            plural: 'qdrantcollectionrestores',
            name: name
          });
          await updateRestoreStatus(
            latestRestore.body || latestRestore,
            'Completed',
            `Restore completed successfully. Job: ${jobName}`
          );
          log(`✅ Restore "${name}" completed successfully`);
        } else if (jobStatus.failed) {
          jobCompleted = true;
          const { updateRestoreStatus } = await import('./restore-ops.js');
          const latestRestore = await k8sCustomApi.getNamespacedCustomObject({
            group: 'qdrant.operator',
            version: 'v1alpha1',
            namespace: namespace,
            plural: 'qdrantcollectionrestores',
            name: name
          });
          await updateRestoreStatus(
            latestRestore.body || latestRestore,
            'Failed',
            `Restore job failed. Job: ${jobName}`,
            'Job execution failed'
          );
          log(`❌ Restore "${name}" failed`);
        }
        // If job is still running, continue polling
      } catch (err) {
        if (err.statusCode === 404) {
          // Job not found yet, continue waiting
          attempts++;
          continue;
        }
        throw err;
      }

      attempts++;
    }

    if (!jobCompleted) {
      const { updateRestoreStatus } = await import('./restore-ops.js');
      const latestRestore = await k8sCustomApi.getNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantcollectionrestores',
        name: name
      });
      await updateRestoreStatus(
        latestRestore.body || latestRestore,
        'Failed',
        'Restore operation timed out',
        'Job did not complete within timeout period'
      );
      log(`❌ Restore "${name}" timed out after ${maxAttempts * 5} seconds`);
    }
  } catch (err) {
    log(`❌ Error reconciling restore "${name}": ${err.message}`);
    const { updateRestoreStatus } = await import('./restore-ops.js');
    try {
      const latestRestore = await k8sCustomApi.getNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantcollectionrestores',
        name: name
      });
      await updateRestoreStatus(
        latestRestore.body || latestRestore,
        'Failed',
        `Restore operation failed: ${err.message}`,
        err.message
      );
    } catch (fetchErr) {
      // If we can't fetch latest, try with provided object
      await updateRestoreStatus(
        restoreObj,
        'Failed',
        `Restore operation failed: ${err.message}`,
        err.message
      );
    }
    errorsTotal.inc({ type: 'restore' });
  }
};

// Legacy function kept for backward compatibility (now calls reconcile)
export const applyNow = async (apiObj) => {
  await reconcileCluster(apiObj);
};
