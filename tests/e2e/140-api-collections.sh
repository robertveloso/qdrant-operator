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
wait_for_collection_green "${CLUSTER_NAME}" "${COLLECTION_NAME}" "${NAMESPACE}" 60

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

# Test 6: Concurrent creation (idempotency and locking)
log_test "Test 6: Concurrent collection creation (idempotency test)"

CONCURRENT_COLLECTION_NAME="concurrent-test-collection-$(date +%s)"

log_info "Sending 2 concurrent POST requests to create the same collection..."
log_info "Collection name: ${CONCURRENT_COLLECTION_NAME}"

# Create temporary files for responses
RESPONSE1_FILE=$(mktemp)
RESPONSE2_FILE=$(mktemp)
ERROR1_FILE=$(mktemp)
ERROR2_FILE=$(mktemp)

# Prepare request payload
REQUEST_PAYLOAD="{
  \"name\": \"${CONCURRENT_COLLECTION_NAME}\",
  \"cluster\": \"${CLUSTER_NAME}\",
  \"vectors\": {
    \"size\": 10,
    \"distance\": \"Cosine\"
  },
  \"replication\": 1
}"

# Send two concurrent requests (truly parallel)
(
  api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "${REQUEST_PAYLOAD}" "${POD}" > "${RESPONSE1_FILE}" 2> "${ERROR1_FILE}"
  echo $? > "${ERROR1_FILE}.exit"
) &
PID1=$!

# Small delay to ensure both requests hit around the same time (but not sequential)
sleep 0.1

(
  api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "${REQUEST_PAYLOAD}" "${POD}" > "${RESPONSE2_FILE}" 2> "${ERROR2_FILE}"
  echo $? > "${ERROR2_FILE}.exit"
) &
PID2=$!

# Wait for both requests to complete
wait ${PID1} ${PID2}

# Parse responses
HTTP_CODE1=$(tail -n1 "${RESPONSE1_FILE}" 2>/dev/null || echo "000")
BODY1=$(head -n-1 "${RESPONSE1_FILE}" 2>/dev/null || echo "")

HTTP_CODE2=$(tail -n1 "${RESPONSE2_FILE}" 2>/dev/null || echo "000")
BODY2=$(head -n-1 "${RESPONSE2_FILE}" 2>/dev/null || echo "")

# Check for errors
if [ -s "${ERROR1_FILE}" ]; then
  log_warn "Request 1 had errors: $(cat ${ERROR1_FILE})"
fi
if [ -s "${ERROR2_FILE}" ]; then
  log_warn "Request 2 had errors: $(cat ${ERROR2_FILE})"
fi

# Cleanup temp files
rm -f "${RESPONSE1_FILE}" "${RESPONSE2_FILE}" "${ERROR1_FILE}" "${ERROR2_FILE}" "${ERROR1_FILE}.exit" "${ERROR2_FILE}.exit"

log_info "Request 1: HTTP ${HTTP_CODE1}"
log_info "Request 2: HTTP ${HTTP_CODE2}"

# One should succeed (201), one should fail with conflict (409)
SUCCESS_COUNT=0
CONFLICT_COUNT=0

if [ "${HTTP_CODE1}" = "201" ]; then
  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  log_info "✅ Request 1 succeeded (201)"
elif [ "${HTTP_CODE1}" = "409" ]; then
  CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
  log_info "✅ Request 1 returned conflict (409) - expected"
else
  log_error "Request 1 returned unexpected code: ${HTTP_CODE1}"
  echo "Response: ${BODY1}"
  exit 1
fi

if [ "${HTTP_CODE2}" = "201" ]; then
  SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  log_info "✅ Request 2 succeeded (201)"
elif [ "${HTTP_CODE2}" = "409" ]; then
  CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
  log_info "✅ Request 2 returned conflict (409) - expected"
else
  log_error "Request 2 returned unexpected code: ${HTTP_CODE2}"
  echo "Response: ${BODY2}"
  exit 1
fi

# Verify exactly one succeeded and one conflicted
if [ "${SUCCESS_COUNT}" != "1" ] || [ "${CONFLICT_COUNT}" != "1" ]; then
  log_error "Expected exactly 1 success (201) and 1 conflict (409), got ${SUCCESS_COUNT} success and ${CONFLICT_COUNT} conflict"
  exit 1
fi

log_info "✅ Concurrent requests handled correctly: 1 success, 1 conflict"

# Verify only one CRD was created
log_info "Verifying only one CRD was created..."
CRD_COUNT=$(kubectl get qdrantcollections "${CONCURRENT_COLLECTION_NAME}" -n "${NAMESPACE}" --no-headers 2>/dev/null | wc -l || echo "0")

if [ "${CRD_COUNT}" != "1" ]; then
  log_error "Expected 1 CRD, found ${CRD_COUNT} - duplicate resources detected!"
  kubectl get qdrantcollections "${CONCURRENT_COLLECTION_NAME}" -n "${NAMESPACE}"
  exit 1
fi

log_info "✅ Only 1 CRD created (no duplicates) - idempotency verified"

# Verify the created CRD is valid
if kubectl get qdrantcollections "${CONCURRENT_COLLECTION_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  log_info "✅ CRD is valid and exists"

  # Cleanup
  kubectl delete qdrantcollections "${CONCURRENT_COLLECTION_NAME}" -n "${NAMESPACE}" 2>/dev/null || true
else
  log_error "CRD was not created despite 201 response"
  exit 1
fi

log_info "✅ Concurrent creation test passed (idempotency and locking verified)"

log_info "✅ All API collection tests passed!"

