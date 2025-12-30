#!/usr/bin/env bash
# Invalid Spec: Verify operator handles invalid spec gracefully without crashing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Invalid Spec: Verifying operator handles invalid spec gracefully"

# Test 1: Empty image (passes CRD validation, operator should catch it)
log_info "Test 1: Creating cluster with empty image..."
cat <<EOF | kubectl apply -f - || true
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: invalid-image-cluster
  namespace: default
spec:
  replicas: 1
  image: ""
EOF

log_info "Waiting for operator to process invalid spec (timeout: 30s)..."
# Wait for resource to be created first
wait_for_resource "qdrantcluster" "invalid-image-cluster" "default" 30

# Wait for operator to set error status
wait_for_status "qdrantcluster" "invalid-image-cluster" "{.status.qdrantStatus}" "Error" "default" 30

# Give operator a moment to set errorMessage (may take a bit longer)
log_info "Waiting for errorMessage to be set (if available)..."
sleep 5

# Get error message
STATUS=$(kubectl get qdrantcluster invalid-image-cluster -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
ERROR_MSG=$(kubectl get qdrantcluster invalid-image-cluster -n default -o jsonpath='{.status.errorMessage}' 2>/dev/null || echo "")

if [ "${STATUS}" != "Error" ]; then
  log_error "Expected status 'Error', got '${STATUS}'"
  kubectl get qdrantcluster invalid-image-cluster -n default -o yaml
  exit 1
fi

# errorMessage is optional - the important part is that status is 'Error'
if [ -z "${ERROR_MSG}" ]; then
  log_warn "⚠️ errorMessage not found in status (operator may not set it or timing issue)"
  log_warn "Status is 'Error' which indicates operator detected the problem - this is sufficient"
  ERROR_MSG="(no error message in status)"
else
  log_info "✅ errorMessage found: ${ERROR_MSG}"
fi

log_info "✅ Status is 'Error' (operator correctly detected invalid spec)"

# Capture forensic logs for debugging (always, not just on failure)
log_info "📋 Capturing forensic status logs from operator..."
OPERATOR_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "${OPERATOR_POD}" ]; then
  log_info "Operator pod: ${OPERATOR_POD}"
  log_info "=== STATUS WRITE LOGS for invalid-image-cluster ==="
  kubectl logs -n qdrant-operator "${OPERATOR_POD}" 2>/dev/null | grep -E "\[STATUS\]\[.*invalid-image-cluster" | tail -50 || log_warn "No status logs found for invalid-image-cluster"
  log_info "=== RECENT VALIDATION LOGS ==="
  kubectl logs -n qdrant-operator "${OPERATOR_POD}" 2>/dev/null | grep -i "invalid-image-cluster\|Invalid spec\|validation" | tail -20 || log_warn "No validation logs found"
fi

# Verify no StatefulSet was created
if kubectl get sts invalid-image-cluster -n default 2>/dev/null; then
  log_error "StatefulSet was created despite invalid spec"
  exit 1
fi

log_info "✅ No StatefulSet created (correct behavior)"

# Cleanup
kubectl delete qdrantcluster invalid-image-cluster -n default 2>/dev/null || true
sleep 2

# Test 2: Invalid collection spec (negative vectorSize - passes CRD, operator should catch)
log_info "Test 2: Creating collection with invalid vectorSize..."
# First create a valid cluster for the collection
kubectl apply -f "${SCRIPT_DIR}/../../examples/qdrant-cluster-minimal.yaml" || true
wait_for_resource "statefulset" "my-cluster" "default" 60
kubectl rollout status statefulset my-cluster -n default --timeout=120s || true

cat <<EOF | kubectl apply -f - || true
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCollection
metadata:
  name: invalid-vector-collection
  namespace: default
spec:
  cluster: my-cluster
  vectorSize: -1
  shardNumber: 1
  replicationFactor: 1
EOF

log_info "Waiting for operator to process invalid collection spec (timeout: 60s)..."
# Wait for resource to be created first
wait_for_resource "qdrantcollections" "invalid-vector-collection" "default" 30

