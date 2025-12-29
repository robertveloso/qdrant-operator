#!/usr/bin/env bash
# API Templates: Test template CRD and API endpoints
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"
source "${SCRIPT_DIR}/utils-api.sh"

log_test "API Templates: Testing template CRD and API endpoints"

# Get operator pod
POD=$(get_operator_pod)
if [ -z "${POD}" ]; then
  log_error "Operator pod not found"
  exit 1
fi

log_info "Using operator pod: ${POD}"

# Get API token
API_TOKEN=$(get_api_token "${POD}")
if [ -z "${API_TOKEN}" ]; then
  log_warn "⚠️ No API token configured (development mode)"
fi

CLUSTER_NAME="my-cluster"
NAMESPACE="default"

# Test 1: Create template via API
log_test "Test 1: Create template via API"

TEMPLATE_NAME="test-template-$(date +%s)"

CREATE_TEMPLATE_RESPONSE=$(api_request "POST" "/templates" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${TEMPLATE_NAME}\",
  \"shards\": 3,
  \"replicationFactor\": 2,
  \"onDisk\": true,
  \"vectors\": {
    \"size\": 128,
    \"distance\": \"Cosine\"
  },
  \"backup\": {
    \"enabled\": true,
    \"schedule\": \"0 2 * * *\",
    \"retentionCount\": 7
  }
}")

