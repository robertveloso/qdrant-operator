#!/usr/bin/env bash
# Finalizer: Verify proper cleanup when cluster is deleted
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Finalizer: Verifying proper cleanup on cluster deletion"

log_info "Deleting QdrantCollection first (if it exists)..."
kubectl delete qdrantcollections my-collection -n default 2>/dev/null || true

log_info "Waiting for collection to be deleted..."
sleep 5

log_info "Deleting QdrantCluster (should trigger finalizer)..."
kubectl delete qdrantcluster my-cluster -n default

log_info "Waiting for finalizer to complete and resource to be deleted (timeout: 60s)..."
wait_for_deletion "qdrantcluster" "my-cluster" "default" 60

log_info "Verifying StatefulSet was cleaned up..."
if kubectl get sts my-cluster -n default 2>/dev/null; then
  log_error "StatefulSet still exists after cluster deletion"
  kubectl get sts my-cluster -n default -o yaml
  exit 1
fi

log_info "Verifying pods were cleaned up..."
# Pods in "Terminating" state are acceptable - they will be removed by GC
# We only care that no pods are Running or Ready
timeout=60
elapsed=0
pods_cleaned=false

while [ $elapsed -lt $timeout ]; do
  # Get pods and filter out header and "No resources found"
  PODS_OUTPUT=$(kubectl get pods -n default -l clustername=my-cluster 2>/dev/null | grep -v "No resources found" | grep -v "NAME" || true)

  if [ -z "${PODS_OUTPUT}" ]; then
    # No pods found at all - perfect!
    log_info "✅ All pods deleted successfully"
    pods_cleaned=true
    break
  fi

  # Check if any pods are in Running state (not Terminating)
  RUNNING_PODS=$(echo "${PODS_OUTPUT}" | grep -v "Terminating" | grep -v "Succeeded" | grep -v "Failed" || true)

  if [ -z "${RUNNING_PODS}" ]; then
    # All pods are Terminating, Succeeded, or Failed - this is acceptable
    log_info "✅ All pods are in Terminating/Succeeded/Failed state (GC will remove them)"
    pods_cleaned=true
    break
  fi

  echo "   Waiting for pods to stop running... (${elapsed}s/${timeout}s)"
  echo "   Running pods found:"
  echo "${RUNNING_PODS}" | while read -r line; do
    echo "     ${line}"
  done
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "${pods_cleaned}" = "false" ]; then
  log_error "Pods still running after cluster deletion (timeout: ${timeout}s)"
  kubectl get pods -n default -l clustername=my-cluster
  exit 1
fi

log_info "Verifying collection was cleaned up..."
if kubectl get qdrantcollections my-collection -n default 2>/dev/null; then
  log_error "Collection still exists after deletion"
  kubectl get qdrantcollections my-collection -n default -o yaml
  exit 1
fi

log_info "✅ Finalizer and cleanup completed successfully"
exit 0

