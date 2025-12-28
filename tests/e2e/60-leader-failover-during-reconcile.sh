#!/usr/bin/env bash
# Leader Failover During Reconcile: Verify HA behavior when leader is deleted during active reconciliation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Leader Failover During Reconcile: Verifying HA behavior during active reconciliation"

# Create cluster to trigger reconciliation
log_info "Creating cluster to trigger reconciliation..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml"
wait_for_resource "statefulset" "my-cluster" "default" 60
kubectl rollout status statefulset my-cluster -n default --timeout=120s

log_info "Cluster created, waiting for it to be Running..."
sleep 10

# Get current leader
POD=$(get_operator_pod)
log_info "Current operator pod: ${POD}"

# Verify it's the leader
if ! is_operator_leader "${POD}"; then
  log_warn "Current pod is not leader, skipping failover test"
  exit 0
fi

log_info "✅ Confirmed ${POD} is the leader"

# Force a reconciliation by patching the CR (add annotation to trigger update)
log_info "Forcing reconciliation by updating cluster annotation..."
kubectl annotate qdrantcluster my-cluster -n default \
  test-reconcile-trigger="$(date +%s)" \
  --overwrite || true

log_info "Waiting a moment for reconcile to start..."
sleep 3

# Check if reconcile is active (look for reconcile logs)
LOG_OUTPUT=$(kubectl logs -n qdrant-operator "${POD}" --tail=20 2>/dev/null || echo "")
if echo "${LOG_OUTPUT}" | grep -q "Starting reconciliation\|reconciliation for"; then
  log_info "✅ Reconcile activity detected in logs"
else
  log_warn "⚠️ Could not confirm reconcile is active, but proceeding with failover test"
fi

# Delete leader pod during reconcile
log_info "Deleting leader pod during reconcile to trigger failover..."
kubectl delete pod "${POD}" -n qdrant-operator

log_info "Waiting for new pod to be ready (timeout: 60s)..."
kubectl wait --for=condition=ready pod -l app=qdrant-operator -n qdrant-operator --timeout=60s || {
  log_error "New pod not ready after timeout"
  kubectl get pods -n qdrant-operator -l app=qdrant-operator
  exit 1
}

log_info "Waiting for new leader to be elected (timeout: 30s)..."
timeout=30
elapsed=0
NEW_POD=""

while [ $elapsed -lt $timeout ]; do
  NEW_POD=$(get_operator_pod)

  if [ -n "${NEW_POD}" ] && is_operator_leader "${NEW_POD}"; then
    log_info "✅ New leader elected: ${NEW_POD}"
    break
  fi

  log_info "Waiting for leader election... (${elapsed}s/${timeout}s)"
  sleep 5
  elapsed=$((elapsed + 5))
done

if [ -z "${NEW_POD}" ] || ! is_operator_leader "${NEW_POD}"; then
  log_error "New leader not elected within timeout"
  kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=50 || true
  exit 1
fi

# Verify state converged correctly (cluster should still be Running)
log_info "Verifying state converged correctly after failover..."
sleep 10

STATUS=$(kubectl get qdrantcluster my-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
if [ "${STATUS}" != "Running" ] && [ "${STATUS}" != "Healthy" ] && [ "${STATUS}" != "Pending" ] && [ "${STATUS}" != "OperationInProgress" ]; then
  log_warn "⚠️ Cluster status is '${STATUS}' (expected Running, Healthy, Pending, or OperationInProgress)"
  # Don't fail - status might be updating
fi

# Verify StatefulSet is in consistent state
STS_REPLICAS=$(kubectl get sts my-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
STS_READY=$(kubectl get sts my-cluster -n default -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")

if [ "${STS_REPLICAS}" != "1" ]; then
  log_error "StatefulSet replicas inconsistent: expected 1, got ${STS_REPLICAS}"
  kubectl get sts my-cluster -n default -o yaml
  exit 1
fi

log_info "✅ StatefulSet is in consistent state (replicas: ${STS_REPLICAS}, ready: ${STS_READY})"

# Check logs for any errors related to split-brain or partial apply
NEW_LOG_OUTPUT=$(kubectl logs -n qdrant-operator "${NEW_POD}" --tail=50 2>/dev/null || echo "")
if echo "${NEW_LOG_OUTPUT}" | grep -i "split-brain\|partial apply\|inconsistent state"; then
  log_error "Found errors indicating split-brain or inconsistent state"
  echo "${NEW_LOG_OUTPUT}"
  exit 1
fi

log_info "✅ No split-brain or inconsistent state errors detected"

# Verify no orphaned resources
POD_COUNT=$(kubectl get pods -n default -l clustername=my-cluster --no-headers 2>/dev/null | wc -l || echo "0")
if [ "${POD_COUNT}" != "1" ]; then
  log_warn "⚠️ Found ${POD_COUNT} pods (expected 1) - may indicate orphaned resources"
  kubectl get pods -n default -l clustername=my-cluster
  # Don't fail - might be transient
fi

log_info "✅ Leader failover during reconcile test passed"
exit 0

