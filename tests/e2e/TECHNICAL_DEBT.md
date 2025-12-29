# Technical Debt - E2E Tests

## Leader Detection

### Current Implementation

**Status:** Partially Improved (2024-12-29)

- **Primary Method**: Now uses Lease object (`kubectl get lease qdrant-operator`) to check `holderIdentity`
- **Fallback Method**: Falls back to `kubectl logs | grep LEADER` if Lease check fails
- **Location**: `utils.sh:is_operator_leader()` and `utils.sh:wait_for_operator_leader()`

### Remaining Issues

**Log-based fallback is still fragile:**

- Logs may not be immediately available
- Log rotation can cause misses
- No guarantee logs reflect current state
- Race conditions possible

### Better Approaches (Future Improvements)

1. **Metrics** (Recommended): Expose `operator_leader{pod=...} 1` metric

   - Most reliable and observable
   - Can be scraped by Prometheus
   - Real-time status without API calls

2. **Lease Status** (Currently Implemented): Check Lease object `holderIdentity` directly

   - ✅ Already implemented as primary method
   - More reliable than logs
   - Direct source of truth

3. **Pod Annotation**: Set annotation on pod when leader

   - `qdrant.operator/leader: "true"`
   - Easy to check with `kubectl get pod -o jsonpath`

4. **ConfigMap**: Store leader info in ConfigMap
   - Less ideal, adds another resource

### Implementation Details

**Lease Information:**

- **Name**: `qdrant-operator`
- **Namespace**: `qdrant-operator` (same as operator deployment)
- **Field**: `spec.holderIdentity` contains the pod name of the current leader
- **Check**: `kubectl get lease qdrant-operator -n qdrant-operator -o jsonpath='{.spec.holderIdentity}'`

**Current Helper Functions:**

- `check_lease_leader(pod, namespace, lease_name)` - Checks Lease directly
- `is_operator_leader(pod, namespace, lease_name)` - Uses Lease with log fallback
- `wait_for_operator_leader(pod, timeout, namespace, lease_name)` - Waits for leader status

### Priority

**Priority:** Medium (Partially Addressed)
**Impact:** Reduced test flakiness, but log fallback still fragile
**Next Steps:**

1. Add metric `operator_leader{pod=...}` in operator code
2. Update helpers to use metrics as primary, Lease as secondary, logs as last resort
3. Remove log-based detection entirely

### References

- `utils.sh:check_lease_leader()`
- `utils.sh:wait_for_operator_leader()`
- `utils.sh:is_operator_leader()`
- `src/leader-election.js` - Lease implementation
- `50-leader-failover.sh` - Uses leader detection
- `60-leader-failover-during-reconcile.sh` - Uses leader detection
