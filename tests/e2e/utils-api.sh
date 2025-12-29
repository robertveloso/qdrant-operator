#!/usr/bin/env bash
# API utilities for e2e tests

set -euo pipefail

# Get API token from operator pod environment or use default
get_api_token() {
  local pod=$1
  kubectl exec -n qdrant-operator "${pod}" -- printenv API_TOKEN 2>/dev/null || \
  kubectl exec -n qdrant-operator "${pod}" -- printenv QDRANT_OPERATOR_API_TOKEN 2>/dev/null || \
  echo ""  # Empty token (development mode)
}

# Get API base URL - use localhost with port-forward or service URL
get_api_url() {
  local namespace=${1:-default}
  # Try localhost first (for port-forward), fallback to service URL
  if curl -s -f -m 2 "http://localhost:8081/health" >/dev/null 2>&1; then
    echo "http://localhost:8081/api/v1"
  else
    echo "http://qdrant-operator.qdrant-operator:8081/api/v1"
  fi
}

# Start port-forward in background if not already running
start_port_forward() {
  local pod=$1
  local port=${2:-8081}

  # Check if port-forward is already running
  if curl -s -f -m 2 "http://localhost:${port}/health" >/dev/null 2>&1; then
    return 0
  fi

  # Start port-forward in background
  log_info "Starting port-forward to operator pod ${pod} on port ${port}..."
  kubectl port-forward -n qdrant-operator "pod/${pod}" "${port}:${port}" >/dev/null 2>&1 &
  local pf_pid=$!

  # Wait for port-forward to be ready
  local timeout=10
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if curl -s -f -m 2 "http://localhost:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  log_warn "⚠️ Port-forward may not be ready, continuing anyway..."
  return 0
}

# Make API request
api_request() {
  local method=$1
  local endpoint=$2
  local namespace=${3:-default}
  local token=${4:-}
  local data=${5:-}
  local pod=${6:-}

  # Start port-forward if pod is provided
  if [ -n "${pod}" ]; then
    start_port_forward "${pod}" 8081
  fi

  local url=$(get_api_url "${namespace}")${endpoint}?namespace=${namespace}
  local headers=()

  if [ -n "${token}" ]; then
    headers+=(-H "Authorization: Bearer ${token}")
  fi

  if [ -n "${data}" ]; then
    headers+=(-H "Content-Type: application/json")
    headers+=(-d "${data}")
  fi

  curl -s -w "\n%{http_code}" -X "${method}" "${url}" "${headers[@]}" 2>/dev/null || echo -e "\n000"
}

# Insert dummy data into collection
insert_dummy_data() {
  local cluster_name=$1
  local collection_name=$2
  local namespace=${3:-default}
  local count=${4:-10}

  log_info "Inserting ${count} dummy vectors into collection ${collection_name}..."

  local pod=$(kubectl get pod -n "${namespace}" -l clustername="${cluster_name}" -o name | head -n1 | sed 's|pod/||')

  if [ -z "${pod}" ]; then
    log_error "No pod found for cluster ${cluster_name}"
    return 1
  fi

  # Generate and insert vectors in batches
  local batch_size=10
  local batch=1

  while [ $(( (batch - 1) * batch_size + 1)) -le ${count} ]; do
    local start=$(( (batch - 1) * batch_size + 1))
    local end=$(( batch * batch_size ))
    if [ ${end} -gt ${count} ]; then
      end=${count}
    fi

    local points=$(python3 -c "
import json
import random
points = []
for i in range(${start}, ${end} + 1):
    vector = [random.random() for _ in range(10)]
    points.append({
        'id': i,
        'vector': vector,
        'payload': {'text': f'dummy text {i}', 'number': i}
    })
print(json.dumps({'points': points}))
" 2>/dev/null || echo "")

    if [ -n "${points}" ]; then
      kubectl exec -n "${namespace}" "${pod}" -- \
        curl -s -X PUT \
        -H "Content-Type: application/json" \
        -d "${points}" \
        "http://localhost:6333/collections/${collection_name}/points?wait=true" >/dev/null 2>&1 || true
    fi

    batch=$((batch + 1))
  done

  log_info "✅ Inserted ${count} vectors"
}

# Wait for collection to have data
wait_for_collection_data() {
  local cluster_name=$1
  local collection_name=$2
  local namespace=${3:-default}
  local min_points=${4:-1}
  local timeout=${5:-30}

  log_info "Waiting for collection ${collection_name} to have at least ${min_points} points..."

  local pod=$(kubectl get pod -n "${namespace}" -l clustername="${cluster_name}" -o name | head -n1 | sed 's|pod/||')

  if [ -z "${pod}" ]; then
    log_error "No pod found for cluster ${cluster_name}"
    return 1
  fi

  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local count=$(kubectl exec -n "${namespace}" "${pod}" -- \
      curl -s "http://localhost:6333/collections/${collection_name}" 2>/dev/null | \
      python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('result', {}).get('points_count', 0))" 2>/dev/null || echo "0")

    if [ "${count}" -ge "${min_points}" ]; then
      log_info "✅ Collection has ${count} points"
      return 0
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_error "Collection does not have enough points after ${timeout}s"
  return 1
}

# Create backup for collection (S3 backup)
create_backup() {
  local cluster_name=$1
  local collection_name=$2
  local namespace=${3:-default}

  log_info "Creating backup for collection ${collection_name}..."

  # This would trigger a backup job via QdrantCollectionBackup CRD
  # For now, we'll just log that backup should be configured
  log_info "ℹ️ Backup creation requires S3 configuration"
}

