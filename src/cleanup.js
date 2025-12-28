import { k8sAppsApi, k8sCoreApi, k8sCustomApi } from './k8s-client.js';
import {
  statefulSetWatchRequests,
  statefulSetWatchAborted,
  statefulSetLastReadinessStatus
} from './state.js';
import { setCleanupStatus } from './status.js';
import { deleteCollection } from './collection-ops.js';
import { errorsTotal } from './metrics.js';
import { log } from './utils.js';

const MAX_CLEANUP_ATTEMPTS = 5;
const FORCE_DELETE_AFTER_ATTEMPTS = 10; // Total attempts before force delete (escape hatch)
const MAX_CLEANUP_TIMEOUT_CLUSTER = 300000; // 5 minutes
const MAX_CLEANUP_TIMEOUT_COLLECTION = 120000; // 2 minutes
const INITIAL_BACKOFF = 2000; // 2 seconds

// Cleanup cluster resources before deletion with retry and backoff
export const cleanupCluster = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;

  const startTime = Date.now();
  let attempt = 1;

  // Get current cleanup attempt from status if exists
  try {
    const statusRes = await k8sCustomApi.getNamespacedCustomObjectStatus({
      group: 'qdrant.operator',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'qdrantclusters',
      name: name
    });
    const currentAttempt = statusRes.status?.cleanupAttempts || 0;
    attempt = currentAttempt + 1;
  } catch (err) {
    // Ignore errors reading status
  }

  while (attempt <= MAX_CLEANUP_ATTEMPTS) {
    // Check timeout
    if (Date.now() - startTime > MAX_CLEANUP_TIMEOUT_CLUSTER) {
      const errorMsg = `Cleanup timeout after ${MAX_CLEANUP_TIMEOUT_CLUSTER}ms`;
      log(`❌ ${errorMsg} for cluster "${name}"`);
      await setCleanupStatus(apiObj, 'Failed', attempt, errorMsg);
      errorsTotal.inc({ type: 'cleanup_timeout' });
      throw new Error(errorMsg);
    }

    log(
      `Starting cleanup attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS} for cluster "${name}"...`
    );
    await setCleanupStatus(apiObj, 'Retrying', attempt);

    try {
      // Stop StatefulSet watch if active
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

      // Scale down StatefulSet to 0 replicas gracefully (idempotent)
      try {
        const stsRes = await k8sAppsApi.readNamespacedStatefulSet({
          name: name,
          namespace: namespace
        });
        const sts = stsRes;
        if (sts.spec.replicas > 0) {
          log(`Scaling down StatefulSet "${name}" to 0 replicas...`);
          const patch = [
            {
              op: 'replace',
              path: '/spec/replicas',
              value: 0
            }
          ];
          await k8sAppsApi.patchNamespacedStatefulSet(
            {
              name: name,
              namespace: namespace,
              body: patch
            },
            {
              headers: { 'Content-Type': 'application/json-patch+json' }
            }
          );
          // Wait a bit for graceful shutdown
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } else {
          log(
            `StatefulSet "${name}" already scaled to 0 replicas (idempotent cleanup)`
          );
        }
      } catch (err) {
        // StatefulSet not found is acceptable - cleanup is idempotent
        if (err.message.includes('not found') || err.code === 404) {
          log(
            `StatefulSet "${name}" not found - already deleted (idempotent cleanup)`
          );
          // Continue with cleanup - this is expected if StatefulSet was already deleted
        } else {
          log(`Error scaling down StatefulSet "${name}": ${err.message}`);
          throw err; // Re-throw to trigger retry
        }
      }

      // Additional cleanup can be added here:
      // - Delete external resources (S3 snapshots, etc.)
      // - Revoke API keys
      // - Clean up external services

      log(`✅ Cleanup completed for cluster "${name}"`);
      await setCleanupStatus(apiObj, 'Completed', attempt);
      return; // Success
    } catch (err) {
      const errorMsg = err.message || String(err);
      log(
        `⚠️ Cleanup attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS} failed for cluster "${name}": ${errorMsg}`
      );
      errorsTotal.inc({ type: 'cleanup' });

      if (attempt < MAX_CLEANUP_ATTEMPTS) {
        // Calculate exponential backoff with jitter
        const backoff = Math.min(
          INITIAL_BACKOFF * Math.pow(2, attempt - 1),
          30000 // Max 30 seconds
        );
        const jitter = Math.random() * 1000;
        const delay = backoff + jitter;

        log(
          `Retrying cleanup for "${name}" in ${Math.round(delay / 1000)}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      } else {
        // Regular attempts exhausted - try a few more times before force delete
        if (attempt < FORCE_DELETE_AFTER_ATTEMPTS) {
          // Calculate exponential backoff with jitter
          const backoff = Math.min(
            INITIAL_BACKOFF * Math.pow(2, attempt - 1),
            30000 // Max 30 seconds
          );
          const jitter = Math.random() * 1000;
          const delay = backoff + jitter;

          log(
            `Retrying cleanup for "${name}" (extended attempts: ${attempt}/${FORCE_DELETE_AFTER_ATTEMPTS}) in ${Math.round(delay / 1000)}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
        } else {
          // All attempts exhausted including extended attempts - force delete (escape hatch)
          const finalError = `Cleanup failed after ${FORCE_DELETE_AFTER_ATTEMPTS} attempts: ${errorMsg}. Finalizer will be removed to allow deletion.`;
          log(`❌ ${finalError}`);
          log(
            `⚠️ FORCE DELETE: Removing finalizer for cluster "${name}" after ${FORCE_DELETE_AFTER_ATTEMPTS} failed cleanup attempts. Resource may not be fully cleaned up.`
          );
          await setCleanupStatus(apiObj, 'Failed', attempt, finalError);
          // Don't throw - let caller handle finalizer removal
          return; // Return to allow finalizer removal in events.js
        }
      }
    }
  }
};

