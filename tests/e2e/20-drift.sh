#!/usr/bin/env bash
# Drift detection: Verify operator corrects manual changes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Drift Detection: Verifying operator corrects manual changes"

log_info "Forcing drift: scaling StatefulSet to 0 replicas..."
kubectl scale sts my-cluster -n default --replicas=0

log_info "Waiting for operator to detect and correct drift (timeout: 60s)..."
timeout=60
elapsed=0

while [ $elapsed -lt $timeout ]; do
  replicas=$(kubectl get sts my-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")

  log_info "Current replicas: ${replicas} (expected: 1)"

  if [ "${replicas}" = "1" ]; then
    log_info "✅ Drift corrected! Operator restored replicas to 1"

    # Wait a bit more to ensure StatefulSet is stable
    sleep 5
    log_info "✅ Drift detection test passed"
    exit 0
  fi

  sleep 5
  elapsed=$((elapsed + 5))
done

log_error "Drift was not corrected within timeout"
log_info "StatefulSet spec:"
kubectl get sts my-cluster -n default -o yaml || true
log_info "Operator logs:"
kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=50 || true
exit 1

