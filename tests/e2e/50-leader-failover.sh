#!/usr/bin/env bash
# Leader failover: Verify HA behavior when leader pod is deleted
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Leader Failover: Verifying HA behavior when leader is deleted"

POD=$(get_operator_pod)
log_info "Current operator pod: ${POD}"

# Verify it's the leader before deletion
if ! is_operator_leader "${POD}"; then
  log_warn "Current pod is not leader, skipping failover test"
  exit 0
fi

log_info "Deleting leader pod to trigger failover..."
kubectl delete pod "${POD}" -n qdrant-operator

log_info "Waiting for new pod to be ready (timeout: 60s)..."
kubectl wait --for=condition=ready pod -l app=qdrant-operator -n qdrant-operator --timeout=60s || {
  log_error "New pod not ready after timeout"
  kubectl get pods -n qdrant-operator -l app=qdrant-operator
  exit 1
}

log_info "Waiting for new leader to be elected (timeout: 30s)..."
timeout=30
elapsed=0
NEW_POD=""

while [ $elapsed -lt $timeout ]; do
  NEW_POD=$(get_operator_pod)

  if [ -n "${NEW_POD}" ] && is_operator_leader "${NEW_POD}"; then
    log_info "✅ New leader elected: ${NEW_POD}"
    exit 0
  fi

  log_info "Waiting for leader election... (${elapsed}s/${timeout}s)"
  sleep 5
  elapsed=$((elapsed + 5))
done

log_error "New leader not elected within timeout"
log_info "Operator logs:"
kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=50 || true
exit 1

