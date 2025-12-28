#!/usr/bin/env bash
# Finalizer under load: Verify cleanup works correctly when cluster is deleted during activity
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Finalizer Under Load: Verifying cleanup during cluster activity"

# Create a new cluster and collection for this test (previous test may have deleted them)
log_info "Creating new cluster for finalizer under load test..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml"
wait_for_resource "statefulset" "my-cluster" "default" 60
kubectl rollout status statefulset my-cluster -n default --timeout=120s

log_info "Creating new collection for finalizer under load test..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-collection-minimal.yaml"
sleep 10

POD=$(get_operator_pod)
log_info "Using operator pod: ${POD}"

# Verify collection is accessible before deletion
log_info "Verifying collection is accessible before deletion..."
max_attempts=6
attempt=1
collection_ready=false

while [ $attempt -le $max_attempts ]; do
  RESULT=$(kubectl exec -n qdrant-operator "${POD}" -- \
    curl -s http://my-cluster.default:6333/collections/my-collection 2>/dev/null || echo "")

  if echo "${RESULT}" | grep -q '"status":"green"'; then
    log_info "✅ Collection is ready"
    collection_ready=true
    break
  fi

  if [ $attempt -lt $max_attempts ]; then
    log_info "Collection not ready yet, waiting 5s..."
    sleep 5
  fi
  attempt=$((attempt + 1))
done

if [ "$collection_ready" = "false" ]; then
  log_error "Collection not ready before deletion test"
  exit 1
fi

# Start light load: periodic queries to the collection (simulating activity)
log_info "Starting light load: periodic collection queries..."
(
  for i in {1..20}; do
    kubectl exec -n qdrant-operator "${POD}" -- \
      curl -s http://my-cluster.default:6333/collections/my-collection >/dev/null 2>&1 || true
    sleep 1
  done
) &
LOAD_PID=$!

# Give load a moment to start
sleep 2

# Delete cluster while under load
log_info "Deleting QdrantCollection (should trigger finalizer)..."
kubectl delete qdrantcollections my-collection -n default

log_info "Deleting QdrantCluster (should trigger finalizer while under load)..."
kubectl delete qdrantcluster my-cluster -n default

# Wait for load to finish (or timeout)
log_info "Waiting for load to complete..."
wait $LOAD_PID 2>/dev/null || true

# Wait for finalizer to complete and resource to be deleted
log_info "Waiting for finalizer to complete and cluster to be deleted (timeout: 90s)..."
wait_for_deletion "qdrantcluster" "my-cluster" "default" 90

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

log_info "✅ Finalizer and cleanup completed successfully under load"