// Cleanup collection resources before deletion with retry and backoff
export const cleanupCollection = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;

  const startTime = Date.now();
  let attempt = 1;

  while (attempt <= MAX_CLEANUP_ATTEMPTS) {
    // Check timeout
    if (Date.now() - startTime > MAX_CLEANUP_TIMEOUT_COLLECTION) {
      const errorMsg = `Cleanup timeout after ${MAX_CLEANUP_TIMEOUT_COLLECTION}ms`;
      log(`❌ ${errorMsg} for collection "${name}"`);
      errorsTotal.inc({ type: 'cleanup_timeout' });
      throw new Error(errorMsg);
    }

    log(
      `Starting cleanup attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS} for collection "${name}"...`
    );

    try {
      // Delete the collection from Qdrant
      await deleteCollection(apiObj, k8sCustomApi, k8sCoreApi);

      // Additional cleanup can be added here:
      // - Delete backup jobs
      // - Clean up external resources

      log(`✅ Cleanup completed for collection "${name}"`);
      return; // Success
    } catch (err) {
      const errorMsg = err.message || String(err);
      log(
        `⚠️ Cleanup attempt ${attempt}/${MAX_CLEANUP_ATTEMPTS} failed for collection "${name}": ${errorMsg}`
      );
      errorsTotal.inc({ type: 'cleanup' });

      if (attempt < MAX_CLEANUP_ATTEMPTS) {
        // Calculate exponential backoff with jitter
        const backoff = Math.min(
          INITIAL_BACKOFF * Math.pow(2, attempt - 1),
          30000 // Max 30 seconds
        );
        const jitter = Math.random() * 1000;
        const delay = backoff + jitter;

        log(
          `Retrying cleanup for collection "${name}" in ${Math.round(delay / 1000)}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      } else {
        // Regular attempts exhausted - try a few more times before force delete
        if (attempt < FORCE_DELETE_AFTER_ATTEMPTS) {
          // Calculate exponential backoff with jitter
          const backoff = Math.min(
            INITIAL_BACKOFF * Math.pow(2, attempt - 1),
            30000 // Max 30 seconds
          );
          const jitter = Math.random() * 1000;
          const delay = backoff + jitter;

          log(
            `Retrying cleanup for collection "${name}" (extended attempts: ${attempt}/${FORCE_DELETE_AFTER_ATTEMPTS}) in ${Math.round(delay / 1000)}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt++;
        } else {
          // All attempts exhausted including extended attempts - force delete (escape hatch)
          const finalError = `Cleanup failed after ${FORCE_DELETE_AFTER_ATTEMPTS} attempts: ${errorMsg}. Finalizer will be removed to allow deletion.`;
          log(`❌ ${finalError}`);
          log(
            `⚠️ FORCE DELETE: Removing finalizer for collection "${name}" after ${FORCE_DELETE_AFTER_ATTEMPTS} failed cleanup attempts. Resource may not be fully cleaned up.`
          );
          // Don't throw - let caller handle finalizer removal
          return; // Return to allow finalizer removal in events.js
        }
      }
    }
  }
};
