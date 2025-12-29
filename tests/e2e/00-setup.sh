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

