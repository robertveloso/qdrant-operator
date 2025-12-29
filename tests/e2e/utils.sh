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
    # Check if resource type exists (CRD might not be installed)
    if ! kubectl api-resources --namespaced=true 2>/dev/null | grep -q "^${resource_type}"; then
      if [ $elapsed -eq 0 ]; then
        log_warn "⚠️ Resource type '${resource_type}' not found in API. Checking CRDs..."
        kubectl get crd | grep -i "${resource_type}" || true
      fi
    fi
    echo "   Waiting... (${elapsed}s/${timeout}s)"
    sleep 5
    elapsed=$((elapsed + 5))
  done

  log_error "${resource_type}/${resource_name} not found within timeout"
  # Add diagnostics
  log_info "Diagnostics:"
  log_info "  Checking if resource type exists:"
  kubectl api-resources | grep -i "${resource_type}" || log_warn "  Resource type '${resource_type}' not found in API"
  log_info "  Checking all resources of this type in namespace:"
  kubectl get "${resource_type}" -n "${namespace}" 2>/dev/null || log_warn "  Cannot list ${resource_type} in namespace ${namespace}"
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

# Wait for cluster to be healthy
wait_for_cluster_healthy() {
  local cluster_name=$1
  local namespace=${2:-default}
  local timeout=${3:-60}

  log_info "Waiting for cluster ${cluster_name} to be Healthy (timeout: ${timeout}s)..."

  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status=$(kubectl get qdrantcluster "${cluster_name}" -n "${namespace}" -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
    if [ "${status}" = "Healthy" ] || [ "${status}" = "Running" ]; then
      log_info "✅ Cluster is ${status}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_error "Cluster ${cluster_name} did not become Healthy within timeout"
  kubectl get qdrantcluster "${cluster_name}" -n "${namespace}" -o yaml
  return 1
}

# Wait for collection to be green in Qdrant
wait_for_collection_green() {
  local cluster_name=$1
  local collection_name=$2
  local namespace=${3:-default}
  local timeout=${4:-60}

  log_info "Waiting for collection ${collection_name} to be green in Qdrant (timeout: ${timeout}s)..."

  local pod=$(kubectl get pod -n "${namespace}" -l clustername="${cluster_name}" -o name | head -n1 | sed 's|pod/||')
  if [ -z "${pod}" ]; then
    log_error "No pod found for cluster ${cluster_name}"
    kubectl get pods -n "${namespace}" -l clustername="${cluster_name}"
    return 1
  fi

  log_info "Using Qdrant pod: ${pod}"

  # Wait for pod to be ready
  local pod_ready=false
  local wait_elapsed=0
  while [ $wait_elapsed -lt 30 ]; do
    local pod_status=$(kubectl get pod "${pod}" -n "${namespace}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [ "${pod_status}" = "Running" ]; then
      local ready=$(kubectl get pod "${pod}" -n "${namespace}" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "false")
      if [ "${ready}" = "true" ]; then
        pod_ready=true
        break
      fi
    fi
    sleep 2
    wait_elapsed=$((wait_elapsed + 2))
  done

  if [ "${pod_ready}" = "false" ]; then
    log_warn "⚠️ Pod ${pod} may not be ready yet, but continuing..."
  fi

  local elapsed=0
  local last_status=""
  local last_response=""
  while [ $elapsed -lt $timeout ]; do
    # Try to get collection status from Qdrant API
    # Use timeout to avoid hanging
    local response=$(kubectl exec -n "${namespace}" "${pod}" -- \
      timeout 5 curl -s "http://localhost:6333/collections/${collection_name}" 2>/dev/null || echo "")
    last_response="${response}"

    if [ -n "${response}" ]; then
      # Check if response contains error
      if echo "${response}" | grep -q '"error"'; then
        local error_msg=$(echo "${response}" | grep -o '"error":"[^"]*"' | cut -d'"' -f4 || echo "")
        if echo "${error_msg}" | grep -q "doesn't exist\|not found"; then
          # Collection doesn't exist yet, continue waiting
          if [ $((elapsed % 10)) -eq 0 ]; then
            log_info "Collection doesn't exist yet, waiting... (${elapsed}s/${timeout}s)"
          fi
        else
          # Other error
          log_warn "⚠️ Qdrant API returned error: ${error_msg}"
        fi
      else
        # Try to extract status
        local status=$(echo "${response}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "")
        last_status="${status}"

        if [ "${status}" = "green" ]; then
          log_info "✅ Collection is green"
          return 0
        fi

        # Log status every 10 seconds
        if [ $((elapsed % 10)) -eq 0 ] && [ -n "${status}" ]; then
          log_info "Collection status: ${status} (${elapsed}s/${timeout}s)"
        fi
      fi
    else
      # If curl fails, try to check if collection exists by listing all collections
      if [ $((elapsed % 10)) -eq 0 ]; then
        log_warn "⚠️ Could not query collection status, checking if collection exists..."
        local collections_list=$(kubectl exec -n "${namespace}" "${pod}" -- \
          timeout 5 curl -s "http://localhost:6333/collections" 2>/dev/null || echo "")
        if echo "${collections_list}" | grep -q "${collection_name}"; then
          log_info "Collection ${collection_name} exists in Qdrant, but status query failed"
        else
          log_info "Collection ${collection_name} not found in Qdrant yet"
        fi
      fi
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_error "Collection ${collection_name} did not become green within timeout"
  log_info "Diagnostics:"
  log_info "  Last status: ${last_status:-unknown}"
  log_info "  Last response: ${last_response:-none}"
  log_info "  Collection CRD:"
  kubectl get qdrantcollections "${collection_name}" -n "${namespace}" -o yaml 2>/dev/null | head -30 || true
  log_info "  Qdrant pod status:"
  kubectl get pod "${pod}" -n "${namespace}" -o yaml 2>/dev/null | grep -A 10 "status:" || true
  log_info "  Attempting to get collection info from Qdrant:"
  kubectl exec -n "${namespace}" "${pod}" -- \
    timeout 5 curl -s "http://localhost:6333/collections/${collection_name}" 2>/dev/null || log_warn "  Failed to query Qdrant API"
  log_info "  Listing all collections in Qdrant:"
  kubectl exec -n "${namespace}" "${pod}" -- \
    timeout 5 curl -s "http://localhost:6333/collections" 2>/dev/null | head -20 || log_warn "  Failed to list collections"
  log_info "  Operator logs (last 50 lines, filtered for collection):"
  OPERATOR_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "${OPERATOR_POD}" ]; then
    kubectl logs -n qdrant-operator "${OPERATOR_POD}" --tail=50 2>/dev/null | grep -i "collection\|${collection_name}" || log_warn "  No collection-related logs found"
  fi
  return 1
}

# Check if operator pod is leader by checking Lease directly
# This is more reliable than checking logs
check_lease_leader() {
  local pod=$1
  local namespace=${2:-qdrant-operator}
  local lease_name=${3:-qdrant-operator}

  local holder=$(kubectl get lease "${lease_name}" -n "${namespace}" -o jsonpath='{.spec.holderIdentity}' 2>/dev/null || echo "")

  if [ "${holder}" = "${pod}" ]; then
    return 0  # Is leader
  else
    return 1  # Not leader
  fi
}

# Wait for operator to become leader
# Uses Lease as primary source, falls back to logs if Lease check fails
# NOTE: Log-based detection is fragile (see TECHNICAL_DEBT.md)
# TODO: Add metric-based detection (operator_leader{pod=...} 1)
wait_for_operator_leader() {
  local pod=$1
  local timeout=${2:-30}
  local namespace=${3:-qdrant-operator}
  local lease_name=${4:-qdrant-operator}

  log_info "Waiting for operator to become leader (timeout: ${timeout}s)..."

  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    # Try Lease first (more reliable)
    if check_lease_leader "${pod}" "${namespace}" "${lease_name}"; then
      log_info "✅ Operator is LEADER! (verified via Lease)"
      return 0
    fi

    # Fallback to logs (fragile, but works if Lease check fails)
    if kubectl logs -n "${namespace}" "${pod}" --tail=10 2>/dev/null | grep -q "LEADER"; then
      log_info "✅ Operator is LEADER! (verified via logs - less reliable)"
      return 0
    fi

    echo "   Waiting for operator to become leader... (${elapsed}s/${timeout}s)"
    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_warn "⚠️ Warning: Operator may not be leader yet, but continuing..."
  return 0
}

# Wait for resource status to match expected value
wait_for_status() {
  local resource_type=$1
  local resource_name=$2
  local status_path=$3
  local expected_status=$4
  local namespace=${5:-default}
  local timeout=${6:-60}

  log_info "Waiting for ${resource_type}/${resource_name} status to be ${expected_status} (timeout: ${timeout}s)..."

  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local status=$(kubectl get "${resource_type}" "${resource_name}" -n "${namespace}" -o jsonpath="${status_path}" 2>/dev/null || echo "")
    if [ "${status}" = "${expected_status}" ]; then
      log_info "✅ Status is ${expected_status}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_error "${resource_type}/${resource_name} status did not become ${expected_status} within timeout (current: ${status})"
  return 1
}

# Check if operator is leader
# Uses Lease as primary source, falls back to logs if Lease check fails
# NOTE: Log-based detection is fragile (see TECHNICAL_DEBT.md)
# TODO: Add metric-based detection (operator_leader{pod=...} 1)
is_operator_leader() {
  local pod=$1
  local namespace=${2:-qdrant-operator}
  local lease_name=${3:-qdrant-operator}

  # Try Lease first (more reliable)
  if check_lease_leader "${pod}" "${namespace}" "${lease_name}"; then
    return 0
  fi

  # Fallback to logs (fragile, but works if Lease check fails)
  kubectl logs -n "${namespace}" "${pod}" --tail=10 2>/dev/null | grep -q "LEADER"
}

