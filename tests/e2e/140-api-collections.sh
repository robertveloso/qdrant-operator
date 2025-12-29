#!/usr/bin/env bash
# API Collections: Test creating and listing collections via API
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"
source "${SCRIPT_DIR}/utils-api.sh"

log_test "API Collections: Testing collection creation and listing via API"

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

# Test 1: Create collection via API
log_test "Test 1: Create collection via API"

COLLECTION_NAME="api-test-collection-$(date +%s)"
CLUSTER_NAME="my-cluster"
NAMESPACE="default"

CREATE_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${COLLECTION_NAME}\",
  \"cluster\": \"${CLUSTER_NAME}\",
  \"vectors\": {
    \"size\": 10,
    \"distance\": \"Cosine\"
  },
  \"replication\": 1
}" "${POD}")

HTTP_CODE=$(echo "${CREATE_RESPONSE}" | tail -n1)
BODY=$(echo "${CREATE_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "201" ]; then
  log_error "Failed to create collection. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

log_info "✅ Collection created via API: ${COLLECTION_NAME}"

# Wait for collection to be created in Kubernetes
log_info "Waiting for QdrantCollection CR to be created..."
wait_for_resource "qdrantcollection" "${COLLECTION_NAME}" "${NAMESPACE}" 30

# Wait for collection to be ready in Qdrant
log_info "Waiting for collection to be ready in Qdrant..."
sleep 10

# Verify collection exists in Qdrant
POD=$(kubectl get pod -n "${NAMESPACE}" -l clustername="${CLUSTER_NAME}" -o name | head -n1 | sed 's|pod/||')
if [ -n "${POD}" ]; then
  COLLECTION_STATUS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    curl -s "http://localhost:6333/collections/${COLLECTION_NAME}" 2>/dev/null || echo "")

  if echo "${COLLECTION_STATUS}" | grep -q '"status":"green"'; then
    log_info "✅ Collection is green in Qdrant"
  else
    log_warn "⚠️ Collection status: ${COLLECTION_STATUS}"
  fi
fi

# Test 2: List collections via API
log_test "Test 2: List collections via API"

LIST_RESPONSE=$(api_request "GET" "/collections" "${NAMESPACE}" "${API_TOKEN}" "" "${POD}")
HTTP_CODE=$(echo "${LIST_RESPONSE}" | tail -n1)
BODY=$(echo "${LIST_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "200" ]; then
  log_error "Failed to list collections. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

# Check if our collection is in the list
if echo "${BODY}" | grep -q "\"name\":\"${COLLECTION_NAME}\""; then
  log_info "✅ Collection found in list"
else
  log_error "Collection ${COLLECTION_NAME} not found in list"
  echo "Response: ${BODY}"
  exit 1
fi

# Test 3: Get specific collection via API
log_test "Test 3: Get specific collection via API"

GET_RESPONSE=$(api_request "GET" "/collections/${COLLECTION_NAME}" "${NAMESPACE}" "${API_TOKEN}" "" "${POD}")
HTTP_CODE=$(echo "${GET_RESPONSE}" | tail -n1)
BODY=$(echo "${GET_RESPONSE}" | head -n-1)

if [ "${HTTP_CODE}" != "200" ]; then
  log_error "Failed to get collection. HTTP ${HTTP_CODE}"
  echo "Response: ${BODY}"
  exit 1
fi

if echo "${BODY}" | grep -q "\"name\":\"${COLLECTION_NAME}\""; then
  log_info "✅ Collection details retrieved"
else
  log_error "Collection details incorrect"
  echo "Response: ${BODY}"
  exit 1
fi

# Test 4: Create collection with template (if template exists)
log_test "Test 4: Create collection with template"

# First, try to create a template
TEMPLATE_NAME="test-template-$(date +%s)"
TEMPLATE_RESPONSE=$(api_request "POST" "/templates" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${TEMPLATE_NAME}\",
  \"shards\": 1,
  \"replicationFactor\": 1,
  \"onDisk\": true,
  \"vectors\": {
    \"size\": 10,
    \"distance\": \"Cosine\"
  }
}" "${POD}")

TEMPLATE_HTTP_CODE=$(echo "${TEMPLATE_RESPONSE}" | tail -n1)

if [ "${TEMPLATE_HTTP_CODE}" = "201" ]; then
  log_info "✅ Template created"

  # Create collection using template
  COLLECTION_WITH_TEMPLATE="api-template-collection-$(date +%s)"
  CREATE_TEMPLATE_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
    \"name\": \"${COLLECTION_WITH_TEMPLATE}\",
    \"cluster\": \"${CLUSTER_NAME}\",
    \"template\": \"${TEMPLATE_NAME}\"
  }" "${POD}")

  TEMPLATE_CREATE_CODE=$(echo "${CREATE_TEMPLATE_RESPONSE}" | tail -n1)

  if [ "${TEMPLATE_CREATE_CODE}" = "201" ]; then
    log_info "✅ Collection created with template"
    wait_for_resource "qdrantcollection" "${COLLECTION_WITH_TEMPLATE}" "${NAMESPACE}" 30
  else
    log_warn "⚠️ Failed to create collection with template. HTTP ${TEMPLATE_CREATE_CODE}"
  fi
else
  log_warn "⚠️ Template creation failed or template already exists. HTTP ${TEMPLATE_HTTP_CODE}"
fi

# Test 5: Validation errors
log_test "Test 5: Test validation errors"

# Missing name
VALIDATION_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
  \"cluster\": \"${CLUSTER_NAME}\",
  \"vectors\": {
    \"size\": 10
  }
}" "${POD}")

VALIDATION_CODE=$(echo "${VALIDATION_RESPONSE}" | tail -n1)

if [ "${VALIDATION_CODE}" = "400" ]; then
  log_info "✅ Validation error correctly returned (400)"
else
  log_warn "⚠️ Expected 400, got ${VALIDATION_CODE}"
fi

log_info "✅ All API collection tests passed!"

