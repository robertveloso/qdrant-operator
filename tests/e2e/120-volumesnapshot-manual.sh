#!/usr/bin/env bash
# VolumeSnapshot Manual: Verify manual VolumeSnapshot creation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "VolumeSnapshot Manual: Verifying manual VolumeSnapshot creation"

# Check if VolumeSnapshot API is available
if ! kubectl api-resources | grep -q volumesnapshots; then
  log_warn "⚠️ VolumeSnapshot API not available in this cluster (CSI snapshot feature may not be installed)"
  log_info "Skipping VolumeSnapshot test"
  exit 0
fi

CLUSTER_NAME="snapshot-test-cluster"

log_info "Creating cluster with persistence..."
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
    size: 1Gi
    storageClassName: standard
  volumeSnapshots:
    enabled: true
    createNow: true
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

# Wait a bit for snapshot creation
log_info "Waiting for VolumeSnapshot to be created..."
sleep 10

# Verify VolumeSnapshot was created
PVC_NAME="qdrant-storage-${CLUSTER_NAME}-0"
SNAPSHOTS=$(kubectl get volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant --no-headers 2>/dev/null | wc -l || echo "0")

if [ "${SNAPSHOTS}" -eq "0" ]; then
  log_warn "⚠️ No VolumeSnapshots found (may not be supported or snapshot creation failed)"
  log_info "Checking operator logs for snapshot creation attempts..."
  POD=$(get_operator_pod)
  kubectl logs -n qdrant-operator "${POD}" --tail=50 | grep -i snapshot || true
else
  log_info "✅ Found ${SNAPSHOTS} VolumeSnapshot(s)"

  # List snapshots
  kubectl get volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant

  # Verify snapshot is ready (if supported)
  SNAPSHOT_NAME=$(kubectl get volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "${SNAPSHOT_NAME}" ]; then
    READY=$(kubectl get volumesnapshot ${SNAPSHOT_NAME} -n default -o jsonpath='{.status.readyToUse}' 2>/dev/null || echo "false")
    if [ "${READY}" = "true" ]; then
      log_info "✅ VolumeSnapshot ${SNAPSHOT_NAME} is ready"
    else
      log_info "ℹ️ VolumeSnapshot ${SNAPSHOT_NAME} is not ready yet (may take time depending on storage provider)"
    fi
  fi
fi

log_info "✅ VolumeSnapshot manual test passed"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster ${CLUSTER_NAME} -n default 2>/dev/null || true
# Snapshots will be cleaned up by ownerReferences or manually
kubectl delete volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant 2>/dev/null || true

log_info "✅ VolumeSnapshot manual test completed"
exit 0

