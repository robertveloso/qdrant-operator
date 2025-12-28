// Global state management for the operator
// This module centralizes all stateful data structures

// Queue per resource to avoid losing events
export const applyQueue = new Map();

// Track resources currently updating status (to avoid duplicate updates)
export const settingStatus = new Map();

// Per-resource resourceVersion tracking (key: namespace/name)
export const lastClusterResourceVersion = new Map();
export const lastCollectionResourceVersion = new Map();

// Local cache (informer-style) to reduce API Server calls
// IMPORTANT: Cache is NOT source of truth - use for fast reads only
// For critical decisions (create/delete/modify), always fallback to API Server
// This cache doesn't handle: resourceVersion global tracking, resync, compaction
// Rule of thumb: cache → fast reads, API → critical decisions
export const clusterCache = new Map(); // Cache of QdrantCluster objects (key: namespace/name)
export const collectionCache = new Map(); // Cache of QdrantCollection objects (key: namespace/name)
export const statefulSetCache = new Map(); // Cache of StatefulSet objects (key: namespace/name)

// Flags and controllers for graceful watch shutdown
export const clusterWatchAborted = { value: false };
export const collectionWatchAborted = { value: false };
export const clusterWatchRequest = { value: null }; // Reference to active watch request
export const collectionWatchRequest = { value: null }; // Reference to active watch request
export const statefulSetWatchAborted = new Map(); // Per-cluster StatefulSet watch abort flags
export const statefulSetWatchRequests = new Map(); // Per-cluster StatefulSet watch request references
export const statefulSetLastReadinessStatus = new Map(); // Track last logged readiness status to reduce log noise

// Rate limiting and exponential backoff
export const reconnectAttempts = {
  cluster: 0,
  collection: 0
};

// Graceful shutdown flag - when true, no new reconciles should be started
export const shuttingDown = { value: false };

// Track active reconciles for graceful shutdown
export const activeReconciles = new Set(); // Set of resourceKeys currently being reconciled

// Queue events that occur during status updates (to avoid losing them)
export const pendingEvents = new Map(); // Map of resourceKey -> array of pending events

// Retry queue for persistent retries that survive reconnections
export const retryQueue = new Map(); // Map<retryKey, { apiObj, resourceType, retryCount, scheduledAt, timeoutId }>
