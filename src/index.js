import * as k8s from '@kubernetes/client-node';
import { K8SLock } from '@nullplatform/k8s-lease-lock';
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
  deleteCollection,
  applyJobs
} from './collection-ops.js';

// Kubernetes Leases for leader election (initialized in main() after env validation)
let lock = null;

// set debug mode, false by default
const debugMode = process.env.DEBUG_MODE || 'false';
// global variables
var applyingScheduled = false;
var settingStatus = new Map();
var lastClusterResourceVersion = '';
var lastCollectionResourceVersion = '';
var clusterWatch = '';
var collectionWatch = '';
var clusterWatchStart = true;
var collectionWatchStart = true;

// Rate limiting and exponential backoff
var reconnectAttempts = {
  cluster: 0,
  collection: 0
};
const MAX_RECONNECT_DELAY = 60000; // 60 segundos máximo
const INITIAL_RECONNECT_DELAY = 2000; // Começar com 2 segundos

// Calculate exponential backoff delay
const getReconnectDelay = (attempts) => {
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(2, attempts),
    MAX_RECONNECT_DELAY
  );
  // Add jitter to avoid thundering herd
  const jitter = Math.random() * 1000;
  return delay + jitter;
};
// load KubeConfig
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

// initialize various K8S APIs
const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
const k8sPolicyApi = kc.makeApiClient(k8s.PolicyV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
const k8sCoordinationApi = kc.makeApiClient(k8s.CoordinationV1Api);
const watch = new k8s.Watch(kc);

// react on QdrantClusters events
const onEventCluster = async (phase, apiObj) => {
  // ignore MODIFIED on status changes
  if (settingStatus.has(apiObj.metadata.name)) {
    return;
  }
  // ignore duplicated event on watch reconnections
  if (lastClusterResourceVersion == apiObj.metadata.resourceVersion) {
    return;
  }
  // update ResourceVersion for the last caught cluster
  lastClusterResourceVersion = apiObj.metadata.resourceVersion;
  log(`Received event in phase ${phase}.`);
  // start applyting cluster changes
  if (['ADDED', 'MODIFIED'].includes(phase)) {
    try {
      scheduleApplying(apiObj);
    } catch (err) {
      log(err);
    }
    // will be cleaned automatically by ownerReferences
  } else if (phase == 'DELETED') {
    log(`${apiObj.kind} "${apiObj.metadata.name}" was deleted!`);
  }
};

// react on QdrantCollections events
const onEventCollection = async (phase, apiObj) => {
  // ignore duplicated event on watch reconnections
  if (lastCollectionResourceVersion == apiObj.metadata.resourceVersion) {
    return;
  }
  // update ResourceVersion for the last caught collection
  lastCollectionResourceVersion = apiObj.metadata.resourceVersion;
  log(`Received event in phase ${phase}.`);
  // wait for collection creation
  if (phase == 'ADDED') {
    await createCollection(apiObj, k8sCustomApi, k8sCoreApi);
    await applyJobs(apiObj, k8sCustomApi, k8sBatchApi);
    // wait for collection update
  } else if (phase == 'MODIFIED') {
    await updateCollection(apiObj, k8sCustomApi, k8sCoreApi);
    await applyJobs(apiObj, k8sCustomApi, k8sBatchApi);
    // wait for collection delete
  } else if (phase == 'DELETED') {
    await deleteCollection(apiObj, k8sCustomApi, k8sCoreApi);
  }
};

// QdrantClusters watch has stopped unexpectedly, restart
const onDoneCluster = (err) => {
  if (err) {
    const errorMsg = err.message || String(err);
    log(`Connection to QdrantClusters closed with error: ${errorMsg}`);

    // Special handling for rate limiting errors
    if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
      reconnectAttempts.cluster = Math.min(reconnectAttempts.cluster + 1, 10);
      const delay = getReconnectDelay(reconnectAttempts.cluster);
      log(
        `Rate limited. Waiting ${Math.round(delay / 1000)}s before reconnecting...`
      );
      clusterWatchStart = true;
      setTimeout(() => {
        watchResource();
      }, delay);
      return;
    }
    // For other errors, use smaller backoff
    reconnectAttempts.cluster = Math.min(reconnectAttempts.cluster + 1, 5);
  } else {
    // Normal closure, reset attempts
    reconnectAttempts.cluster = 0;
    log(`Connection to QdrantClusters closed, reconnecting...`);
  }

  clusterWatchStart = true;
  const delay = getReconnectDelay(reconnectAttempts.cluster);
  setTimeout(() => {
    watchResource();
  }, delay);
};

