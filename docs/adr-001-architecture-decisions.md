# ADR-001: Architecture Decisions and Trade-offs

**Status**: Accepted
**Date**: 2024-12-28
**Context**: Qdrant Operator - Kubernetes Operator for managing Qdrant clusters and collections

## Summary

This ADR documents the key architectural decisions, trade-offs, and design principles of the Qdrant Operator. It explains why certain choices were made and what risks are accepted as part of these decisions.

## Core Architecture

### Watch → Enqueue → Reconcile Pattern

The operator follows a clear separation of concerns:

1. **Watch** (`watch.js`): Monitors Kubernetes API for CR changes via watch streams
2. **Enqueue** (`events.js`): Processes watch events, deduplicates, and enqueues reconciliation
3. **Reconcile** (`reconciliation.js`): Compares desired state (CR spec) vs observed state (actual resources)

**Rationale**: This pattern is used by mature operators (Elastic, Crossplane, etc.) and provides:

- Clear separation of concerns
- Easy to reason about
- Testable components
- Resilient to API Server issues

### Declarative Reconciliation

The operator implements true declarative reconciliation:

- Compares desired state (from CR spec) with observed state (from Kubernetes API)
- Only applies changes when drift is detected
- Idempotent operations (safe to run multiple times)

**Key Principle**: The operator never assumes it knows the current state - it always reads from the API Server for critical decisions.

## Trade-offs and Design Decisions

### 1. Cache vs API Server (Source of Truth)

**Decision**: Use local cache for performance, but API Server is always the source of truth.

**Implementation**:

- Cache is used for fast reads (reducing API calls)
- For critical decisions (create/delete/modify), always fallback to API Server
- Cache is updated after successful operations, but errors are ignored

**Trade-off**:

- ✅ **Benefit**: Reduces API Server load, faster reconciliation
- ⚠️ **Risk**: Cache may be stale for up to 5 minutes (until periodic reconciliation)
- ✅ **Mitigation**: Periodic reconciliation every 5 minutes ensures eventual consistency

**Code Reference**: `src/state.js:14-21`, `src/reconciliation.js:74-91`

### 2. Hash-based Fast Path

**Decision**: Use spec hash to quickly skip reconciliation when spec hasn't changed.

**Implementation**:

- Calculate hash of relevant spec fields (replicas, image, resources, etc.)
- Store hash in CR status as `lastAppliedHash`
- If hash matches, skip expensive diff operations

**Trade-off**:

- ✅ **Benefit**: Avoids unnecessary API calls and rollouts when spec is unchanged
- ⚠️ **Risk**: Hash doesn't cover all fields (only reconciliation-relevant ones)
- ✅ **Mitigation**: Hash is used as fast path, not absolute truth - full reconciliation still happens when hash differs

**Code Reference**: `src/spec-hash.js:6-21`, `src/reconciliation.js:142-168`

### 3. Drift Detection Strategy

**Decision**: Use hash-based fast path + selective field comparison for drift detection.

**Current Implementation**:

- Fast path: If hash matches, assume no drift
- Slow path: Compare replicas and image when hash differs
- Only apply StatefulSet if drift detected

**Trade-off**:

- ✅ **Benefit**: Avoids unnecessary rollouts
- ⚠️ **Risk**: Drift in other fields (resources, env vars, volumes, affinity) may not be detected immediately
- ✅ **Mitigation**: Periodic reconciliation (5 min) catches any missed drift
- 📝 **Future**: Consider always applying StatefulSet when hash differs (Kubernetes is idempotent)

**Code Reference**: `src/reconciliation.js:142-168`

### 4. Separation of Cheap vs Expensive Resources

**Decision**: Always apply "cheap" resources (ConfigMap, Service), only apply "expensive" resources (StatefulSet) when needed.

**Implementation**:

- ConfigMap, Service, PDB: Always applied (idempotent, no rollouts)
- Secrets: Applied with their own idempotency logic
- StatefulSet: Only applied when drift detected

**Rationale**:

- Cheap resources don't cause rollouts
- Safe to apply frequently
- Reduces risk of missing updates

**Code Reference**: `src/reconciliation.js:170-180`

### 5. Periodic Reconciliation (Safety Net)

**Decision**: Reconcile all resources every 5 minutes, regardless of watch events.

**Implementation**:

- `setInterval` in `index.js` lists all clusters/collections
- Calls `scheduleReconcile` for each resource
- Ensures eventual consistency even if events were missed

