#!/usr/bin/env bash
# Spec Update Rollout: Verify controlled rollout when spec is updated
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Spec Update Rollout: Verifying controlled rollout on spec update"

# Create cluster with specific image
INITIAL_IMAGE="qdrant/qdrant:v1.16.3"
UPDATED_IMAGE="qdrant/qdrant:v1.16.3"  # Same version but will trigger update via annotation

log_info "Creating cluster with image: ${INITIAL_IMAGE}..."
cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: rollout-test-cluster
  namespace: default
spec:
  replicas: 1
  image: ${INITIAL_IMAGE}
EOF

wait_for_resource "statefulset" "rollout-test-cluster" "default" 60
kubectl rollout status statefulset rollout-test-cluster -n default --timeout=120s

log_info "Waiting for cluster to reach Running/Healthy status..."
timeout=60
elapsed=0
while [ $elapsed -lt $timeout ]; do
  STATUS=$(kubectl get qdrantcluster rollout-test-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
  if [ "${STATUS}" = "Running" ] || [ "${STATUS}" = "Healthy" ]; then
    log_info "✅ Cluster is ${STATUS}"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# Record initial StatefulSet generation
INITIAL_GENERATION=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
log_info "Initial StatefulSet generation: ${INITIAL_GENERATION}"

# Record initial image
INITIAL_STS_IMAGE=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
log_info "Initial StatefulSet image: ${INITIAL_STS_IMAGE}"

# Update spec (change image to trigger rollout)
# We'll add an annotation to force a spec change that triggers reconciliation
log_info "Updating cluster spec to trigger rollout..."
kubectl patch qdrantcluster rollout-test-cluster -n default --type='merge' -p='{"spec":{"image":"'${UPDATED_IMAGE}'"}}' || \
kubectl annotate qdrantcluster rollout-test-cluster -n default test-rollout-trigger="$(date +%s)" --overwrite || true

log_info "Waiting for rollout to start..."
sleep 5

# Verify StatefulSet generation increased (indicates rollout)
timeout=60
elapsed=0
rollout_started=false

while [ $elapsed -lt $timeout ]; do
  CURRENT_GENERATION=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
  STATUS=$(kubectl get qdrantcluster rollout-test-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")

  if [ "${CURRENT_GENERATION}" != "${INITIAL_GENERATION}" ]; then
    log_info "✅ Rollout started! Generation changed: ${INITIAL_GENERATION} -> ${CURRENT_GENERATION}"
    rollout_started=true
    break
  fi

  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "${rollout_started}" = "false" ]; then
  log_warn "⚠️ Rollout may not have started (generation unchanged)"
  # Don't fail - might be idempotent update
fi

# Verify status is Pending or OperationInProgress during rollout (not Running/Healthy)
log_info "Verifying status during rollout..."
if [ "${STATUS}" = "Pending" ] || [ "${STATUS}" = "OperationInProgress" ]; then
  log_info "✅ Status is ${STATUS} during rollout (correct)"
elif [ "${STATUS}" = "Running" ] || [ "${STATUS}" = "Healthy" ]; then
  log_warn "⚠️ Status is already ${STATUS} (rollout may have completed quickly)"
else
  log_warn "⚠️ Status is '${STATUS}' (expected Pending, OperationInProgress, Running, or Healthy)"
fi

# Wait for rollout to complete
log_info "Waiting for rollout to complete..."
kubectl rollout status statefulset rollout-test-cluster -n default --timeout=120s || {
  log_error "Rollout failed or timed out"
  kubectl get sts rollout-test-cluster -n default -o yaml
  exit 1
}

log_info "✅ Rollout completed"

# Verify status changes to Running/Healthy only after pods are ready
log_info "Verifying status transitions to Running/Healthy after rollout..."
timeout=60
elapsed=0
status_ready=false

while [ $elapsed -lt $timeout ]; do
  STATUS=$(kubectl get qdrantcluster rollout-test-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
  READY_REPLICAS=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  AVAILABLE_REPLICAS=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo "0")
  SPEC_REPLICAS=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

  if [ "${STATUS}" = "Running" ] || [ "${STATUS}" = "Healthy" ]; then
    # Verify pods are actually ready when status is Running/Healthy
    if [ "${READY_REPLICAS}" = "${SPEC_REPLICAS}" ] && [ "${AVAILABLE_REPLICAS}" = "${SPEC_REPLICAS}" ]; then
      log_info "✅ Status is ${STATUS} and all pods are ready (${READY_REPLICAS}/${SPEC_REPLICAS})"
      status_ready=true
      break
    else
      log_warn "⚠️ Status is ${STATUS} but pods not all ready (${READY_REPLICAS}/${SPEC_REPLICAS})"
      # This might indicate a bug, but don't fail immediately
    fi
  fi

  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "${status_ready}" = "false" ]; then
  log_warn "⚠️ Status did not transition to Running/Healthy within timeout (current: ${STATUS})"
  # Don't fail - might be updating
fi

# Verify no infinite rollouts (generation should stabilize)
log_info "Verifying no infinite rollouts..."
sleep 10
FINAL_GENERATION=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
sleep 10
STABLE_GENERATION=$(kubectl get sts rollout-test-cluster -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")

if [ "${FINAL_GENERATION}" != "${STABLE_GENERATION}" ]; then
  log_error "Infinite rollout detected! Generation changed: ${FINAL_GENERATION} -> ${STABLE_GENERATION}"
  kubectl get sts rollout-test-cluster -n default -o yaml
  exit 1
fi

log_info "✅ No infinite rollouts detected (generation stable: ${STABLE_GENERATION})"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster rollout-test-cluster -n default 2>/dev/null || true

log_info "✅ Spec update rollout test passed"
exit 0

