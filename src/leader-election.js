import { K8SLock } from '@nullplatform/k8s-lease-lock';
import { k8sCoordinationApi } from './k8s-client.js';
import { leaderElection } from './metrics.js';
import { abortAllWatches } from './watch.js';
import { shuttingDown, activeReconciles } from './state.js';
import { log } from './utils.js';

// Kubernetes Leases for leader election (initialized in main() after env validation)
export let lock = null;

// Ensure lease exists before K8SLock tries to use it
// This is a workaround for K8SLock not creating the lease even with createLeaseIfNotExist: true
export const ensureLeaseExists = async () => {
  const namespace = process.env.POD_NAMESPACE;
  if (!namespace) {
    log('⚠️ POD_NAMESPACE not set, cannot ensure lease exists');
    return;
  }
  try {
    // Try to read the lease
    await k8sCoordinationApi.readNamespacedLease('qdrant-operator', namespace);
    log('✅ Lease already exists');
  } catch (err) {
    // If lease doesn't exist (404), create it
    if (
      err.code === 404 ||
      (err.message && err.message.includes('not found'))
    ) {
      try {
        const lease = {
          metadata: {
            name: 'qdrant-operator',
            namespace: namespace
          },
          spec: {
            holderIdentity: '',
            leaseDurationSeconds: 30,
            acquireTime: new Date().toISOString(),
            renewTime: new Date().toISOString()
          }
        };
        await k8sCoordinationApi.createNamespacedLease(namespace, lease);
        log('✅ Created lease for leader election');
      } catch (createErr) {
        const createErrorMsg = createErr.message || String(createErr);
        // If lease was created by another pod between our check and create, that's fine
        if (createErrorMsg.includes('already exists')) {
          log(
            '✅ Lease was created by another pod (expected in multi-replica setup)'
          );
        } else {
          log(`⚠️ Failed to create lease: ${createErrorMsg}`);
          // Continue anyway, K8SLock should handle it
        }
      }
    } else {
      log(`⚠️ Unexpected error checking lease: ${err.message || String(err)}`);
    }
  }
};

// Check the current leader
export const isLeader = async () => {
  const namespace = process.env.POD_NAMESPACE;
  if (!namespace) {
    log('❌ ERROR: POD_NAMESPACE not set, cannot check leader status');
    leaderElection.set(0);
    return;
  }
  try {
    const res = await k8sCoordinationApi.readNamespacedLease(
      'qdrant-operator',
      namespace
    );
    // leader status was lost
    if (res.body.spec.holderIdentity !== process.env.POD_NAME) {
      log('Leader status was lost, initiating graceful shutdown...');
      leaderElection.set(0);

      // Mark as shutting down to prevent new reconciles
      shuttingDown.value = true;

      // Abort watches immediately
      abortAllWatches();

      // Wait for active reconciles to complete (with timeout)
      const GRACEFUL_SHUTDOWN_TIMEOUT = 30000; // 30 seconds
      const startTime = Date.now();

      while (activeReconciles.size > 0) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= GRACEFUL_SHUTDOWN_TIMEOUT) {
          log(
            `⚠️ Graceful shutdown timeout (${GRACEFUL_SHUTDOWN_TIMEOUT}ms), ${activeReconciles.size} reconciles still active. Exiting...`
          );
          break;
        }

        const activeList = Array.from(activeReconciles);
        log(
          `Waiting for ${activeReconciles.size} active reconcile(s) to complete: ${activeList.join(', ')} (${Math.round(elapsed / 1000)}s/${GRACEFUL_SHUTDOWN_TIMEOUT / 1000}s)`
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (activeReconciles.size === 0) {
        log('✅ All active reconciles completed, exiting gracefully');
      }

      process.exit(1);
    } else {
      leaderElection.set(1);
    }
  } catch (err) {
    log(err);
    leaderElection.set(0);
  }
};

// Initialize leader election lock
export const initializeLeaderElection = async () => {
  // Ensure lease exists before initializing K8SLock
  // This is a workaround: K8SLock with createLeaseIfNotExist: true doesn't always work
  await ensureLeaseExists();

  // Initialize Kubernetes Leases for leader election (after env validation)
  lock = new K8SLock({
    leaseName: 'qdrant-operator',
    namespace: process.env.POD_NAMESPACE,
    lockLeaserId: process.env.POD_NAME,
    waitUntilLock: true,
    createLeaseIfNotExist: true,
    leaseDurationInSeconds: 30,
    refreshLockInterval: 5000,
    lockTryInterval: 5000
  });

  return lock;
};

// Acquire leader lock
export const acquireLeaderLock = async () => {
  // leader election using k8s leases
  log(
    `Status of "${process.env.POD_NAME}": FOLLOWER. Trying to get leader status...`
  );
  log(`   Namespace: ${process.env.POD_NAMESPACE}`);

  // Start periodic logging for followers while waiting
  let followerLogInterval = setInterval(async () => {
    try {
      const namespace = process.env.POD_NAMESPACE;
      if (!namespace) {
        log(
          `Status of "${process.env.POD_NAME}": FOLLOWER. POD_NAMESPACE not set, cannot check leader status.`
        );
        return;
      }
      const res = await k8sCoordinationApi.readNamespacedLease(
        'qdrant-operator',
        namespace
      );
      const currentLeader = res.body.spec.holderIdentity;
      if (currentLeader && currentLeader !== process.env.POD_NAME) {
        log(
          `Status of "${process.env.POD_NAME}": FOLLOWER. Current leader is "${currentLeader}". Waiting...`
        );
      } else {
        log(
          `Status of "${process.env.POD_NAME}": FOLLOWER. No leader detected. Trying to acquire lock...`
        );
      }
    } catch (err) {
      const errorMsg = err.message || String(err);
      // Don't log 404 errors as they're expected when lease doesn't exist yet
      if (!errorMsg.includes('404') && !errorMsg.includes('not found')) {
        log(
          `Status of "${process.env.POD_NAME}": FOLLOWER. Checking leader status... (error: ${errorMsg})`
        );
      }
    }
  }, 10000); // Log every 10 seconds

  try {
    log(
      `Attempting to acquire leader lock in namespace: ${process.env.POD_NAMESPACE}`
    );
    // Small delay to ensure namespace is fully available
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await lock.startLocking();
  } catch (err) {
    const errorMsg = err.message || String(err);
    const errorBody = err.body || '';
    log(`❌ Failed to acquire leader lock: ${errorMsg}`);
    if (errorBody) {
      try {
        const errorJson =
          typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
        log(`   Error details: ${JSON.stringify(errorJson)}`);
      } catch (e) {
        log(`   Error body: ${errorBody}`);
      }
    }
    log(`   POD_NAMESPACE: ${process.env.POD_NAMESPACE || 'UNDEFINED'}`);
    log(`   POD_NAME: ${process.env.POD_NAME || 'UNDEFINED'}`);
    log(
      `   This is a fatal error. The operator cannot continue without leader election.`
    );
    process.exit(1);
  }

  // Clear the follower logging interval once we become leader
  clearInterval(followerLogInterval);

  log(`Status of "${process.env.POD_NAME}": LEADER.`);
  log(`✅ Successfully acquired leader lock. Starting operator services...`);

  // Update leader metric
  leaderElection.set(1);
};