**Rationale**:

- Watch may miss events during reconnection
- Manual changes (kubectl edit) may not trigger watch events
- Provides safety net for any edge cases

**Trade-off**:

- ✅ **Benefit**: Guarantees eventual consistency
- ⚠️ **Cost**: Additional API calls every 5 minutes
- ✅ **Acceptable**: Low overhead, high reliability

**Code Reference**: `src/index.js:74-129`

## Risk Mitigation Strategies

### Known Risks and Mitigations

1. **Cache Staleness**

   - **Risk**: Cache may be stale for up to 5 minutes
   - **Mitigation**: Periodic reconciliation, API fallback for critical decisions
   - **Acceptability**: Low risk - only affects manual drift detection timing

2. **Watch Event Loss**

   - **Risk**: Events may be lost during watch reconnection
   - **Mitigation**: Periodic reconciliation, resourceVersion deduplication
   - **Acceptability**: Low risk - periodic reconciliation covers it

3. **Drift Detection Incompleteness**

   - **Risk**: Only replicas/image are checked for drift
   - **Mitigation**: Periodic reconciliation, hash-based detection
   - **Acceptability**: Medium risk - may miss some drift until periodic reconciliation

4. **Finalizer Deadlock**

   - **Risk**: CR may get stuck in deletion if cleanup fails
   - **Mitigation**: Retry with backoff, timeout handling
   - **Future**: Add escape hatch (force delete after N attempts)

5. **Leader Failover During Reconcile**
   - **Risk**: Reconcile may be interrupted mid-operation
   - **Current**: `process.exit(1)` on leader loss
   - **Future**: Graceful shutdown (wait for active reconciles to complete)

## Testing Strategy

### E2E Tests (Primary)

**Location**: `tests/e2e/`

**Coverage**:

- Happy path (cluster creation, collection access)
- Drift detection (manual changes are corrected)
- Idempotency (repeated reconciles don't cause rollouts)
- Finalizers (cleanup on deletion)
- Leader failover (optional)

**Rationale**: E2E tests validate real operator behavior in a real Kubernetes cluster (K3s). This is the most important test layer for operators.

### Unit Tests (Focused)

**Location**: `src/test.js`, `src/test-helpers.js`

**Coverage**:

- Template generation (deterministic manifest creation)
- Helper functions (hash calculation, finalizer checks, drift detection logic)

**Rationale**: Unit tests focus on pure functions and deterministic behavior. We intentionally avoid mocking Kubernetes client extensively.

### What We Don't Test

- Watch reconnection under load (covered by periodic reconciliation)
- Race conditions in status updates (retry logic handles it)
- Cache staleness edge cases (periodic reconciliation covers it)

**Rationale**: These are acceptable risks given the mitigations in place. Testing them would require complex mocks that may not reflect real behavior.

## Observability

### Metrics

**Location**: `src/metrics.js`

**Current Metrics**:

- `qdrant_operator_reconcile_total` - Reconciliation count (success/error)
- `qdrant_operator_reconcile_duration_seconds` - Reconciliation duration
- `qdrant_operator_reconcile_queue_depth` - Queue depth
- `qdrant_operator_watch_restarts_total` - Watch restart count
- `qdrant_operator_watch_active` - Active watch count
- `qdrant_operator_clusters_managed` - Number of managed clusters
- `qdrant_operator_collections_managed` - Number of managed collections
- `qdrant_operator_errors_total` - Error count by type
- `qdrant_operator_leader` - Leader status (1/0)

**Future Metrics** (planned):

- `qdrant_operator_drift_detected_total` - Drift detection count
- `qdrant_operator_cleanup_duration_seconds` - Cleanup duration
- `qdrant_operator_status_update_conflicts_total` - Status update conflicts

## Decisions Not Made (Future Considerations)

1. **Full Drift Detection**: Always apply StatefulSet when hash differs (instead of selective comparison)
2. **Graceful Shutdown**: Wait for active reconciles before exiting on leader loss
3. **Finalizer Escape Hatch**: Force remove finalizer after N failed cleanup attempts
4. **Event Queuing**: Queue events that occur during status updates instead of ignoring them

These are documented as future improvements in the hardening roadmap.

## References

- [Kubernetes Controller Patterns](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Operator Best Practices](https://sdk.operatorframework.io/docs/best-practices/)
- [Elastic Operator Architecture](https://www.elastic.co/guide/en/cloud-on-k8s/current/k8s-architecture.html)
