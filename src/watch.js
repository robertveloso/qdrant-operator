import { k8sCoordinationApi, watch } from './k8s-client.js';
import {
  clusterWatchAborted,
  collectionWatchAborted,
  clusterWatchRequest,
  collectionWatchRequest,
  statefulSetWatchRequests,
  statefulSetWatchAborted,
  reconnectAttempts
} from './state.js';
import { watchRestarts, errorsTotal, watchActive } from './metrics.js';
import { log } from './utils.js';
import { onEventCluster, onEventCollection } from './events.js';

// Wrapper function to safely call readNamespacedLease with proper validation
const safeReadNamespacedLease = async (name, namespace) => {
  // Final validation before calling the API
  if (name == null || namespace == null) {
    throw new Error(`Invalid parameters: name=${name}, namespace=${namespace}`);
  }
  if (typeof name !== 'string' || typeof namespace !== 'string') {
    throw new Error(
      `Parameters must be strings: name=${typeof name}, namespace=${typeof namespace}`
    );
  }
  if (name === '' || namespace === '') {
    throw new Error(
      `Parameters cannot be empty: name="${name}", namespace="${namespace}"`
    );
  }

  // Ensure parameters are explicitly strings (defensive programming)
  const nameStr = String(name);
  const namespaceStr = String(namespace);

  // Final check after string conversion
  if (
    nameStr === '' ||
    namespaceStr === '' ||
    nameStr === 'null' ||
    nameStr === 'undefined' ||
    namespaceStr === 'null' ||
    namespaceStr === 'undefined'
  ) {
    throw new Error(
      `Parameters invalid after string conversion: name="${nameStr}", namespace="${namespaceStr}"`
    );
  }

  // Log parameters right before API call (only in debug mode)
  if (process.env.DEBUG_MODE === 'true') {
    log(
      `safeReadNamespacedLease: About to call API with name="${nameStr}", namespace="${namespaceStr}"`
    );
    log(
      `   typeof nameStr: ${typeof nameStr}, typeof namespaceStr: ${typeof namespaceStr}`
    );
    log(
      `   nameStr === null: ${nameStr === null}, nameStr === undefined: ${nameStr === undefined}`
    );
    log(
      `   namespaceStr === null: ${namespaceStr === null}, namespaceStr === undefined: ${namespaceStr === undefined}`
    );
  }

  // Call the API with validated and converted parameters
  // Try using object parameter format as the library may expect it
  try {
    // First try with object parameter format (for ObjectCoordinationV1Api)
    return await k8sCoordinationApi.readNamespacedLease({
      name: nameStr,
      namespace: namespaceStr
    });
  } catch (err) {
    // If that fails, try with positional arguments (for regular CoordinationV1Api)
    const errorMsg = err.message || String(err);
    const errorBody = err.body || '';

    // Check if it's a 404 error (lease not found - expected on first run)
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

    const errorCode = err.code || err.statusCode || parsedBody?.code;
    const isNotFound = errorCode === 404 ||
      (parsedBody && parsedBody.code === 404) ||
      errorMsg.includes('not found') ||
      errorMsg.includes('NotFound');

    if (
      errorMsg.includes('Required parameter') ||
      errorMsg.includes('was null or undefined')
    ) {
      // Log detailed error information if in debug mode
      if (process.env.DEBUG_MODE === 'true') {
        log(`Error with object format, trying positional: ${errorMsg}`);
      }
      // Fallback to positional arguments
      return await k8sCoordinationApi.readNamespacedLease({
        name: nameStr,
        namespace: namespaceStr
      });
    }

    // For 404 errors, don't log as error (expected when lease doesn't exist)
    if (isNotFound) {
      // Only log in debug mode, and as info not error
      if (process.env.DEBUG_MODE === 'true') {
        log(`Lease not found (404) - this is expected on first run`);
      }
      throw err; // Re-throw so caller can handle it
    }

    // Log detailed error information for other errors (only in debug mode)
    if (process.env.DEBUG_MODE === 'true') {
      log(`Error in safeReadNamespacedLease: ${errorMsg}`);
      log(
        `   Called with nameStr="${nameStr}", namespaceStr="${namespaceStr}"`
      );
      log(`   Error stack: ${err.stack || 'No stack trace'}`);
    }
    throw err;
  }
};