// QdrantCollections watch has stopped unexpectedly, restart
const onDoneCollection = (err) => {
  if (err) {
    const errorMsg = err.message || String(err);
    log(`Connection to QdrantCollections closed with error: ${errorMsg}`);

    // Special handling for rate limiting errors
    if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
      reconnectAttempts.collection = Math.min(
        reconnectAttempts.collection + 1,
        10
      );
      const delay = getReconnectDelay(reconnectAttempts.collection);
      log(
        `Rate limited. Waiting ${Math.round(delay / 1000)}s before reconnecting...`
      );
      collectionWatchStart = true;
      setTimeout(() => {
        watchResource();
      }, delay);
      return;
    }
    // For other errors, use smaller backoff
    reconnectAttempts.collection = Math.min(
      reconnectAttempts.collection + 1,
      5
    );
  } else {
    // Normal closure, reset attempts
    reconnectAttempts.collection = 0;
    log(`Connection to QdrantCollections closed, reconnecting...`);
  }

  collectionWatchStart = true;
  const delay = getReconnectDelay(reconnectAttempts.collection);
  setTimeout(() => {
    watchResource();
  }, delay);
};

const watchResource = async () => {
  // Check if we're still the leader before starting watch
  try {
    const namespace = process.env.POD_NAMESPACE;
    if (!namespace) {
      log('❌ ERROR: POD_NAMESPACE not set, cannot start watch');
      return;
    }
    const res = await k8sCoordinationApi.readNamespacedLease(
      'qdrant-operator',
      namespace
    );
    if (res.body.spec.holderIdentity !== process.env.POD_NAME) {
      log('Not the leader anymore, stopping watch...');
      return;
    }
  } catch (err) {
    log(`Error checking leader status: ${err.message}`);
    return;
  }

  //restart required watches
  var watchList = [];
  if (clusterWatchStart) {
    watchList.push(
      watch.watch(
        '/apis/qdrant.operator/v1alpha1/qdrantclusters',
        {},
        onEventCluster,
        onDoneCluster
      )
    );
    log('Watching QdrantClusters API.');
    clusterWatchStart = false;
    reconnectAttempts.cluster = 0; // Reset on successful start
  }
  if (collectionWatchStart) {
    watchList.push(
      watch.watch(
        '/apis/qdrant.operator/v1alpha1/qdrantcollections',
        {},
        onEventCollection,
        onDoneCollection
      )
    );
    log('Watching QdrantCollections API.');
    collectionWatchStart = false;
    reconnectAttempts.collection = 0; // Reset on successful start
  }
  // return the first caught event from any watch
  return Promise.any(watchList);
};

// set the customresource status, clusters only at the moment
const setStatus = async (apiObj, k8sCustomApi, status) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  // add cluster name to the map of currently updating resources
  settingStatus.set(name, 'update');
  // get current status
  const readObj = await k8sCustomApi.getNamespacedCustomObjectStatus(
    'qdrant.operator',
    'v1alpha1',
    namespace,
    'qdrantclusters',
    name
  );
  const resCurrent = readObj.body;
  // prepare new payload
  const newStatus = {
    apiVersion: apiObj.apiVersion,
    kind: apiObj.kind,
    metadata: {
      name: apiObj.metadata.name,
      resourceVersion: resCurrent.metadata.resourceVersion
    },
    status: {
      qdrantStatus: status
    }
  };
  try {
    // set new status
    const res = await k8sCustomApi.replaceNamespacedCustomObjectStatus(
      'qdrant.operator',
      'v1alpha1',
      namespace,
      'qdrantclusters',
      name,
      newStatus
    );
    log(`The cluster "${name}" status now is ${status}.`);
  } catch (err) {
    log(err);
  }
  // job is done, remove this resource from the map
  setTimeout(() => settingStatus.delete(name), 300);
};

// update the version of last caught cluster
const updateResourceVersion = async (apiObj, k8sCustomApi) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const res = await k8sCustomApi.getNamespacedCustomObjectStatus(
    'qdrant.operator',
    'v1alpha1',
    namespace,
    'qdrantclusters',
    name
  );
  const resCurrent = res.body;
  lastClusterResourceVersion = resCurrent.metadata.resourceVersion;
};

// check the current leader
const isLeader = async () => {
  const namespace = process.env.POD_NAMESPACE;
  if (!namespace) {
    log('❌ ERROR: POD_NAMESPACE not set, cannot check leader status');
    return;
  }
  try {
    const res = await k8sCoordinationApi.readNamespacedLease(
      'qdrant-operator',
      namespace
    );
    // leader status was lost
    if (res.body.spec.holderIdentity !== process.env.POD_NAME) {
      log('Leader status was lost, restarting...');
      process.exit(1);
    }
  } catch (err) {
    log(err);
  }
};

