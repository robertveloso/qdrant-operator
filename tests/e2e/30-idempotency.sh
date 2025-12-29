#!/usr/bin/env bash
# Idempotency: Verify operator doesn't trigger unnecessary rollouts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Idempotency: Verifying operator doesn't trigger unnecessary rollouts"

log_info "Recording initial StatefulSet generation..."
GEN1=$(kubectl get sts my-cluster -n default -o jsonpath='{.metadata.generation}')
log_info "Initial generation: ${GEN1}"

log_info "Observing reconciliation behavior (checking every 5s for 30s)..."
# Check periodically to ensure generation doesn't change
timeout=30
elapsed=0
while [ $elapsed -lt $timeout ]; do
  GEN2=$(kubectl get sts my-cluster -n default -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "")
  if [ "${GEN1}" != "${GEN2}" ]; then
    log_error "StatefulSet generation changed from ${GEN1} to ${GEN2} after ${elapsed}s"
    log_error "This indicates a rollout was triggered without spec changes"
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done

log_info "Final generation: ${GEN2}"

if [ "${GEN1}" != "${GEN2}" ]; then
  log_error "StatefulSet generation changed from ${GEN1} to ${GEN2}"
  log_error "This indicates a rollout was triggered without spec changes"
  log_info "StatefulSet spec:"
  kubectl get sts my-cluster -n default -o yaml || true
  log_info "Operator logs:"
  kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=50 || true
  exit 1
fi

log_info "✅ Reconciliation is idempotent (generation unchanged: ${GEN1})"
exit 0