const MAX_RECONNECT_DELAY = 60000; // 60 segundos máximo
const INITIAL_RECONNECT_DELAY = 2000; // Começar com 2 segundos

// Calculate exponential backoff delay
export const getReconnectDelay = (attempts) => {
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(2, attempts),
    MAX_RECONNECT_DELAY
  );
  // Add jitter to avoid thundering herd
  const jitter = Math.random() * 1000;
  return delay + jitter;
};

// QdrantClusters watch has stopped unexpectedly, restart
export const onDoneCluster = (err) => {
  // Don't reconnect if watch was aborted intentionally
  if (clusterWatchAborted.value) {
    log('QdrantClusters watch was aborted, not reconnecting.');
    clusterWatchAborted.value = false;
    clusterWatchRequest.value = null;
    watchActive.set({ resource_type: 'cluster' }, 0);
    return;
  }

  if (err) {
    const errorMsg = err.message || String(err);
    log(`Connection to QdrantClusters closed with error: ${errorMsg}`);
    watchRestarts.inc({ resource_type: 'cluster', reason: 'error' });

    // Special handling for rate limiting errors
    if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
      reconnectAttempts.cluster = Math.min(reconnectAttempts.cluster + 1, 10);
      const delay = getReconnectDelay(reconnectAttempts.cluster);
      log(
        `Rate limited. Waiting ${Math.round(delay / 1000)}s before reconnecting...`
      );
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
    watchRestarts.inc({ resource_type: 'cluster', reason: 'normal' });
  }

  const delay = getReconnectDelay(reconnectAttempts.cluster);
  setTimeout(() => {
    watchResource();
  }, delay);
};

// QdrantCollections watch has stopped unexpectedly, restart
export const onDoneCollection = (err) => {
  // Don't reconnect if watch was aborted intentionally
  if (collectionWatchAborted.value) {
    log('QdrantCollections watch was aborted, not reconnecting.');
    collectionWatchAborted.value = false;
    collectionWatchRequest.value = null;
    watchActive.set({ resource_type: 'collection' }, 0);
    return;
  }

  watchActive.set({ resource_type: 'collection' }, 0);

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
      watchRestarts.inc({ resource_type: 'collection', reason: 'rate_limit' });
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
    watchRestarts.inc({ resource_type: 'collection', reason: 'error' });
    errorsTotal.inc({ type: 'watch' });
  } else {
    // Normal closure, reset attempts
    reconnectAttempts.collection = 0;
    log(`Connection to QdrantCollections closed, reconnecting...`);
    watchRestarts.inc({ resource_type: 'collection', reason: 'normal' });
  }

  const delay = getReconnectDelay(reconnectAttempts.collection);
  setTimeout(() => {
    watchResource();
  }, delay);
};

