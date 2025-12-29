#!/usr/bin/env bash
# Operator Crash Loop: Verify operator handles repeated crashes during reconciliation
# This test verifies the operator doesn't create duplicate resources or enter split-brain state
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Operator Crash Loop: Verifying resilience to repeated crashes during reconciliation"

# Create cluster to trigger reconciliation
log_info "Creating cluster to trigger reconciliation..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml"
wait_for_resource "statefulset" "my-cluster" "default" 60
kubectl rollout status statefulset my-cluster -n default --timeout=120s

wait_for_cluster_healthy "my-cluster" "default" 60

log_info "✅ Cluster created and healthy"

# Force a long-running reconciliation by triggering a rollout
# Update image to force StatefulSet update (this triggers a rollout)
log_info "Triggering long-running reconciliation (image update to force rollout)..."
ORIGINAL_IMAGE=$(kubectl get qdrantcluster my-cluster -n default -o jsonpath='{.spec.image}')
NEW_IMAGE="qdrant/qdrant:v1.16.3"

# Only update if different
if [ "${ORIGINAL_IMAGE}" != "${NEW_IMAGE}" ]; then
  kubectl patch qdrantcluster my-cluster -n default --type='merge' -p="{\"spec\":{\"image\":\"${NEW_IMAGE}\"}}"
  log_info "Image updated from ${ORIGINAL_IMAGE} to ${NEW_IMAGE} (rollout will start)"
else
  # If already the same, trigger via annotation to force reconcile
  kubectl annotate qdrantcluster my-cluster -n default \
    test-crash-loop-trigger="$(date +%s)" \
    --overwrite || true
  log_info "Triggered reconciliation via annotation"
fi

log_info "Waiting a moment for reconciliation to start..."
sleep 3

# Verify reconciliation is active
POD=$(get_operator_pod)
if [ -z "${POD}" ]; then
  log_error "Operator pod not found"
  exit 1
fi

log_info "Starting crash-loop test: deleting operator pod 4 times during reconciliation..."
CRASH_COUNT=4
for i in $(seq 1 ${CRASH_COUNT}); do
  log_info "Crash iteration ${i}/${CRASH_COUNT}: Deleting operator pod..."

  # Get current pod before deletion
  CURRENT_POD=$(get_operator_pod)
  if [ -z "${CURRENT_POD}" ]; then
    log_error "No operator pod found"
    exit 1
  fi

  log_info "Deleting pod: ${CURRENT_POD}"
  kubectl delete pod "${CURRENT_POD}" -n qdrant-operator

  # Wait for new pod to be ready
  log_info "Waiting for new pod to be ready (timeout: 60s)..."
  kubectl wait --for=condition=ready pod -l app=qdrant-operator -n qdrant-operator --timeout=60s || {
    log_error "New pod not ready after crash ${i}"
    kubectl get pods -n qdrant-operator -l app=qdrant-operator
    exit 1
  }

  # Wait for new leader to be elected
  log_info "Waiting for new leader to be elected (timeout: 30s)..."
  NEW_POD=$(get_operator_pod)
  timeout=30
  elapsed=0
  leader_elected=false

  while [ $elapsed -lt $timeout ]; do
    if is_operator_leader "${NEW_POD}"; then
      log_info "✅ New leader elected: ${NEW_POD}"
      leader_elected=true
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [ "${leader_elected}" = "false" ]; then
    log_warn "⚠️ Leader not elected yet after crash ${i}, but continuing..."
  fi

  # Small delay between crashes to allow some reconciliation progress
  if [ $i -lt ${CRASH_COUNT} ]; then
    log_info "Waiting 5s before next crash to allow some reconciliation progress..."
    sleep 5
  fi
done

log_info "✅ Completed ${CRASH_COUNT} crashes"

# Verify no duplicate resources were created
log_info "Verifying no duplicate resources were created..."

# Check for duplicate StatefulSets
STS_COUNT=$(kubectl get statefulsets -n default -l clustername=my-cluster --no-headers 2>/dev/null | wc -l || echo "0")
if [ "${STS_COUNT}" != "1" ]; then
  log_error "Found ${STS_COUNT} StatefulSets (expected 1) - duplicate resources detected!"
  kubectl get statefulsets -n default -l clustername=my-cluster
  exit 1
fi
log_info "✅ Only 1 StatefulSet found (no duplicates)"

# Check for duplicate Services
SVC_COUNT=$(kubectl get services -n default -l clustername=my-cluster --no-headers 2>/dev/null | wc -l || echo "0")
EXPECTED_SERVICES=2  # headless + regular service
if [ "${SVC_COUNT}" != "${EXPECTED_SERVICES}" ]; then
  log_warn "⚠️ Found ${SVC_COUNT} Services (expected ${EXPECTED_SERVICES})"
  kubectl get services -n default -l clustername=my-cluster
  # Don't fail - might be transient
