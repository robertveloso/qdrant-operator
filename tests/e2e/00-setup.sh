#!/usr/bin/env bash
# Setup: Create cluster and collection
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Setup: Creating Qdrant cluster and collection"

log_info "Creating Qdrant cluster..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml"

log_info "Waiting for operator to create StatefulSet (timeout: 60s)..."
wait_for_resource "statefulset" "my-cluster" "default" 60

log_info "Waiting for StatefulSet rollout (timeout: 120s)..."
kubectl rollout status statefulset my-cluster -n default --timeout=120s || {
  log_error "StatefulSet rollout failed"
  kubectl get pods -n default -l clustername=my-cluster
  kubectl describe statefulset my-cluster -n default
  exit 1
}

log_info "Cleaning up any existing collection (if present)..."
# First, delete the CRD (this will trigger finalizer cleanup)
kubectl delete qdrantcollections my-collection -n default --ignore-not-found=true --wait=false 2>/dev/null || true

# Also clean up the collection directly in Qdrant if it exists
# This is necessary because the operator may fail to create if collection already exists
log_info "Cleaning up collection in Qdrant (if present)..."
QDRANT_POD=$(kubectl get pod -n default -l clustername=my-cluster -o name 2>/dev/null | head -n1 | sed 's|pod/||' || echo "")
if [ -n "${QDRANT_POD}" ]; then
  # Wait for pod to be ready
  log_info "Waiting for Qdrant pod to be ready..."
  kubectl wait --for=condition=ready pod "${QDRANT_POD}" -n default --timeout=30s 2>/dev/null || true

  # Use port-forward to delete collection (Qdrant image doesn't have curl)
  log_info "Attempting to delete collection in Qdrant via port-forward..."
  kubectl port-forward -n default "pod/${QDRANT_POD}" 6333:6333 > /dev/null 2>&1 &
  PF_PID=$!
  sleep 2

  DELETE_RESPONSE=$(curl -s -X DELETE "http://localhost:6333/collections/my-collection" 2>/dev/null || echo "")
  if [ -n "${DELETE_RESPONSE}" ]; then
    log_info "Delete response: ${DELETE_RESPONSE}"
  fi

  kill "${PF_PID}" 2>/dev/null || true
  wait "${PF_PID}" 2>/dev/null || true
  sleep 2
fi

# Wait a bit for cleanup to complete
sleep 3

log_info "Creating Qdrant collection..."
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-collection-minimal.yaml"

log_info "Waiting for collection to be created..."
# Increase timeout to 60s and add diagnostics
# Note: CRD uses plural 'qdrantcollections' but kubectl accepts both
wait_for_resource "qdrantcollections" "my-collection" "default" 60 || {
  log_error "Collection not found. Checking operator status..."
  OPERATOR_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "${OPERATOR_POD}" ]; then
    log_info "Operator pod: ${OPERATOR_POD}"
    log_info "Recent operator logs:"
    kubectl logs -n qdrant-operator "${OPERATOR_POD}" --tail=50 2>/dev/null || true
  fi
  log_info "Checking if collection CRD exists:"
  kubectl get qdrantcollections -n default 2>/dev/null || true
  log_info "Checking collection events:"
  kubectl get events -n default --field-selector involvedObject.name=my-collection --sort-by='.lastTimestamp' 2>/dev/null | tail -10 || true
  exit 1
}

log_info "Waiting for collection to be ready in Qdrant..."
wait_for_collection_green "my-cluster" "my-collection" "default" 60

log_info "✅ Setup complete: cluster and collection created"