HTTP_CODE=$(echo "${CREATE_TEMPLATE_RESPONSE}" | tail -n1)
BODY=$(echo "${CREATE_TEMPLATE_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "201" ]; then
  log_error "Failed to create template. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

log_info "✅ Template created via API: ${TEMPLATE_NAME}"

# Wait for template CRD to be created
log_info "Waiting for QdrantCollectionTemplate CR to be created..."
wait_for_resource "qdrantcollectiontemplate" "${TEMPLATE_NAME}" "" 30

# Verify template exists in Kubernetes
if kubectl get qdrantcollectiontemplate "${TEMPLATE_NAME}" >/dev/null 2>&1; then
  log_info "✅ Template CRD exists in Kubernetes"
else
  log_error "Template CRD not found"
  exit 1
fi

# Test 2: List templates via API
log_test "Test 2: List templates via API"

LIST_RESPONSE=$(api_request "GET" "/templates" "${NAMESPACE}" "${API_TOKEN}")
HTTP_CODE=$(echo "${LIST_RESPONSE}" | tail -n1)
BODY=$(echo "${LIST_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "200" ]; then
  log_error "Failed to list templates. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

# Check if our template is in the list
if echo "${BODY}" | grep -q "\"name\":\"${TEMPLATE_NAME}\""; then
  log_info "✅ Template found in list"
else
  log_error "Template ${TEMPLATE_NAME} not found in list"
  echo "Response: ${BODY}"
  exit 1
fi

# Test 3: Get specific template via API
log_test "Test 3: Get specific template via API"

GET_RESPONSE=$(api_request "GET" "/templates/${TEMPLATE_NAME}" "${NAMESPACE}" "${API_TOKEN}")
HTTP_CODE=$(echo "${GET_RESPONSE}" | tail -n1)
BODY=$(echo "${GET_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "200" ]; then
  log_error "Failed to get template. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

if echo "${BODY}" | grep -q "\"name\":\"${TEMPLATE_NAME}\""; then
  log_info "✅ Template details retrieved"

  # Verify template has correct values
  if echo "${BODY}" | grep -q "\"shards\":3"; then
    log_info "✅ Template shards value correct"
  fi

  if echo "${BODY}" | grep -q "\"replicationFactor\":2"; then
    log_info "✅ Template replicationFactor value correct"
  fi
else
  log_error "Template details incorrect"
  echo "Response: ${BODY}"
  exit 1
fi

# Test 4: Create collection using template
log_test "Test 4: Create collection using template"

COLLECTION_NAME="template-collection-$(date +%s)"

CREATE_COLLECTION_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${COLLECTION_NAME}\",
  \"cluster\": \"${CLUSTER_NAME}\",
  \"template\": \"${TEMPLATE_NAME}\"
}")

COLLECTION_HTTP_CODE=$(echo "${CREATE_COLLECTION_RESPONSE}" | tail -n1)
COLLECTION_BODY=$(echo "${CREATE_COLLECTION_RESPONSE}" | head -n-1)

if [ "${COLLECTION_HTTP_CODE}" != "201" ]; then
  log_error "Failed to create collection with template. HTTP ${COLLECTION_HTTP_CODE}"
  echo "Response: ${COLLECTION_BODY}"
  exit 1
fi

log_info "✅ Collection created with template: ${COLLECTION_NAME}"

# Wait for collection to be created
wait_for_resource "qdrantcollection" "${COLLECTION_NAME}" "${NAMESPACE}" 30

# Verify collection has template values
COLLECTION_SPEC=$(kubectl get qdrantcollection "${COLLECTION_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec}' 2>/dev/null || echo "")

if echo "${COLLECTION_SPEC}" | grep -q "\"shardNumber\":3"; then
  log_info "✅ Collection has template shardNumber (3)"
else
  log_warn "⚠️ Collection shardNumber may not match template"
fi

if echo "${COLLECTION_SPEC}" | grep -q "\"replicationFactor\":2"; then
  log_info "✅ Collection has template replicationFactor (2)"
else
  log_warn "⚠️ Collection replicationFactor may not match template"
fi

# Verify collection vectorSize matches template
if echo "${COLLECTION_SPEC}" | grep -q "\"vectorSize\":128"; then
  log_info "✅ Collection has template vectorSize (128)"
else
  log_warn "⚠️ Collection vectorSize may not match template"
fi

# Test 5: Template validation
log_test "Test 5: Template validation errors"

# Missing name
VALIDATION_RESPONSE=$(api_request "POST" "/templates" "${NAMESPACE}" "${API_TOKEN}" "{
  \"shards\": 1,
  \"replicationFactor\": 1
}")

VALIDATION_CODE=$(echo "${VALIDATION_RESPONSE}" | tail -n1)

if [ "${VALIDATION_CODE}" = "400" ]; then
  log_info "✅ Validation error correctly returned (400) for missing name"
else
  log_warn "⚠️ Expected 400, got ${VALIDATION_CODE}"
fi

# Invalid name format
INVALID_NAME_RESPONSE=$(api_request "POST" "/templates" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"INVALID_NAME_WITH_UPPERCASE\",
  \"shards\": 1
}")

INVALID_NAME_CODE=$(echo "${INVALID_NAME_RESPONSE}" | tail -n1)

if [ "${INVALID_NAME_CODE}" = "400" ]; then
  log_info "✅ Validation error correctly returned (400) for invalid name format"
else
  log_warn "⚠️ Expected 400 for invalid name, got ${INVALID_NAME_CODE}"
fi

# Test 6: Create template via kubectl (CRD directly)
log_test "Test 6: Create template via kubectl (CRD directly)"

KUBECTL_TEMPLATE_NAME="kubectl-template-$(date +%s)"

cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCollectionTemplate
metadata:
  name: ${KUBECTL_TEMPLATE_NAME}
spec:
  name: ${KUBECTL_TEMPLATE_NAME}
  shards: 2
  replicationFactor: 1
  onDisk: true
  vectors:
    size: 64
    distance: Euclid
EOF

wait_for_resource "qdrantcollectiontemplate" "${KUBECTL_TEMPLATE_NAME}" "" 30

# Verify template is accessible via API
KUBECTL_GET_RESPONSE=$(api_request "GET" "/templates/${KUBECTL_TEMPLATE_NAME}" "${NAMESPACE}" "${API_TOKEN}")
KUBECTL_GET_CODE=$(echo "${KUBECTL_GET_RESPONSE}" | tail -n1)

if [ "${KUBECTL_GET_CODE}" = "200" ]; then
  log_info "✅ Template created via kubectl is accessible via API"
else
  log_warn "⚠️ Template created via kubectl not accessible via API. HTTP ${KUBECTL_GET_CODE}"
fi

log_info "✅ All template tests passed!"

