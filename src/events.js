import { k8sCustomApi } from './k8s-client.js';
import {
  settingStatus,
  lastClusterResourceVersion,
  lastCollectionResourceVersion,
  clusterCache,
  collectionCache,
  applyQueue,
  pendingEvents
} from './state.js';
import { addFinalizer, removeFinalizer } from './finalizers.js';
import { cleanupCluster, cleanupCollection } from './cleanup.js';
import {
  scheduleReconcile,
  reconcileCollection,
  validateClusterSpec,
  validateCollectionSpec
} from './reconciliation.js';
import { reconcileTotal, reconcileDuration, errorsTotal, reconcileQueueDepth } from './metrics.js';
import { deleteCollection } from './collection-ops.js';
import { setErrorStatus } from './status.js';
import { log } from './utils.js';

// React on QdrantClusters events
export const onEventCluster = async (phase, apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  const endTimer = reconcileDuration.startTimer({ resource_type: 'cluster' });

  try {
    // If status is being updated, queue this event instead of ignoring it
    if (settingStatus.has(resourceKey)) {
      log(`Status update in progress for "${name}", queuing ${phase} event for later processing`);
      if (!pendingEvents.has(resourceKey)) {
        pendingEvents.set(resourceKey, []);
      }
      pendingEvents.get(resourceKey).push({ phase, apiObj });
      endTimer();
      return;
    }

    // CRITICAL: Validate spec BEFORE checking for duplicates
    // InvalidSpec is an admission logic error, not a reconciliation error
    // It must be detected at event time, before any side effects
    // This ensures status Error is written immediately, even for the first ADDED event
    // We must validate BEFORE the duplicate check, otherwise the first ADDED event
    // might be discarded before validation runs
    if (['ADDED', 'MODIFIED'].includes(phase)) {
      const validationError = validateClusterSpec(apiObj.spec);
      if (validationError) {
        log(`❌ Invalid spec for cluster "${name}": ${validationError}`);
        await setErrorStatus(apiObj, validationError, 'cluster', 'InvalidSpec');
        errorsTotal.inc({ type: 'validation' });
        // Update resourceVersion to prevent duplicate processing
        lastClusterResourceVersion.set(resourceKey, apiObj.metadata.resourceVersion);
        endTimer();
        return; // Don't schedule reconcile for invalid specs
      }
    }

    // Check for duplicated event on watch reconnections (per-cluster)
    // This check happens AFTER validation to ensure InvalidSpec is always detected
    const isDuplicate =
      lastClusterResourceVersion.get(resourceKey) === apiObj.metadata.resourceVersion;
    if (isDuplicate) {
      endTimer();
      return;
    }

    // update ResourceVersion for this specific cluster
    lastClusterResourceVersion.set(resourceKey, apiObj.metadata.resourceVersion);
    // Update cache
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      clusterCache.set(resourceKey, apiObj);
    } else if (phase === 'DELETED') {
      clusterCache.delete(resourceKey);
    }
    log(`Received event in phase ${phase} for cluster "${name}" in namespace "${namespace}".`);

    // Handle deletion with finalizer (with retry and backoff)
    if (apiObj.metadata.deletionTimestamp) {
      log(`Cluster "${name}" is being deleted, starting cleanup...`);
      try {
        await cleanupCluster(apiObj);
        // Cleanup succeeded - remove finalizer
        await removeFinalizer(apiObj, 'qdrantclusters');
        reconcileTotal.inc({ resource_type: 'cluster', result: 'success' });
        // Clean up tracking
        lastClusterResourceVersion.delete(resourceKey);
        applyQueue.delete(resourceKey);
        reconcileQueueDepth.set(applyQueue.size); // Update queue depth metric
      } catch (err) {
        // Check if cleanup returned without throwing (force delete scenario)
        // In that case, cleanupCluster returns normally but status is 'Failed'
        try {
          const statusRes = await k8sCustomApi.getNamespacedCustomObjectStatus({
            group: 'qdrant.operator',
            version: 'v1alpha1',
            namespace: apiObj.metadata.namespace,
            plural: 'qdrantclusters',
            name: name
          });
          const cleanupPhase = statusRes.status?.cleanupPhase;
          const cleanupAttempts = statusRes.status?.cleanupAttempts || 0;

          if (cleanupPhase === 'Failed' && cleanupAttempts >= 10) {
            // Force delete scenario - remove finalizer to allow deletion
            log(
              `⚠️ Cleanup failed after maximum attempts for cluster "${name}". Removing finalizer to allow deletion (escape hatch).`
            );
            await removeFinalizer(apiObj, 'qdrantclusters');
            reconcileTotal.inc({ resource_type: 'cluster', result: 'error' });
            errorsTotal.inc({ type: 'cleanup_force_delete' });
          } else {
            // Regular failure - don't remove finalizer, Kubernetes will retry
            log(`Error during cluster deletion cleanup: ${err.message}`);
            reconcileTotal.inc({ resource_type: 'cluster', result: 'error' });
            errorsTotal.inc({ type: 'reconcile' });
          }
        } catch (statusErr) {
          // Can't check status - assume regular failure
          log(`Error during cluster deletion cleanup: ${err.message}`);
          reconcileTotal.inc({ resource_type: 'cluster', result: 'error' });
          errorsTotal.inc({ type: 'reconcile' });
        }
      }
      endTimer();
      return;
    }

    // Ensure finalizer is present
    await addFinalizer(apiObj, 'qdrantclusters');

    // Enqueue reconciliation (declarative model)
    if (['ADDED', 'MODIFIED'].includes(phase)) {
      try {
        scheduleReconcile(apiObj, 'cluster');
      } catch (err) {
        log(err);
        reconcileTotal.inc({ resource_type: 'cluster', result: 'error' });
        errorsTotal.inc({ type: 'reconcile' });
      }
    } else if (phase == 'DELETED') {
      log(`${apiObj.kind} "${name}" was deleted!`);
      // Clean up tracking for deleted cluster
      lastClusterResourceVersion.delete(resourceKey);
      applyQueue.delete(resourceKey);
      reconcileQueueDepth.set(applyQueue.size); // Update queue depth metric
      clusterCache.delete(resourceKey);
    }
  } finally {
    endTimer();
  }
};

