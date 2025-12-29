#!/usr/bin/env bash
# Metrics Validation: Verify operator exposes metrics correctly
# This test validates that /metrics endpoint works and counters increase as expected
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Metrics Validation: Verifying operator metrics endpoint and counters"

# Get operator pod
OPERATOR_POD=$(get_operator_pod)
if [ -z "${OPERATOR_POD}" ]; then
  log_error "Operator pod not found"
  exit 1
fi

NAMESPACE="qdrant-operator"
METRICS_PORT=8080
LOCAL_PORT=8082

# Function to get metrics via port-forward
get_metrics() {
  local port=$1
  curl -s "http://localhost:${port}/metrics" 2>/dev/null || echo ""
}

# Function to extract metric value from Prometheus format
extract_metric_value() {
  local metrics=$1
  local metric_name=$2
  local labels=${3:-}

  if [ -n "${labels}" ]; then
    # Extract metric with specific labels (e.g., qdrant_operator_reconcile_total{resource_type="cluster",result="success"} 5)
    echo "${metrics}" | grep "^${metric_name}${labels}" | awk '{print $NF}' | head -1 || echo "0"
  else
    # Extract metric without labels
    echo "${metrics}" | grep "^${metric_name} " | awk '{print $NF}' | head -1 || echo "0"
  fi
}

# Function to sum all values for a metric (handles multiple label combinations)
sum_metric_values() {
  local metrics=$1
  local metric_name=$2

  echo "${metrics}" | grep "^${metric_name}" | awk '{sum += $NF} END {print sum+0}' || echo "0"
}

log_info "Setting up port-forward to operator metrics endpoint..."
kubectl port-forward -n "${NAMESPACE}" "pod/${OPERATOR_POD}" "${LOCAL_PORT}:${METRICS_PORT}" > /dev/null 2>&1 &
PORT_FORWARD_PID=$!

# Wait for port-forward to be ready
log_info "Waiting for port-forward to be ready..."
timeout=10
elapsed=0
while [ $elapsed -lt $timeout ]; do
  if curl -s "http://localhost:${LOCAL_PORT}/metrics" > /dev/null 2>&1; then
    log_info "✅ Port-forward is ready"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ $elapsed -ge $timeout ]; then
  log_error "Port-forward failed to become ready"
  exit 1
fi

