#!/usr/bin/env bash
# Common utilities for e2e tests

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${GREEN}ℹ️  $*${NC}"
}

log_warn() {
  echo -e "${YELLOW}⚠️  $*${NC}"
}

log_error() {
  echo -e "${RED}❌ $*${NC}"
}

log_test() {
  echo -e "\n${GREEN}🧪 $*${NC}\n"
}

# Wait for resource to exist
wait_for_resource() {
  local resource_type=$1
  local resource_name=$2
  local namespace=${3:-default}
  local timeout=${4:-60}

  log_info "Waiting for ${resource_type}/${resource_name} in namespace ${namespace} (timeout: ${timeout}s)..."

  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if kubectl get "${resource_type}" "${resource_name}" -n "${namespace}" 2>/dev/null; then
      log_info "${resource_type}/${resource_name} exists!"
      return 0
    fi
    echo "   Waiting... (${elapsed}s/${timeout}s)"
    sleep 5
    elapsed=$((elapsed + 5))
  done

  log_error "${resource_type}/${resource_name} not found within timeout"
  return 1
}

# Wait for resource to be deleted
wait_for_deletion() {
  local resource_type=$1
  local resource_name=$2
  local namespace=${3:-default}
  local timeout=${4:-60}

  log_info "Waiting for ${resource_type}/${resource_name} to be deleted (timeout: ${timeout}s)..."

  kubectl wait --for=delete "${resource_type}" "${resource_name}" -n "${namespace}" --timeout="${timeout}s" || {
    log_error "${resource_type}/${resource_name} still exists after timeout"
    return 1
  }

  log_info "${resource_type}/${resource_name} deleted successfully"
  return 0
}

# Get operator pod name
get_operator_pod() {
  kubectl get pod -n qdrant-operator -l app=qdrant-operator -o name | head -n1 | sed 's|pod/||'
}

# Check if operator is leader
is_operator_leader() {
  local pod=$1
  kubectl logs -n qdrant-operator "${pod}" --tail=10 2>/dev/null | grep -q "LEADER"
}