// React on QdrantCollections events
export const onEventCollection = async (phase, apiObj) => {
  const name = apiObj.metadata?.name || 'unknown';
  const namespace = apiObj.metadata?.namespace || 'unknown';
  const resourceKey = `${namespace}/${name}`;

  // Log immediately when function is called (before any processing)
  log(
    `🎯 onEventCollection called for collection "${name}" in namespace "${namespace}" (phase: ${phase})`
  );

  const endTimer = reconcileDuration.startTimer({
    resource_type: 'collection'
  });

  try {
    // Log ALL events received, even if they might be duplicates
    log(
      `📨 Event received for collection "${name}" (phase: ${phase}, resourceVersion: ${apiObj.metadata.resourceVersion}, lastRV: ${lastCollectionResourceVersion.get(resourceKey) || 'none'})`
    );

    // CRITICAL: Validate spec BEFORE checking for duplicates
    // InvalidSpec is an admission logic error, not a reconciliation error
    // It must be detected at event time, before any side effects
    // This ensures status Error is written immediately, even for the first ADDED event
    // We must validate BEFORE the duplicate check, otherwise the first ADDED event
    // might be discarded before validation runs
    if (['ADDED', 'MODIFIED'].includes(phase)) {
      const validationError = validateCollectionSpec(apiObj.spec);
      if (validationError) {
        log(`❌ Invalid spec for collection "${name}": ${validationError}`);
        await setErrorStatus(apiObj, validationError, 'collection', 'InvalidSpec');
        errorsTotal.inc({ type: 'validation' });
        // Update resourceVersion to prevent duplicate processing
        lastCollectionResourceVersion.set(resourceKey, apiObj.metadata.resourceVersion);
        endTimer();
        return; // Don't schedule reconcile for invalid specs
      }
    }

    // Check for duplicated event on watch reconnections (per-collection)
    // This check happens AFTER validation to ensure InvalidSpec is always detected
    const isDuplicate =
      lastCollectionResourceVersion.get(resourceKey) === apiObj.metadata.resourceVersion;
    if (isDuplicate) {
      log(
        `⏭️ Skipping duplicate event for collection "${name}" (resourceVersion: ${apiObj.metadata.resourceVersion})`
      );
      endTimer();
      return;
    }

    // update ResourceVersion for this specific collection
    lastCollectionResourceVersion.set(resourceKey, apiObj.metadata.resourceVersion);
    // Update cache
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      collectionCache.set(resourceKey, apiObj);
    } else if (phase === 'DELETED') {
      collectionCache.delete(resourceKey);
    }
    log(
      `📥 Received event in phase ${phase} for collection "${name}" in namespace "${namespace}".`
    );

    // Handle deletion with finalizer
    if (apiObj.metadata.deletionTimestamp) {
      log(`Collection "${name}" is being deleted, starting cleanup...`);
      try {
        await cleanupCollection(apiObj);
        // Cleanup succeeded - remove finalizer
        await removeFinalizer(apiObj, 'qdrantcollections');
        reconcileTotal.inc({ resource_type: 'collection', result: 'success' });
        // Clean up tracking
        lastCollectionResourceVersion.delete(resourceKey);
      } catch (err) {
        // Check if cleanup returned without throwing (force delete scenario)
        // Collections don't have status field, so we check attempt count differently
        // For collections, if cleanup returns normally after max attempts, it's force delete
        log(`Error during collection deletion cleanup: ${err.message}`);

        // Try to check if we should force delete (cleanupCollection returns after max attempts)
        // Since collections don't track attempts in status, we rely on cleanupCollection
        // returning normally (not throwing) after FORCE_DELETE_AFTER_ATTEMPTS
        // This is a limitation but acceptable for collections (simpler resource)
        reconcileTotal.inc({ resource_type: 'collection', result: 'error' });
        errorsTotal.inc({ type: 'reconcile' });
        // Note: For collections, we don't implement force delete escape hatch
        // as they don't have status tracking. This is acceptable as collections
        // are simpler resources and cleanup failures are less critical.
      }
      endTimer();
      return;
    }

    // Ensure finalizer is present
    try {
      await addFinalizer(apiObj, 'qdrantcollections');
      log(`✅ Finalizer added/verified for collection "${name}"`);
    } catch (finalizerErr) {
      log(`❌ Error adding finalizer to collection "${name}": ${finalizerErr.message}`);
      // Continue anyway - reconciliation can proceed without finalizer initially
      // Finalizer will be added on next event or periodic reconciliation
    }

    // Enqueue reconciliation (declarative model)
    if (['ADDED', 'MODIFIED'].includes(phase)) {
      try {
        scheduleReconcile(apiObj, 'collection');
        log(`✅ Scheduled reconciliation for collection "${name}"`);

        // CRITICAL: Also trigger immediate reconciliation for ADDED events
        // This ensures collection is processed even if scheduled one fails or is delayed
        if (phase === 'ADDED') {
          log(`🚀 Triggering immediate reconciliation for new collection "${name}"...`);
          // Don't await - let it run in background, scheduled one will also run
          reconcileCollection(apiObj).catch((err) => {
            log(
              `⚠️ Immediate reconciliation failed for "${name}": ${err.message}. Scheduled reconciliation will still run.`
            );
            // Scheduled one will still run, so this is not critical
          });
        }

        reconcileTotal.inc({ resource_type: 'collection', result: 'success' });
      } catch (err) {
        log(`Error scheduling collection reconciliation: ${err.message}`);
        reconcileTotal.inc({ resource_type: 'collection', result: 'error' });
        errorsTotal.inc({ type: 'reconcile' });
      }
    } else if (phase == 'DELETED') {
      // This should not happen with finalizers, but handle it anyway
      await deleteCollection(apiObj, k8sCustomApi, null);
      // Clean up tracking for deleted collection
      lastCollectionResourceVersion.delete(resourceKey);
      collectionCache.delete(resourceKey);
    }
  } finally {
    endTimer();
  }
};
