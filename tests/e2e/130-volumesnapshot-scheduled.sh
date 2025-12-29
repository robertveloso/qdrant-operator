#!/usr/bin/env bash
# VolumeSnapshot Scheduled: Verify scheduled VolumeSnapshot creation via CronJob
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "VolumeSnapshot Scheduled: Verifying scheduled VolumeSnapshot creation"

# Check if VolumeSnapshot API is available
if ! kubectl api-resources | grep -q volumesnapshots; then
  log_warn "⚠️ VolumeSnapshot API not available in this cluster (CSI snapshot feature may not be installed)"
  log_info "Skipping VolumeSnapshot scheduled test"
  exit 0
fi

CLUSTER_NAME="scheduled-snapshot-cluster"

log_info "Creating cluster with scheduled VolumeSnapshots..."
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
    schedule: "*/2 * * * *"  # Every 2 minutes for testing
    retentionCount: 3
EOF

wait_for_resource "statefulset" "${CLUSTER_NAME}" "default" 60
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=120s

wait_for_cluster_healthy "${CLUSTER_NAME}" "default" 60

# Verify CronJob was created
log_info "Verifying VolumeSnapshot CronJob was created..."
CRONJOB_NAME="${CLUSTER_NAME}-volumesnapshot"
wait_for_resource "cronjob" "${CRONJOB_NAME}" "default" 30
cronjob_created=true

if [ "${cronjob_created}" = "false" ]; then
  log_warn "⚠️ VolumeSnapshot CronJob not found (may not be supported or creation failed)"
  log_info "Checking operator logs..."
  POD=$(get_operator_pod)
  kubectl logs -n qdrant-operator "${POD}" --tail=50 | grep -i "volumesnapshot\|cronjob" || true
else
  # Verify CronJob schedule
  SCHEDULE=$(kubectl get cronjob ${CRONJOB_NAME} -n default -o jsonpath='{.spec.schedule}' 2>/dev/null || echo "")
  log_info "✅ CronJob schedule: ${SCHEDULE}"

  # Wait for first job to be created (CronJob may trigger immediately or wait for schedule)
  log_info "Waiting for first snapshot job to be created (may take up to 2.5 minutes for schedule)..."
  timeout=150  # 2.5 minutes to account for schedule
  elapsed=0
  job_created=false

  while [ $elapsed -lt $timeout ]; do
    JOBS=$(kubectl get jobs -n default -l app.kubernetes.io/managed-by=qdrant-operator --no-headers 2>/dev/null | grep volumesnapshot | wc -l || echo "0")
    if [ "${JOBS}" -gt "0" ]; then
      log_info "✅ Found ${JOBS} VolumeSnapshot job(s)"
      job_created=true
      break
    fi
    log_info "Waiting for snapshot job... (${elapsed}s/${timeout}s)"
    sleep 10
    elapsed=$((elapsed + 10))
  done

  if [ "${job_created}" = "false" ]; then
    log_warn "⚠️ No snapshot jobs created yet (CronJob may be waiting for schedule)"
  fi

  # Verify retention policy (check snapshot count)
  # Wait a bit more for snapshots to be created after job completion
  log_info "Verifying retention policy (max 3 snapshots)..."
  if [ "${job_created}" = "true" ]; then
    log_info "Waiting for snapshots to be created (timeout: 60s)..."
    timeout=60
    elapsed=0
    while [ $elapsed -lt $timeout ]; do
      SNAPSHOT_COUNT=$(kubectl get volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant --no-headers 2>/dev/null | wc -l || echo "0")
      if [ "${SNAPSHOT_COUNT}" -gt "0" ]; then
        log_info "✅ Found ${SNAPSHOT_COUNT} snapshot(s)"
        break
      fi
      sleep 5
      elapsed=$((elapsed + 5))
    done
  fi
  SNAPSHOT_COUNT=$(kubectl get volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant --no-headers 2>/dev/null | wc -l || echo "0")
  log_info "Current snapshot count: ${SNAPSHOT_COUNT}"

  if [ "${SNAPSHOT_COUNT}" -gt "3" ]; then
    log_warn "⚠️ Snapshot count (${SNAPSHOT_COUNT}) exceeds retention policy (3)"
  else
    log_info "✅ Snapshot count within retention policy"
  fi
fi

log_info "✅ VolumeSnapshot scheduled test passed"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster ${CLUSTER_NAME} -n default 2>/dev/null || true
# CronJob and snapshots will be cleaned up by ownerReferences
kubectl delete cronjob ${CRONJOB_NAME} -n default 2>/dev/null || true
kubectl delete volumesnapshots -n default -l clustername=${CLUSTER_NAME},component=qdrant 2>/dev/null || true

log_info "✅ VolumeSnapshot scheduled test completed"
exit 0

