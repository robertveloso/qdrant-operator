#!/usr/bin/env bash
# Rollback/Downgrade: Verify operator handles spec rollback correctly
# This test verifies that reverting to a previous spec configuration converges correctly
# Especially important when versioning CRDs or rolling back deployments
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Rollback/Downgrade: Verifying operator handles spec rollback correctly"

CLUSTER_NAME="rollback-test-cluster"
INITIAL_IMAGE="qdrant/qdrant:v1.16.3"
UPDATED_IMAGE="qdrant/qdrant:v1.17.0"
INITIAL_REPLICAS=1
UPDATED_REPLICAS=2

# Step 1: Create cluster with initial spec
log_info "Step 1: Creating cluster with initial spec..."
log_info "  Image: ${INITIAL_IMAGE}"
log_info "  Replicas: ${INITIAL_REPLICAS}"

cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: default
spec:
  replicas: ${INITIAL_REPLICAS}
  image: ${INITIAL_IMAGE}
EOF

wait_for_resource "statefulset" "${CLUSTER_NAME}" "default" 60
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=120s
wait_for_cluster_healthy "${CLUSTER_NAME}" "default" 60

log_info "✅ Cluster created and healthy with initial spec"

# Record initial StatefulSet generation and image
INITIAL_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
INITIAL_STS_IMAGE=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
INITIAL_STS_REPLICAS=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

log_info "Initial StatefulSet state:"
log_info "  Generation: ${INITIAL_GENERATION}"
log_info "  Image: ${INITIAL_STS_IMAGE}"
log_info "  Replicas: ${INITIAL_STS_REPLICAS}"

# Step 2: Update spec (upgrade)
log_info "Step 2: Updating spec (upgrade)..."
log_info "  Image: ${INITIAL_IMAGE} -> ${UPDATED_IMAGE}"
log_info "  Replicas: ${INITIAL_REPLICAS} -> ${UPDATED_REPLICAS}"

kubectl patch qdrantcluster ${CLUSTER_NAME} -n default --type='merge' -p="{
  \"spec\": {
    \"image\": \"${UPDATED_IMAGE}\",
    \"replicas\": ${UPDATED_REPLICAS}
  }
}"

log_info "Waiting for rollout to start..."
sleep 3

# Verify StatefulSet generation increased (indicates rollout)
timeout=60
elapsed=0
rollout_started=false

while [ $elapsed -lt $timeout ]; do
  CURRENT_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
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
fi

# Wait for rollout to complete
log_info "Waiting for rollout to complete..."
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=180s || {
  log_error "Rollout failed or timed out"
  kubectl get sts ${CLUSTER_NAME} -n default -o yaml
  exit 1
}

wait_for_cluster_healthy "${CLUSTER_NAME}" "default" 120

log_info "✅ Upgrade rollout completed"

# Verify updated spec is applied
UPDATED_STS_IMAGE=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
UPDATED_STS_REPLICAS=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")

log_info "Updated StatefulSet state:"
log_info "  Image: ${UPDATED_STS_IMAGE}"
log_info "  Replicas: ${UPDATED_STS_REPLICAS}"

if [ "${UPDATED_STS_IMAGE}" != "${UPDATED_IMAGE}" ]; then
  log_error "StatefulSet image mismatch: expected ${UPDATED_IMAGE}, got ${UPDATED_STS_IMAGE}"
  exit 1
fi

if [ "${UPDATED_STS_REPLICAS}" != "${UPDATED_REPLICAS}" ]; then
  log_error "StatefulSet replicas mismatch: expected ${UPDATED_REPLICAS}, got ${UPDATED_STS_REPLICAS}"
  exit 1
fi

log_info "✅ Updated spec correctly applied"

# Record generation after upgrade
UPGRADE_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")

# Step 3: Rollback to initial spec (downgrade)
log_info "Step 3: Rolling back to initial spec (downgrade)..."
log_info "  Image: ${UPDATED_IMAGE} -> ${INITIAL_IMAGE}"
log_info "  Replicas: ${UPDATED_REPLICAS} -> ${INITIAL_REPLICAS}"

kubectl patch qdrantcluster ${CLUSTER_NAME} -n default --type='merge' -p="{
  \"spec\": {
    \"image\": \"${INITIAL_IMAGE}\",
    \"replicas\": ${INITIAL_REPLICAS}
  }
}"

log_info "Waiting for rollback rollout to start..."
sleep 3

# Verify StatefulSet generation increased (indicates rollback rollout)
timeout=60
elapsed=0
rollback_started=false