# Cleanup function
cleanup() {
  if [ -n "${PORT_FORWARD_PID}" ]; then
    kill "${PORT_FORWARD_PID}" 2>/dev/null || true
    wait "${PORT_FORWARD_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Step 1: Verify /metrics endpoint is accessible
log_info "Step 1: Verifying /metrics endpoint is accessible..."

METRICS_RESPONSE=$(get_metrics "${LOCAL_PORT}")
if [ -z "${METRICS_RESPONSE}" ]; then
  log_error "Failed to fetch metrics from /metrics endpoint"
  exit 1
fi

log_info "✅ /metrics endpoint is accessible"

# Step 2: Verify key counters exist
log_info "Step 2: Verifying key counters exist..."

if ! echo "${METRICS_RESPONSE}" | grep -q "^qdrant_operator_reconcile_total"; then
  log_error "Metric qdrant_operator_reconcile_total not found"
  echo "Available metrics:"
  echo "${METRICS_RESPONSE}" | grep "^qdrant_operator" | head -10
  exit 1
fi

if ! echo "${METRICS_RESPONSE}" | grep -q "^qdrant_operator_errors_total"; then
  log_error "Metric qdrant_operator_errors_total not found"
  echo "Available metrics:"
  echo "${METRICS_RESPONSE}" | grep "^qdrant_operator" | head -10
  exit 1
fi

log_info "✅ Key counters exist (reconcile_total, errors_total)"

# Step 3: Get initial metric values
log_info "Step 3: Recording initial metric values..."

INITIAL_METRICS=$(get_metrics "${LOCAL_PORT}")
INITIAL_RECONCILE_TOTAL=$(sum_metric_values "${INITIAL_METRICS}" "qdrant_operator_reconcile_total")
INITIAL_ERRORS_TOTAL=$(sum_metric_values "${INITIAL_METRICS}" "qdrant_operator_errors_total")

log_info "Initial metrics:"
log_info "  reconcile_total: ${INITIAL_RECONCILE_TOTAL}"
log_info "  errors_total: ${INITIAL_ERRORS_TOTAL}"

# Step 4: Trigger reconciliations by creating/updating resources
log_info "Step 4: Triggering reconciliations to increase reconcile_total..."

CLUSTER_NAME="metrics-test-cluster"

# Create cluster (should trigger reconciliation)
log_info "Creating cluster to trigger reconciliation..."
cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: default
spec:
  replicas: 1
  image: qdrant/qdrant:v1.16.3
EOF

wait_for_resource "statefulset" "${CLUSTER_NAME}" "default" 60
kubectl rollout status statefulset ${CLUSTER_NAME} -n default --timeout=120s
wait_for_cluster_healthy "${CLUSTER_NAME}" "default" 60

log_info "✅ Cluster created"

# Update cluster (should trigger another reconciliation)
log_info "Updating cluster to trigger another reconciliation..."
kubectl patch qdrantcluster ${CLUSTER_NAME} -n default --type='merge' -p='{"metadata":{"annotations":{"test-metrics-trigger":"'$(date +%s)'"}}}' || true

# Wait a bit for reconciliation to complete
sleep 10

# Step 5: Verify reconcile_total increased
log_info "Step 5: Verifying reconcile_total increased..."

FINAL_METRICS=$(get_metrics "${LOCAL_PORT}")
FINAL_RECONCILE_TOTAL=$(sum_metric_values "${FINAL_METRICS}" "qdrant_operator_reconcile_total")
FINAL_ERRORS_TOTAL=$(sum_metric_values "${FINAL_METRICS}" "qdrant_operator_errors_total")

log_info "Final metrics:"
log_info "  reconcile_total: ${FINAL_RECONCILE_TOTAL}"
log_info "  errors_total: ${FINAL_ERRORS_TOTAL}"

# Verify reconcile_total increased
if [ "${FINAL_RECONCILE_TOTAL}" -le "${INITIAL_RECONCILE_TOTAL}" ]; then
  log_error "reconcile_total did not increase: ${INITIAL_RECONCILE_TOTAL} -> ${FINAL_RECONCILE_TOTAL}"
  log_info "Metrics dump:"
  echo "${FINAL_METRICS}" | grep "^qdrant_operator_reconcile_total" || true
  exit 1
fi

RECONCILE_INCREASE=$((FINAL_RECONCILE_TOTAL - INITIAL_RECONCILE_TOTAL))
log_info "✅ reconcile_total increased by ${RECONCILE_INCREASE} (${INITIAL_RECONCILE_TOTAL} -> ${FINAL_RECONCILE_TOTAL})"

# Step 6: Verify errors_total did not explode
log_info "Step 6: Verifying errors_total did not explode..."

ERROR_INCREASE=$((FINAL_ERRORS_TOTAL - INITIAL_ERRORS_TOTAL))

# Allow some errors (e.g., transient network issues), but not too many
# Threshold: more than 10 errors during test is suspicious
if [ "${ERROR_INCREASE}" -gt 10 ]; then
  log_error "errors_total increased too much: ${INITIAL_ERRORS_TOTAL} -> ${FINAL_ERRORS_TOTAL} (increase: ${ERROR_INCREASE})"
  log_info "This may indicate a problem. Checking error metrics:"
  echo "${FINAL_METRICS}" | grep "^qdrant_operator_errors_total" || true
  exit 1
fi

if [ "${ERROR_INCREASE}" -gt 0 ]; then
  log_warn "⚠️ errors_total increased by ${ERROR_INCREASE} (${INITIAL_ERRORS_TOTAL} -> ${FINAL_ERRORS_TOTAL})"
  log_warn "This is acceptable if errors are transient, but should be monitored"
else
  log_info "✅ errors_total did not increase (${INITIAL_ERRORS_TOTAL} -> ${FINAL_ERRORS_TOTAL})"
fi

# Step 7: Verify other important metrics exist
log_info "Step 7: Verifying other important metrics exist..."

if ! echo "${FINAL_METRICS}" | grep -q "^qdrant_operator_reconcile_duration_seconds"; then
  log_warn "⚠️ Metric qdrant_operator_reconcile_duration_seconds not found (optional)"
fi

if ! echo "${FINAL_METRICS}" | grep -q "^qdrant_operator_clusters_managed"; then
  log_warn "⚠️ Metric qdrant_operator_clusters_managed not found (optional)"
fi

if ! echo "${FINAL_METRICS}" | grep -q "^qdrant_operator_leader"; then
  log_warn "⚠️ Metric qdrant_operator_leader not found (optional)"
fi

log_info "✅ Metrics validation passed!"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcluster ${CLUSTER_NAME} -n default --wait=true 2>/dev/null || true

log_info "✅ Metrics test passed!"
exit 0

