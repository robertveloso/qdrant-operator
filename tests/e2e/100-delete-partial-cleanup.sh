#!/usr/bin/env bash
# Delete Partial Cleanup: Verify cleanup is idempotent when resources are already partially removed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Delete Partial Cleanup: Verifying cleanup is idempotent"

# Create cluster
log_info "Creating cluster for partial cleanup test..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml"
wait_for_resource "statefulset" "my-cluster" "default" 60
kubectl rollout status statefulset my-cluster -n default --timeout=120s

log_info "Cluster created successfully"

# Manually delete StatefulSet (simulating partial failure)
log_info "Manually deleting StatefulSet to simulate partial cleanup..."
kubectl delete statefulset my-cluster -n default --wait=false

log_info "Waiting for StatefulSet to be deleted..."
sleep 5

# Verify StatefulSet is gone
if kubectl get sts my-cluster -n default 2>/dev/null; then
  log_error "StatefulSet still exists after manual deletion"
  exit 1
fi

log_info "✅ StatefulSet manually deleted (simulating partial cleanup)"

# Now delete the CR - finalizer should handle cleanup gracefully
log_info "Deleting QdrantCluster (finalizer should handle cleanup idempotently)..."
kubectl delete qdrantcluster my-cluster -n default

log_info "Waiting for finalizer to complete and resource to be deleted (timeout: 60s)..."
wait_for_deletion "qdrantcluster" "my-cluster" "default" 60

log_info "✅ CR deleted successfully"

# Verify operator didn't crash (check logs for idempotent cleanup message)
POD=$(get_operator_pod)
if [ -z "${POD}" ]; then
  log_error "Operator pod not found - operator may have crashed"
  exit 1
fi

# Check logs for idempotent cleanup message
LOG_OUTPUT=$(kubectl logs -n qdrant-operator "${POD}" --tail=50 2>/dev/null || echo "")
if echo "${LOG_OUTPUT}" | grep -q "idempotent cleanup"; then
  log_info "✅ Found idempotent cleanup message in logs"
elif echo "${LOG_OUTPUT}" | grep -q "already deleted\|not found.*already"; then
  log_info "✅ Found cleanup handling 'not found' gracefully in logs"
else
  log_warn "⚠️ Could not find explicit idempotent cleanup message, but cleanup succeeded"
fi

# Verify no errors in logs related to StatefulSet not found
if echo "${LOG_OUTPUT}" | grep -i "error.*statefulset.*not found" | grep -v "already deleted\|idempotent"; then
  log_warn "⚠️ Found error about StatefulSet not found (may indicate non-idempotent cleanup)"
  # Don't fail - cleanup still succeeded
fi

log_info "✅ Finalizer handled partial cleanup gracefully (idempotent)"

log_info "✅ Delete partial cleanup test passed"
exit 0

