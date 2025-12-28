import { k8sCustomApi } from './k8s-client.js';
import { applyQueue, clusterCache, collectionCache } from './state.js';
import {
  initializeLeaderElection,
  acquireLeaderLock,
  isLeader,
  lock
} from './leader-election.js';
import { watchResource, abortAllWatches } from './watch.js';
import { scheduleReconcile } from './reconciliation.js';
import {
  clustersManaged,
  collectionsManaged,
  errorsTotal,
  reconcileQueueDepth,
  startMetricsServer
} from './metrics.js';
import { log } from './utils.js';

// Set debug mode, false by default
const debugMode = process.env.DEBUG_MODE || 'false';

// Print all errors
if (debugMode == 'true') {
  log('Debug mode ON!');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  });
}

// Got SIGTERM - stop locking and exit
process.on('SIGTERM', async () => {
  if (lock) {
    await lock.stopLocking();
  }
  log('Stopping gracefully...');
  abortAllWatches();
  // Small delay to allow graceful shutdown
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
});

const main = async () => {
  // Validate required environment variables
  if (!process.env.POD_NAMESPACE) {
    log('❌ ERROR: POD_NAMESPACE environment variable is not set!');
    log('   The operator requires POD_NAMESPACE to be set via downward API.');
    process.exit(1);
  }
  if (!process.env.POD_NAME) {
    log('❌ ERROR: POD_NAME environment variable is not set!');
    log('   The operator requires POD_NAME to be set via downward API.');
    process.exit(1);
  }

  // Initialize leader election
  await initializeLeaderElection();

  // Acquire leader lock
  // Note: acquireLeaderLock() with waitUntilLock: true handles retries internally
  // K8SLock will block until lock is acquired or throw on fatal errors
  // We don't need a retry loop here - K8SLock handles it
  try {
    await acquireLeaderLock();
  } catch (err) {
    // If acquireLeaderLock throws, it means K8SLock gave up after all retries
    // This is unusual and indicates a configuration/permission issue
    log(`❌ Fatal error acquiring leader lock: ${err.message}`);
    log('   This usually indicates a configuration or permission issue.');
    process.exit(1);
  }

  // Start metrics server
  const metricsPort = process.env.METRICS_PORT || 8080;
  startMetricsServer(metricsPort);

  // Initialize queue depth metric
  reconcileQueueDepth.set(0);

  // Update state metrics and perform periodic reconciliation (drift detection)
  setInterval(async () => {
    try {
      // Update queue depth metric
      reconcileQueueDepth.set(applyQueue.size);

      // Count managed clusters and reconcile if needed
      const clusterList = await k8sCustomApi.listNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: '',
        plural: 'qdrantclusters'
      });
      const clusters = clusterList.items;
      clustersManaged.set(clusters.length);

      // Periodic reconciliation: reconcile all clusters to detect drift
      // This ensures state converges even if events were missed
      for (const cluster of clusters) {
        const resourceKey = `${cluster.metadata.namespace}/${cluster.metadata.name}`;
        // Skip if deletion is in progress
        if (cluster.metadata.deletionTimestamp) {
          continue;
        }
        // Update cache
        clusterCache.set(resourceKey, cluster);
        // Reconcile (will only apply if drift detected)
        scheduleReconcile(cluster, 'cluster');
      }

      // Count managed collections
      const collectionList = await k8sCustomApi.listNamespacedCustomObject({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: '',
        plural: 'qdrantcollections'
      });
      const collections = collectionList.items;
      collectionsManaged.set(collections.length);

      // Periodic reconciliation for collections
      log(
        `🔄 Periodic reconciliation: Found ${collections.length} collection(s) to reconcile...`
      );
      for (const collection of collections) {
        const resourceKey = `${collection.metadata.namespace}/${collection.metadata.name}`;
        // Skip if deletion is in progress
        if (collection.metadata.deletionTimestamp) {
          continue;
        }
        // Update cache
        const wasInCache = collectionCache.has(resourceKey);
        collectionCache.set(resourceKey, collection);
        // Reconcile - always schedule, even if in cache (ensures eventual consistency)
        if (!wasInCache) {
          log(
            `🔍 Found collection "${collection.metadata.name}" not in cache during periodic reconciliation, scheduling...`
          );
        }
        scheduleReconcile(collection, 'collection');
      }
    } catch (err) {
      log(`Error in periodic reconciliation: ${err.message}`);
      errorsTotal.inc({ type: 'periodic_reconcile' });
    }
  }, 30000); // Reconcile every 30 seconds (reduced from 5 minutes for faster recovery)

  // Start watching events only after taking ownership of the lease
  await watchResource();

  // CRITICAL: Only start isLeader() check AFTER we're leader and watches are running
  // Follower doesn't need to check leadership - the lock already handles that
  setInterval(() => isLeader(), 10000);
};

main();
