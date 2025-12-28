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

  // Acquire leader lock (with retry for transient startup errors)
  let lockAcquired = false;
  const maxLockAttempts = 5;
  for (let attempt = 1; attempt <= maxLockAttempts; attempt++) {
    try {
      await acquireLeaderLock();
      lockAcquired = true;
      break;
    } catch (err) {
      if (attempt < maxLockAttempts) {
        log(
          `⚠️ Failed to acquire leader lock (attempt ${attempt}/${maxLockAttempts}), retrying in 3s...`
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      } else {
        log(
          `❌ Failed to acquire leader lock after ${maxLockAttempts} attempts. This may indicate a configuration issue.`
        );
        throw err; // Re-throw on final attempt
      }
    }
  }

  if (!lockAcquired) {
    log('❌ Could not acquire leader lock. Exiting.');
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
      const clusterList = await k8sCustomApi.listNamespacedCustomObject(
        'qdrant.operator',
        'v1alpha1',
        '',
        'qdrantclusters'
      );
      const clusters = clusterList.body.items;
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
      const collectionList = await k8sCustomApi.listNamespacedCustomObject(
        'qdrant.operator',
        'v1alpha1',
        '',
        'qdrantcollections'
      );
      const collections = collectionList.body.items;
      collectionsManaged.set(collections.length);

      // Periodic reconciliation for collections
      for (const collection of collections) {
        const resourceKey = `${collection.metadata.namespace}/${collection.metadata.name}`;
        // Skip if deletion is in progress
        if (collection.metadata.deletionTimestamp) {
          continue;
        }
        // Update cache
        collectionCache.set(resourceKey, collection);
        // Reconcile
        scheduleReconcile(collection, 'collection');
      }
    } catch (err) {
      log(`Error in periodic reconciliation: ${err.message}`);
      errorsTotal.inc({ type: 'periodic_reconcile' });
    }
  }, 300000); // Reconcile every 5 minutes (drift detection)

  // Start checking lease ownership in background
  setInterval(() => isLeader(), 10000);
  // Start watching events only after taking ownership of the lease
  await watchResource();
};

main();