// check the cluster readiness
const waitForClusterReadiness = (apiObj, k8sAppsApi, k8sCustomApi) => {
  // start background periodic job
  let interval = setInterval(
    async function (apiObj, k8sAppsApi, k8sCustomApi) {
      const name = apiObj.metadata.name;
      const namespace = apiObj.metadata.namespace;
      try {
        // get qdrant statefulset
        const res = await k8sAppsApi.readNamespacedStatefulSet(
          `${name}`,
          `${namespace}`
        );
        const stset = res.body;
        // wait until available and updated replicas >= desired replicas count
        if (
          stset.status.availableReplicas >= stset.spec.replicas &&
          stset.status.updatedReplicas >= stset.spec.replicas
        ) {
          log(`Cluster "${name}" is ready!`);
          // set resource status to Running
          await setStatus(apiObj, k8sCustomApi, 'Running');
          // memorize tis resourceversion
          await updateResourceVersion(apiObj, k8sCustomApi);
          // stop watching
          clearInterval(interval);
        } else {
          log(
            `Cluster "${name}" is not ready: ${stset.status.availableReplicas}/${stset.spec.replicas} are available.`
          );
        }
        return;
      } catch (err) {
        // can't read statefulset, probably it was killed
        log(`Cluster "${name}" was terminated, stop watching.`);
        // stop watching
        clearInterval(interval);
      }
    },
    5000,
    apiObj,
    k8sAppsApi,
    k8sCustomApi
  );
};

const scheduleApplying = (apiObj) => {
  if (!applyingScheduled) {
    setTimeout(applyNow, 1000, apiObj);
    applyingScheduled = true;
  }
};

// create all required k8s resources
const applyNow = async (apiObj) => {
  applyingScheduled = false;
  await setStatus(apiObj, k8sCustomApi, 'Pending');
  await applyConfigmapCluster(apiObj, k8sCoreApi);
  const readApikey = await applyReadSecretCluster(apiObj, k8sCoreApi);
  const apikey = await applySecretCluster(apiObj, k8sCoreApi);
  await applyAuthSecretCluster(apiObj, k8sCoreApi, apikey, readApikey);
  await applyServiceHeadlessCluster(apiObj, k8sCoreApi);
  await applyServiceCluster(apiObj, k8sCoreApi);
  await applyPdbCluster(apiObj, k8sPolicyApi);
  await applyCluster(apiObj, k8sAppsApi, k8sCoreApi);
  await updateResourceVersion(apiObj, k8sCustomApi);
  waitForClusterReadiness(apiObj, k8sAppsApi, k8sCustomApi);
};

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
    log(`Attempting to acquire leader lock in namespace: ${process.env.POD_NAMESPACE}`);
    // Small delay to ensure namespace is fully available
    await new Promise(resolve => setTimeout(resolve, 1000));
    await lock.startLocking();
  } catch (err) {
    const errorMsg = err.message || String(err);
    const errorBody = err.body || '';
    log(`❌ Failed to acquire leader lock: ${errorMsg}`);
    if (errorBody) {
      try {
        const errorJson = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
        log(`   Error details: ${JSON.stringify(errorJson)}`);
      } catch (e) {
        log(`   Error body: ${errorBody}`);
      }
    }
    log(`   POD_NAMESPACE: ${process.env.POD_NAMESPACE || 'UNDEFINED'}`);
    log(`   POD_NAME: ${process.env.POD_NAME || 'UNDEFINED'}`);
    log(`   This is a fatal error. The operator cannot continue without leader election.`);
    process.exit(1);
  }

  // Clear the follower logging interval once we become leader
  clearInterval(followerLogInterval);

  log(`Status of "${process.env.POD_NAME}": LEADER.`);
  log(`✅ Successfully acquired leader lock. Starting operator services...`);
  // start checking lease ownership in background
  setInterval(() => isLeader(), 10000);
  // start watching events only after taking ownership of the lease
  await watchResource();
};

// log format
export const log = (message) => {
  console.log(`${new Date().toLocaleString()}: ${message}`);
};

// print all errors
if (debugMode == 'true') {
  log('Debug mode ON!');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  });
}

// got SIGTERM - stop locking and exit
process.on('SIGTERM', async () => {
  if (lock) {
    await lock.stopLocking();
  }
  log('Stopping gracefully...');
  process.exit(0);
});

main();
