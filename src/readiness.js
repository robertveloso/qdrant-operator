import { k8sAppsApi, k8sCustomApi, watch } from './k8s-client.js';
import {
  statefulSetCache,
  statefulSetWatchAborted,
  statefulSetWatchRequests,
  statefulSetLastReadinessStatus
} from './state.js';
import { setStatus, updateResourceVersion } from './status.js';
import { log } from './utils.js';

// Check the cluster readiness using watch (more efficient than polling)
export const waitForClusterReadiness = (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;

  // Abort existing watch for this cluster if any
  if (statefulSetWatchRequests.has(resourceKey)) {
    statefulSetWatchAborted.set(resourceKey, true);
    try {
      statefulSetWatchRequests.get(resourceKey).abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    statefulSetWatchRequests.delete(resourceKey);
    statefulSetWatchAborted.delete(resourceKey);
    statefulSetLastReadinessStatus.delete(resourceKey);
  }

  // Reset abort flag for new watch
  statefulSetWatchAborted.set(resourceKey, false);

  // Watch StatefulSet directly instead of polling
  const watchPath = `/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}`;

  const onEventStatefulSet = async (phase, stsetObj) => {
    // Check if watch was aborted
    if (statefulSetWatchAborted.get(resourceKey)) {
      return;
    }

    try {
      const stset = stsetObj;
      // Update StatefulSet cache
      if (phase === 'ADDED' || phase === 'MODIFIED') {
        statefulSetCache.set(resourceKey, stset);
      } else if (phase === 'DELETED') {
        statefulSetCache.delete(resourceKey);
      }
      // wait until available and updated replicas >= desired replicas count
      if (
        stset.status &&
        stset.status.availableReplicas >= stset.spec.replicas &&
        stset.status.updatedReplicas >= stset.spec.replicas
      ) {
        log(`Cluster "${name}" is ready!`);
        // Clean up watch
        statefulSetWatchAborted.set(resourceKey, true);
        if (statefulSetWatchRequests.has(resourceKey)) {
          try {
            statefulSetWatchRequests.get(resourceKey).abort();
          } catch (err) {
            // Ignore errors when aborting
          }
        }
        statefulSetWatchRequests.delete(resourceKey);
        statefulSetWatchAborted.delete(resourceKey);
        statefulSetLastReadinessStatus.delete(resourceKey);
        // set resource status to Running
        await setStatus(apiObj, 'Running');
        // memorize this resourceversion
        await updateResourceVersion(apiObj);
      } else {
        // Only log readiness status changes, not every event (reduces log noise)
        const available = stset.status?.availableReplicas || 0;
        const desired = stset.spec.replicas;
        const currentStatus = `${available}/${desired}`;
        const lastStatus = statefulSetLastReadinessStatus.get(resourceKey);

        if (lastStatus !== currentStatus) {
          log(
            `Cluster "${name}" readiness: ${available}/${desired} replicas available.`
          );
          statefulSetLastReadinessStatus.set(resourceKey, currentStatus);
        }
      }
    } catch (err) {
      log(`Error processing StatefulSet event for "${name}": ${err.message}`);
    }
  };

  const onDoneStatefulSet = (err) => {
    const wasAborted = statefulSetWatchAborted.get(resourceKey);
    // Clean up
    statefulSetWatchRequests.delete(resourceKey);
    statefulSetWatchAborted.delete(resourceKey);
    statefulSetLastReadinessStatus.delete(resourceKey);

    if (wasAborted) {
      log(`StatefulSet watch for "${name}" was aborted.`);
      return;
    }

    if (err) {
      const errorMsg = err.message || String(err);
      // If StatefulSet was deleted, that's expected
      if (errorMsg.includes('not found') || errorMsg.includes('404')) {
        log(`Cluster "${name}" StatefulSet was deleted, stop watching.`);
        return;
      }
      log(`StatefulSet watch for "${name}" closed with error: ${errorMsg}`);
      // Retry watch after a delay (only if not aborted)
      setTimeout(() => {
        if (!statefulSetWatchAborted.get(resourceKey)) {
          waitForClusterReadiness(apiObj);
        }
      }, 5000);
    } else {
      log(`StatefulSet watch for "${name}" closed normally.`);
    }
  };

  try {
    const request = watch.watch(
      watchPath,
      {},
      onEventStatefulSet,
      onDoneStatefulSet
    );
    statefulSetWatchRequests.set(resourceKey, request);
    log(`Watching StatefulSet "${name}" for readiness.`);
  } catch (err) {
    log(`Error starting StatefulSet watch for "${name}": ${err.message}`);
    statefulSetWatchAborted.delete(resourceKey);
    statefulSetLastReadinessStatus.delete(resourceKey);
    // Fallback to polling if watch fails
    log(`Falling back to polling for cluster "${name}"...`);
    let interval = setInterval(
      async function (apiObj) {
        if (statefulSetWatchAborted.get(resourceKey)) {
          clearInterval(interval);
          statefulSetWatchRequests.delete(resourceKey);
          statefulSetWatchAborted.delete(resourceKey);
          statefulSetLastReadinessStatus.delete(resourceKey);
          return;
        }
        const name = apiObj.metadata.name;
        const namespace = apiObj.metadata.namespace;
        try {
          const res = await k8sAppsApi.readNamespacedStatefulSet(
            `${name}`,
            `${namespace}`
          );
          const stset = res.body;
          if (
            stset.status.availableReplicas >= stset.spec.replicas &&
            stset.status.updatedReplicas >= stset.spec.replicas
          ) {
            log(`Cluster "${name}" is ready!`);
            clearInterval(interval);
            statefulSetWatchAborted.set(resourceKey, true);
            statefulSetWatchRequests.delete(resourceKey);
            statefulSetWatchAborted.delete(resourceKey);
            statefulSetLastReadinessStatus.delete(resourceKey);
            await setStatus(apiObj, 'Running');
            await updateResourceVersion(apiObj);
          } else {
            // Only log readiness status changes in polling mode too (reduces log noise)
            const available = stset.status.availableReplicas;
            const desired = stset.spec.replicas;
            const currentStatus = `${available}/${desired}`;
            const lastStatus = statefulSetLastReadinessStatus.get(resourceKey);

            if (lastStatus !== currentStatus) {
              log(
                `Cluster "${name}" readiness: ${available}/${desired} replicas available.`
              );
              statefulSetLastReadinessStatus.set(resourceKey, currentStatus);
            }
          }
        } catch (err) {
          log(`Cluster "${name}" was terminated, stop watching.`);
          clearInterval(interval);
          statefulSetWatchAborted.set(resourceKey, true);
          statefulSetWatchRequests.delete(resourceKey);
          statefulSetWatchAborted.delete(resourceKey);
          statefulSetLastReadinessStatus.delete(resourceKey);
        }
      },
      5000,
      apiObj
    );
  }
};
