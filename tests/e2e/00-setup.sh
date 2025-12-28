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
sleep 10

log_info "✅ Setup complete: cluster and collection created"

