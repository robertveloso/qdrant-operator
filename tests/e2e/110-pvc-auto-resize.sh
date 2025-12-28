#!/usr/bin/env bash
# PVC Auto Resize: Verify automatic PVC expansion when persistence.size increases
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "PVC Auto Resize: Verifying automatic PVC expansion"

# Create cluster with initial size
INITIAL_SIZE="1Gi"
EXPANDED_SIZE="2Gi"
CLUSTER_NAME="resize-test-cluster"

log_info "Creating cluster with initial PVC size: ${INITIAL_SIZE}..."
cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: default
spec:
  replicas: 1
  image: qdrant/qdrant:v1.16.3
  persistence:
    size: ${INITIAL_SIZE}
    storageClassName: standard
EOF

wait_for_resource "statefulset" "${CLUSTER_NAME}" "default" 60
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=120s

log_info "Waiting for cluster to be Healthy..."
timeout=60
elapsed=0
while [ $elapsed -lt $timeout ]; do
  STATUS=$(kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
  if [ "${STATUS}" = "Healthy" ] || [ "${STATUS}" = "Running" ]; then
    log_info "✅ Cluster is ${STATUS}"
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

# Verify initial PVC size
PVC_NAME="qdrant-storage-${CLUSTER_NAME}-0"
log_info "Verifying initial PVC size..."
INITIAL_PVC_SIZE=$(kubectl get pvc ${PVC_NAME} -n default -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || echo "")
if [ "${INITIAL_PVC_SIZE}" != "${INITIAL_SIZE}" ]; then
  log_error "Initial PVC size mismatch: expected ${INITIAL_SIZE}, got ${INITIAL_PVC_SIZE}"
  exit 1
fi
log_info "✅ Initial PVC size is correct: ${INITIAL_PVC_SIZE}"

# Expand PVC by updating spec
log_info "Expanding PVC size from ${INITIAL_SIZE} to ${EXPANDED_SIZE}..."
kubectl patch qdrantcluster ${CLUSTER_NAME} -n default --type='merge' -p="{\"spec\":{\"persistence\":{\"size\":\"${EXPANDED_SIZE}\"}}}"

log_info "Waiting for operator to detect and expand PVC (timeout: 60s)..."
timeout=60
elapsed=0
pvc_expanded=false

while [ $elapsed -lt $timeout ]; do
  CURRENT_SIZE=$(kubectl get pvc ${PVC_NAME} -n default -o jsonpath='{.spec.resources.requests.storage}' 2>/dev/null || echo "")

  if [ "${CURRENT_SIZE}" = "${EXPANDED_SIZE}" ]; then
    log_info "✅ PVC size updated to ${EXPANDED_SIZE}"
    pvc_expanded=true
    break
  fi

  log_info "Waiting for PVC expansion... (${elapsed}s/${timeout}s) - Current size: ${CURRENT_SIZE}"
  sleep 5
  elapsed=$((elapsed + 5))
done

if [ "${pvc_expanded}" = "false" ]; then
  log_error "PVC was not expanded within timeout"
  kubectl get pvc ${PVC_NAME} -n default -o yaml
  kubectl get qdrantcluster ${CLUSTER_NAME} -n default -o yaml
  exit 1
fi

# Verify PVC status shows expansion
PVC_CONDITION=$(kubectl get pvc ${PVC_NAME} -n default -o jsonpath='{.status.conditions[?(@.type=="Resizing")].status}' 2>/dev/null || echo "")
if [ "${PVC_CONDITION}" = "True" ]; then
  log_info "✅ PVC is in Resizing condition (expansion in progress)"
elif [ "${PVC_CONDITION}" = "False" ] || [ -z "${PVC_CONDITION}" ]; then
  log_info "ℹ️ PVC expansion may have completed or storage provider doesn't support online expansion"
fi

log_info "✅ PVC auto resize test passed"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster ${CLUSTER_NAME} -n default 2>/dev/null || true

log_info "✅ PVC auto resize test completed"
exit 0

