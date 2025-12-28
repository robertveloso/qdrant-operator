#!/usr/bin/env bash
# Happy path: Verify collection is accessible and healthy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Happy Path: Verifying collection is accessible and healthy"

POD=$(get_operator_pod)
log_info "Using operator pod: ${POD}"

max_attempts=6
attempt=1

while [ $attempt -le $max_attempts ]; do
  log_info "Attempt ${attempt}/${max_attempts}: Checking collection status..."

  RESULT=$(kubectl exec -n qdrant-operator "${POD}" -- \
    curl -s http://my-cluster.default:6333/collections/my-collection 2>/dev/null || echo "")

  echo "Response: ${RESULT}"

  if echo "${RESULT}" | grep -q '"status":"green"'; then
    log_info "✅ Collection is green and healthy!"
    exit 0
  fi

  if [ $attempt -lt $max_attempts ]; then
    log_info "Collection not ready yet, waiting 5s..."
    sleep 5
  fi

  attempt=$((attempt + 1))
done

log_error "Collection never became green after ${max_attempts} attempts"
log_info "Collection status:"
kubectl get qdrantcollection my-collection -n default -o yaml || true
exit 1