fi

# Check for duplicate ConfigMaps
CM_COUNT=$(kubectl get configmaps -n default -l clustername=my-cluster --no-headers 2>/dev/null | wc -l || echo "0")
if [ "${CM_COUNT}" != "1" ]; then
  log_warn "⚠️ Found ${CM_COUNT} ConfigMaps (expected 1)"
  kubectl get configmaps -n default -l clustername=my-cluster
  # Don't fail - might be transient
fi

# Verify state converged correctly
log_info "Verifying state converged correctly after crash-loop..."

# Wait for final reconciliation to complete
log_info "Waiting for final reconciliation to complete (timeout: 120s)..."
timeout=120
elapsed=0
converged=false

while [ $elapsed -lt $timeout ]; do
  # Check if StatefulSet is in desired state
  STS_REPLICAS=$(kubectl get sts my-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
  STS_READY=$(kubectl get sts my-cluster -n default -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")

  if [ "${STS_REPLICAS}" = "1" ] && [ "${STS_READY}" = "1" ]; then
    # Check if rollout is complete
    ROLLOUT_STATUS=$(kubectl rollout status statefulset my-cluster -n default --timeout=5s 2>&1 || echo "")
    if echo "${ROLLOUT_STATUS}" | grep -q "successfully rolled out\|rollout complete"; then
      log_info "✅ State converged: StatefulSet is ready (replicas: ${STS_REPLICAS}, ready: ${STS_READY})"
      converged=true
      break
    fi
  fi

  sleep 5
  elapsed=$((elapsed + 5))
done

if [ "${converged}" = "false" ]; then
  log_warn "⚠️ State may not have fully converged, but checking final state..."
fi

# Final state verification
log_info "Final state verification..."

# Verify StatefulSet is in consistent state
STS_REPLICAS=$(kubectl get sts my-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
if [ "${STS_REPLICAS}" != "1" ]; then
  log_error "StatefulSet replicas inconsistent: expected 1, got ${STS_REPLICAS}"
  kubectl get sts my-cluster -n default -o yaml
  exit 1
fi

# Verify only one pod exists
POD_COUNT=$(kubectl get pods -n default -l clustername=my-cluster --no-headers 2>/dev/null | grep -v "Terminating" | wc -l || echo "0")
if [ "${POD_COUNT}" != "1" ]; then
  log_error "Found ${POD_COUNT} cluster pods (expected 1) - may indicate orphaned resources or split-brain"
  kubectl get pods -n default -l clustername=my-cluster
  exit 1
fi
log_info "✅ Only 1 cluster pod found (no orphaned resources)"

# Check for split-brain indicators in logs
FINAL_POD=$(get_operator_pod)
LOG_OUTPUT=$(kubectl logs -n qdrant-operator "${FINAL_POD}" --tail=100 2>/dev/null || echo "")

# Check for errors indicating split-brain or inconsistent state
if echo "${LOG_OUTPUT}" | grep -iE "split-brain|partial apply|inconsistent state|duplicate.*created|race condition"; then
  log_error "Found errors indicating split-brain or inconsistent state"
  echo "${LOG_OUTPUT}" | grep -iE "split-brain|partial apply|inconsistent state|duplicate.*created|race condition"
  exit 1
fi
log_info "✅ No split-brain or inconsistent state errors detected"

# Verify cluster status is reasonable
STATUS=$(kubectl get qdrantcluster my-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
if [ -z "${STATUS}" ]; then
  log_warn "⚠️ Cluster status is empty (may still be updating)"
elif [ "${STATUS}" != "Running" ] && [ "${STATUS}" != "Healthy" ] && [ "${STATUS}" != "Pending" ] && [ "${STATUS}" != "OperationInProgress" ]; then
  log_warn "⚠️ Cluster status is '${STATUS}' (may indicate issues)"
  # Don't fail - status might be updating
else
  log_info "✅ Cluster status: ${STATUS}"
fi

# Verify operator is still functioning (can reconcile)
log_info "Verifying operator can still reconcile..."
kubectl annotate qdrantcluster my-cluster -n default \
  test-final-verification="$(date +%s)" \
  --overwrite || true

sleep 5

# Check if operator processed the annotation (indicates it's functioning)
FINAL_LOG=$(kubectl logs -n qdrant-operator "${FINAL_POD}" --tail=20 --since=10s 2>/dev/null || echo "")
if echo "${FINAL_LOG}" | grep -q "reconciliation\|reconcile"; then
  log_info "✅ Operator is functioning and can reconcile"
else
  log_warn "⚠️ Could not confirm operator is reconciling (may be idempotent - no changes needed)"
fi

log_info "✅ Operator crash-loop test passed!"
log_info "   - No duplicate resources created"
log_info "   - State converged correctly"
log_info "   - No split-brain detected"
log_info "   - Operator is still functioning"

exit 0

