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
import { scheduleReconcile } from './reconciliation.js';
import {
  reconcileTotal,
  reconcileDuration,
  errorsTotal,
  reconcileQueueDepth
} from './metrics.js';
import { deleteCollection } from './collection-ops.js';
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
      log(
        `Status update in progress for "${name}", queuing ${phase} event for later processing`
      );
      if (!pendingEvents.has(resourceKey)) {
        pendingEvents.set(resourceKey, []);
      }
      pendingEvents.get(resourceKey).push({ phase, apiObj });
      endTimer();
      return;
    }
    // ignore duplicated event on watch reconnections (per-cluster)
    if (
      lastClusterResourceVersion.get(resourceKey) ===
      apiObj.metadata.resourceVersion
    ) {
      endTimer();
      return;
    }
    // update ResourceVersion for this specific cluster
    lastClusterResourceVersion.set(
      resourceKey,
      apiObj.metadata.resourceVersion
    );
    // Update cache
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      clusterCache.set(resourceKey, apiObj);
    } else if (phase === 'DELETED') {
      clusterCache.delete(resourceKey);
    }
    log(
      `Received event in phase ${phase} for cluster "${name}" in namespace "${namespace}".`
    );

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
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  const endTimer = reconcileDuration.startTimer({
    resource_type: 'collection'
  });

  try {
    // ignore duplicated event on watch reconnections (per-collection)
    if (
      lastCollectionResourceVersion.get(resourceKey) ===
      apiObj.metadata.resourceVersion
    ) {
      endTimer();
      return;
    }
    // update ResourceVersion for this specific collection
    lastCollectionResourceVersion.set(
      resourceKey,
      apiObj.metadata.resourceVersion
    );
    // Update cache
    if (phase === 'ADDED' || phase === 'MODIFIED') {
      collectionCache.set(resourceKey, apiObj);
    } else if (phase === 'DELETED') {
      collectionCache.delete(resourceKey);
    }
    log(
      `Received event in phase ${phase} for collection "${name}" in namespace "${namespace}".`
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
    await addFinalizer(apiObj, 'qdrantcollections');

    // Enqueue reconciliation (declarative model)
    if (['ADDED', 'MODIFIED'].includes(phase)) {
      try {
        scheduleReconcile(apiObj, 'collection');
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
