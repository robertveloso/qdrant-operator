#!/usr/bin/env bash
# Drift detection: Verify operator corrects manual changes
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Drift Detection: Verifying operator corrects manual changes"

log_info "Forcing drift: scaling StatefulSet to 0 replicas..."
kubectl scale sts my-cluster -n default --replicas=0

log_info "Waiting for operator to detect and correct drift (timeout: 60s)..."
# Wait for replicas to be restored to 1
wait_for_status "statefulset" "my-cluster" "{.spec.replicas}" "1" "default" 60

log_info "✅ Drift corrected! Operator restored replicas to 1"

# Verify StatefulSet is stable (check that it doesn't change back)
log_info "Verifying StatefulSet is stable..."
timeout=10
elapsed=0
stable=true
while [ $elapsed -lt $timeout ]; do
  replicas=$(kubectl get sts my-cluster -n default -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
  if [ "${replicas}" != "1" ]; then
    log_error "StatefulSet replicas changed to ${replicas} (expected: 1)"
    stable=false
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

if [ "${stable}" = "true" ]; then
  log_info "✅ Drift detection test passed"
  exit 0
fi

log_error "Drift was not corrected within timeout"
log_info "StatefulSet spec:"
kubectl get sts my-cluster -n default -o yaml || true
log_info "Operator logs:"
kubectl logs -n qdrant-operator deploy/qdrant-operator --tail=50 || true
exit 1