while [ $elapsed -lt $timeout ]; do
  CURRENT_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
  if [ "${CURRENT_GENERATION}" != "${UPGRADE_GENERATION}" ]; then
    log_info "✅ Rollback rollout started! Generation changed: ${UPGRADE_GENERATION} -> ${CURRENT_GENERATION}"
    rollback_started=true
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "${rollback_started}" = "false" ]; then
  log_warn "⚠️ Rollback rollout may not have started (generation unchanged)"
fi

# Wait for rollback rollout to complete
log_info "Waiting for rollback rollout to complete..."
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=180s || {
  log_error "Rollback rollout failed or timed out"
  kubectl get sts ${CLUSTER_NAME} -n default -o yaml
  exit 1
}

wait_for_cluster_healthy "${CLUSTER_NAME}" "default" 120

log_info "✅ Rollback rollout completed"

# Step 4: Verify rollback converged correctly
log_info "Step 4: Verifying rollback converged correctly..."

ROLLBACK_STS_IMAGE=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
ROLLBACK_STS_REPLICAS=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")
ROLLBACK_CR_IMAGE=$(kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o jsonpath='{.spec.image}' 2>/dev/null || echo "")
ROLLBACK_CR_REPLICAS=$(kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "")

log_info "Rollback StatefulSet state:"
log_info "  Image: ${ROLLBACK_STS_IMAGE}"
log_info "  Replicas: ${ROLLBACK_STS_REPLICAS}"

log_info "Rollback CR spec:"
log_info "  Image: ${ROLLBACK_CR_IMAGE}"
log_info "  Replicas: ${ROLLBACK_CR_REPLICAS}"

# Verify StatefulSet matches initial spec
if [ "${ROLLBACK_STS_IMAGE}" != "${INITIAL_IMAGE}" ]; then
  log_error "StatefulSet image mismatch after rollback: expected ${INITIAL_IMAGE}, got ${ROLLBACK_STS_IMAGE}"
  exit 1
fi

if [ "${ROLLBACK_STS_REPLICAS}" != "${INITIAL_REPLICAS}" ]; then
  log_error "StatefulSet replicas mismatch after rollback: expected ${INITIAL_REPLICAS}, got ${ROLLBACK_STS_REPLICAS}"
  exit 1
fi

# Verify CR spec matches initial spec
if [ "${ROLLBACK_CR_IMAGE}" != "${INITIAL_IMAGE}" ]; then
  log_error "CR image mismatch after rollback: expected ${INITIAL_IMAGE}, got ${ROLLBACK_CR_IMAGE}"
  exit 1
fi

if [ "${ROLLBACK_CR_REPLICAS}" != "${INITIAL_REPLICAS}" ]; then
  log_error "CR replicas mismatch after rollback: expected ${INITIAL_REPLICAS}, got ${ROLLBACK_CR_REPLICAS}"
  exit 1
fi

log_info "✅ Rollback spec matches initial spec"

# Step 5: Verify no infinite rollouts (generation should stabilize)
log_info "Step 5: Verifying no infinite rollouts after rollback..."

ROLLBACK_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
log_info "Generation after rollback: ${ROLLBACK_GENERATION}"

# Wait a bit and check generation hasn't changed
sleep 10
STABLE_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
sleep 10
FINAL_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")

if [ "${STABLE_GENERATION}" != "${FINAL_GENERATION}" ]; then
  log_error "Infinite rollout detected after rollback! Generation changed: ${STABLE_GENERATION} -> ${FINAL_GENERATION}"
  kubectl get sts ${CLUSTER_NAME} -n default -o yaml
  exit 1
fi

log_info "✅ No infinite rollouts detected (generation stable: ${FINAL_GENERATION})"

# Step 6: Verify cluster status is healthy
log_info "Step 6: Verifying cluster status is healthy after rollback..."

STATUS=$(kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
if [ "${STATUS}" != "Running" ] && [ "${STATUS}" != "Healthy" ]; then
  log_error "Cluster status is not healthy after rollback: ${STATUS}"
  kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o yaml
  exit 1
fi

log_info "✅ Cluster status is ${STATUS} after rollback"

# Verify pod count matches initial replicas
READY_REPLICAS=$(kubectl get sts ${CLUSTER_NAME} -n default -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [ "${READY_REPLICAS}" != "${INITIAL_REPLICAS}" ]; then
  log_error "Ready replicas mismatch after rollback: expected ${INITIAL_REPLICAS}, got ${READY_REPLICAS}"
  kubectl get pods -n default -l clustername=${CLUSTER_NAME}
  exit 1
fi

log_info "✅ Pod count matches initial replicas (${READY_REPLICAS}/${INITIAL_REPLICAS})"

log_info "✅ Rollback/downgrade test passed!"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster ${CLUSTER_NAME} -n default --wait=true 2>/dev/null || true

log_info "✅ Cleanup complete."
exit 0

