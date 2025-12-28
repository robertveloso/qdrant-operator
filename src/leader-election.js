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
  const leaseName = 'qdrant-operator';

  // CRITICAL: Validate parameters before API call to prevent client-side errors
  if (!namespace || !leaseName || namespace === '' || leaseName === '') {
    log('⚠️ POD_NAMESPACE or leaseName not set, cannot ensure lease exists');
    return;
  }

  try {
    // Try to read the lease
    await k8sCoordinationApi.readNamespacedLease(leaseName, namespace);
    log('✅ Lease already exists');
    return;
  } catch (err) {
    const errorMsg = err.message || String(err);
    const errorBody = err.body || '';

    // Parse error body safely (never parse undefined/null)
    let parsedBody = null;
    if (typeof errorBody === 'string' && errorBody) {
      try {
        parsedBody = JSON.parse(errorBody);
      } catch (e) {
        // Ignore parse errors
      }
    } else if (errorBody) {
      parsedBody = errorBody;
    }

    // Get error code safely
    const errorCode = err.code || err.statusCode || parsedBody?.code;

    const isNotFound =
      errorCode === 404 ||
      (parsedBody && parsedBody.code === 404) ||
      errorMsg.includes('not found') ||
      errorMsg.includes('NotFound');

    if (isNotFound) {
      // Lease doesn't exist - create it
      log(`Lease "${leaseName}" not found, creating...`);
      try {
        const lease = {
          apiVersion: 'coordination.k8s.io/v1',
          kind: 'Lease',
          metadata: {
            name: leaseName,
            namespace: namespace
          },
          spec: {
            holderIdentity: '',
            leaseDurationSeconds: 30,
            acquireTime: null,
            renewTime: null
          }
        };
        await k8sCoordinationApi.createNamespacedLease(namespace, lease);
        log('✅ Created lease for leader election');

        // CRITICAL: Wait until lease is readable (Kubernetes eventual consistency)
        // createNamespacedLease returns before the object is readable
        log('Waiting for lease to be readable...');
        for (let i = 0; i < 10; i++) {
          try {
            await k8sCoordinationApi.readNamespacedLease(leaseName, namespace);
            log('✅ Lease is now readable');
            break;
          } catch (readErr) {
            const readErrorCode = readErr.code || readErr.statusCode;
            if (readErrorCode === 404) {
              // Still not readable, wait and retry
              await new Promise((resolve) => setTimeout(resolve, 300));
              continue;
            }
            // Other error, throw it
            throw readErr;
          }
        }
      } catch (createErr) {
        const createErrorMsg = createErr.message || String(createErr);
        const createErrorCode = createErr.code || createErr.statusCode;
        const createErrorBody = createErr.body || '';

        // Parse create error body
        let createParsedBody = null;
        if (typeof createErrorBody === 'string' && createErrorBody) {
          try {
            createParsedBody = JSON.parse(createErrorBody);
          } catch (e) {
            // Ignore parse errors
          }
        } else if (createErrorBody) {
          createParsedBody = createErrorBody;
        }

        // If lease was created by another pod between our check and create, that's fine
        if (
          createErrorCode === 409 ||
          (createParsedBody && createParsedBody.code === 409) ||
          createErrorMsg.includes('already exists') ||
          createErrorMsg.includes('AlreadyExists')
        ) {
          log(
            '✅ Lease was created by another pod (expected in multi-replica setup)'
          );
        } else {
          log(`⚠️ Failed to create lease: ${createErrorMsg}`);
          log(`   Error code: ${createErrorCode}`);
          if (createParsedBody) {
            log(`   Error details: ${JSON.stringify(createParsedBody)}`);
          }
          // Continue anyway, K8SLock should handle it
        }
      }
    } else {
      log(`⚠️ Unexpected error checking lease: ${errorMsg}`);
      log(`   Error code: ${errorCode}`);
      if (parsedBody) {
        log(`   Error details: ${JSON.stringify(parsedBody)}`);
      }
    }
  }
};

// Check the current leader
export const isLeader = async () => {
  const namespace = process.env.POD_NAMESPACE;
  const leaseName = 'qdrant-operator';

  // CRITICAL: Validate parameters before API call to prevent client-side errors
  if (!namespace || !leaseName || namespace === '' || leaseName === '') {
    leaderElection.set(0);
    return;
  }

  try {
    const res = await k8sCoordinationApi.readNamespacedLease(
      leaseName,
      namespace
    );

    // Get holder identity (can be empty string, undefined, or a pod name)
    const holder = res.body?.spec?.holderIdentity;

    // CRITICAL: Empty holderIdentity means "no leader elected yet" (startup)
    // NOT "leader lost". Only trigger shutdown if we were leader and lost it.
    if (!holder || holder === '') {
      log('No leader elected yet (startup phase)');
      leaderElection.set(0);
      return;
    }

    // If holder exists but is not us, check if we were previously leader
    // If we were leader and now we're not, that's a loss of leadership
    if (holder !== process.env.POD_NAME) {
      // Only shutdown if we were actually leader before
      // On startup, activeReconciles will be empty, so this won't trigger shutdown
      // The key indicator: if we have active reconciles, we were leader
      if (activeReconciles.size > 0) {
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

        process.exit(0); // Exit gracefully (0, not 1)
      } else {
        // We're not leader, but we never were (startup case)
        log(`Current leader is "${holder}", we are follower`);
        leaderElection.set(0);
      }
    } else {
      // We are the leader
      leaderElection.set(1);
    }
  } catch (err) {
    log(`Error checking leader status: ${err.message || String(err)}`);
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
      const leaseName = 'qdrant-operator';

      // CRITICAL: Validate parameters before API call to prevent client-side errors
      if (!namespace || !leaseName || namespace === '' || leaseName === '') {
        return; // Silently skip if params not ready
      }

      const res = await k8sCoordinationApi.readNamespacedLease(
        leaseName,
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
    // startLocking() with waitUntilLock: true will block until lock is acquired
    // or throw if there's a fatal error. Transient errors should be handled
    // by K8SLock's internal retry mechanism.
    await lock.startLocking();
  } catch (err) {
    const errorMsg = err.message || String(err);
    const errorBody = err.body || '';
    log(`⚠️ Failed to acquire leader lock: ${errorMsg}`);
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
    log(`   This may be a transient error. K8SLock should retry internally.`);
    log(
      `   If this persists, check lease permissions and API server connectivity.`
    );
    // Don't re-throw - K8SLock with waitUntilLock: true handles retries
    // Re-throwing would create competing retry loops
    // Let K8SLock handle retries internally
    return; // Return without throwing - let K8SLock retry
  }

  // Clear the follower logging interval once we become leader
  clearInterval(followerLogInterval);

  log(`Status of "${process.env.POD_NAME}": LEADER.`);
  log(`✅ Successfully acquired leader lock. Starting operator services...`);

  // Update leader metric
  leaderElection.set(1);
};