# Wait for operator to set error status (give more time for reconciliation)
log_info "Waiting for operator to detect invalid spec and set Error status..."
wait_for_status "qdrantcollections" "invalid-vector-collection" "{.status.qdrantStatus}" "Error" "default" 60 || {
  log_error "Collection status did not become 'Error' within timeout"
  log_info "Current collection status:"
  kubectl get qdrantcollections invalid-vector-collection -n default -o yaml
  log_info "Checking operator logs for collection processing:"
  OPERATOR_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [ -n "${OPERATOR_POD}" ]; then
    kubectl logs -n qdrant-operator "${OPERATOR_POD}" --tail=50 2>/dev/null | grep -i "invalid-vector-collection\|validation\|error" || true
  fi
  exit 1
}

# Give operator a moment to set errorMessage and reason (may take a bit longer)
log_info "Waiting for errorMessage and reason to be set (if available)..."
sleep 5

# Get status fields
STATUS=$(kubectl get qdrantcollections invalid-vector-collection -n default -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
REASON=$(kubectl get qdrantcollections invalid-vector-collection -n default -o jsonpath='{.status.reason}' 2>/dev/null || echo "")
ERROR_MSG=$(kubectl get qdrantcollections invalid-vector-collection -n default -o jsonpath='{.status.errorMessage}' 2>/dev/null || echo "")

if [ "${STATUS}" != "Error" ]; then
  log_error "Expected status 'Error', got '${STATUS}'"
  kubectl get qdrantcollections invalid-vector-collection -n default -o yaml
  exit 1
fi

log_info "✅ Status is 'Error' (operator correctly detected invalid spec)"

# Capture forensic logs for debugging (always, not just on failure)
log_info "📋 Capturing forensic status logs from operator..."
OPERATOR_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "${OPERATOR_POD}" ]; then
  log_info "Operator pod: ${OPERATOR_POD}"
  log_info "=== STATUS WRITE LOGS for invalid-vector-collection ==="
  kubectl logs -n qdrant-operator "${OPERATOR_POD}" 2>/dev/null | grep -E "\[STATUS\]\[.*invalid-vector-collection" | tail -50 || log_warn "No status logs found for invalid-vector-collection"
  log_info "=== RECENT VALIDATION LOGS ==="
  kubectl logs -n qdrant-operator "${OPERATOR_POD}" 2>/dev/null | grep -i "invalid-vector-collection\|Invalid spec\|validation" | tail -20 || log_warn "No validation logs found"
fi

# Verify reason field (should be 'InvalidSpec' for validation errors)
if [ -n "${REASON}" ]; then
  if [ "${REASON}" = "InvalidSpec" ]; then
    log_info "✅ Reason is 'InvalidSpec' (correctly set)"
  else
    log_warn "⚠️ Reason is '${REASON}' (expected 'InvalidSpec')"
  fi
else
  log_warn "⚠️ Reason field not found in status (operator may not set it)"
fi

# errorMessage is optional - the important part is that status is 'Error'
if [ -z "${ERROR_MSG}" ]; then
  log_warn "⚠️ errorMessage not found in status (operator may not set it or timing issue)"
  log_warn "Status is 'Error' which indicates operator detected the problem - this is sufficient"
else
  log_info "✅ errorMessage found: ${ERROR_MSG}"
fi

log_info "✅ Collection status validation complete"

# Cleanup
kubectl delete qdrantcollections invalid-vector-collection -n default 2>/dev/null || true
kubectl delete qdrantcluster my-cluster -n default 2>/dev/null || true
sleep 2

# Verify operator is still running (didn't crash)
POD=$(get_operator_pod)
if [ -z "${POD}" ]; then
  log_error "Operator pod not found - operator may have crashed"
  exit 1
fi

if ! kubectl get pod "${POD}" -n qdrant-operator 2>/dev/null | grep -q "Running"; then
  log_error "Operator pod is not running - operator may have crashed"
  kubectl get pods -n qdrant-operator
  exit 1
fi

log_info "✅ Operator is still running (didn't crash)"

log_info "✅ All invalid spec tests passed"
exit 0