// Start watching Kubernetes resources
export const watchResource = async () => {
  // Check if we're still the leader before starting watch
  // Define variables outside try block so they're accessible in catch block
  const namespace = String(process.env.POD_NAMESPACE || '').trim();
  const leaseName = 'qdrant-operator';

  try {
    // CRITICAL: Validate parameters before API call to prevent client-side errors
    // Check for empty string, null, undefined, or whitespace-only
    if (!namespace || namespace === '') {
      log('❌ ERROR: POD_NAMESPACE not set, cannot start watch');
      log(`   POD_NAMESPACE env: ${JSON.stringify(process.env.POD_NAMESPACE)}`);
      return;
    }
    // Additional validation: ensure values are not null/undefined
    if (
      namespace === null ||
      namespace === undefined ||
      leaseName === null ||
      leaseName === undefined
    ) {
      log(
        '❌ ERROR: POD_NAMESPACE or leaseName is null/undefined, cannot start watch'
      );
      log(
        `   namespace: ${JSON.stringify(namespace)}, leaseName: ${JSON.stringify(leaseName)}`
      );
      return;
    }
    // Double-check parameters right before API call
    if (!leaseName || !namespace) {
      log(
        '❌ ERROR: Parameters became invalid before API call in watchResource()'
      );
      log(
        `   namespace: ${JSON.stringify(namespace)}, leaseName: ${JSON.stringify(leaseName)}`
      );
      return;
    }

    // Ensure parameters are explicitly strings (defensive programming)
    const nameParam = String(leaseName);
    const namespaceParam = String(namespace);

    // Final validation: ensure they're not empty strings after conversion
    if (
      !nameParam ||
      !namespaceParam ||
      nameParam === '' ||
      namespaceParam === ''
    ) {
      log(
        '❌ ERROR: Parameters invalid after string conversion in watchResource()'
      );
      log(
        `   nameParam: ${JSON.stringify(nameParam)}, namespaceParam: ${JSON.stringify(namespaceParam)}`
      );
      return;
    }

    const res = await safeReadNamespacedLease(nameParam, namespaceParam);
    if (res?.spec?.holderIdentity !== process.env.POD_NAME) {
      log('Not the leader anymore, stopping watch...');
      return;
    }
  } catch (err) {
    const errorMsg = err.message || String(err);

    // Check for client-side validation errors (parameter null/undefined)
    if (
      errorMsg.includes('Required parameter') &&
      (errorMsg.includes('was null or undefined') ||
        errorMsg.includes('was null') ||
        errorMsg.includes('was undefined'))
    ) {
      log(
        `⚠️ Client-side validation error in watchResource(): ${errorMsg}. This indicates a programming error.`
      );
      log(
        `   namespace: ${JSON.stringify(namespace)}, leaseName: ${JSON.stringify(leaseName)}`
      );
      log(`   POD_NAMESPACE: ${JSON.stringify(process.env.POD_NAMESPACE)}`);
      return;
    }

    log(`Error checking leader status: ${errorMsg}`);
    return;
  }

  // Abort existing watches before starting new ones
  if (clusterWatchRequest.value) {
    clusterWatchAborted.value = true;
    try {
      clusterWatchRequest.value.abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    clusterWatchRequest.value = null;
  }
  if (collectionWatchRequest.value) {
    collectionWatchAborted.value = true;
    try {
      collectionWatchRequest.value.abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    collectionWatchRequest.value = null;
  }

  // Reset abort flags
  clusterWatchAborted.value = false;
  collectionWatchAborted.value = false;

  // Start required watches (always recreate since we abort existing ones above)
  if (!clusterWatchRequest.value) {
    try {
      clusterWatchRequest.value = watch.watch(
        '/apis/qdrant.operator/v1alpha1/qdrantclusters',
        {},
        onEventCluster,
        onDoneCluster
      );
      log('Watching QdrantClusters API.');
      reconnectAttempts.cluster = 0; // Reset on successful start
      watchActive.set({ resource_type: 'cluster' }, 1);
    } catch (err) {
      log(`Error starting QdrantClusters watch: ${err.message}`);
      clusterWatchRequest.value = null;
      errorsTotal.inc({ type: 'watch_start' });
    }
  }
  if (!collectionWatchRequest.value) {
    try {
      collectionWatchRequest.value = watch.watch(
        '/apis/qdrant.operator/v1alpha1/qdrantcollections',
        {},
        onEventCollection,
        onDoneCollection
      );
      log('Watching QdrantCollections API.');
      reconnectAttempts.collection = 0; // Reset on successful start
      watchActive.set({ resource_type: 'collection' }, 1);
    } catch (err) {
      log(`Error starting QdrantCollections watch: ${err.message}`);
      collectionWatchRequest.value = null;
      errorsTotal.inc({ type: 'watch_start' });
    }
  }
  // Note: watch.watch() doesn't return a Promise, it starts the watch in the background
  // The callbacks (onEventCluster, onEventCollection) will be called when events occur
};

// Abort all active watches gracefully
export const abortAllWatches = () => {
  log('Aborting all active watches...');
  if (clusterWatchRequest.value) {
    clusterWatchAborted.value = true;
    try {
      clusterWatchRequest.value.abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    clusterWatchRequest.value = null;
  }
  if (collectionWatchRequest.value) {
    collectionWatchAborted.value = true;
    try {
      collectionWatchRequest.value.abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    collectionWatchRequest.value = null;
  }
  // Abort all StatefulSet watches
  for (const [key, request] of statefulSetWatchRequests.entries()) {
    statefulSetWatchAborted.set(key, true);
    try {
      request.abort();
    } catch (err) {
      // Ignore errors when aborting
    }
    statefulSetWatchRequests.delete(key);
    statefulSetWatchAborted.delete(key);
  }
};
