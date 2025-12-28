#!/usr/bin/env bash
# Finalizer: Verify proper cleanup when cluster is deleted
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Finalizer: Verifying proper cleanup on cluster deletion"

log_info "Deleting QdrantCollection first (if it exists)..."
kubectl delete qdrantcollection my-collection -n default 2>/dev/null || true

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
PODS=$(kubectl get pods -n default -l clustername=my-cluster 2>/dev/null | grep -v "No resources found" || true)
if [ -n "${PODS}" ]; then
  log_error "Pods still exist after cluster deletion"
  kubectl get pods -n default -l clustername=my-cluster
  exit 1
fi

log_info "Verifying collection was cleaned up..."
if kubectl get qdrantcollection my-collection -n default 2>/dev/null; then
  log_error "Collection still exists after deletion"
  kubectl get qdrantcollection my-collection -n default -o yaml
  exit 1
fi

log_info "✅ Finalizer and cleanup completed successfully"
exit 0

