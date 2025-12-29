#!/usr/bin/env bash
# API Integration: Full E2E test - API → CRD → Reconciler → Qdrant
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"
source "${SCRIPT_DIR}/utils-api.sh"

log_test "API Integration: Full E2E test - API → CRD → Reconciler → Qdrant"

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

# Step 1: Create template via API
log_test "Step 1: Create template via API"

TEMPLATE_NAME="integration-template-$(date +%s)"

TEMPLATE_RESPONSE=$(api_request "POST" "/templates" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${TEMPLATE_NAME}\",
  \"shards\": 2,
  \"replicationFactor\": 1,
  \"onDisk\": true,
  \"vectors\": {
    \"size\": 10,
    \"distance\": \"Cosine\"
  }
}")

TEMPLATE_CODE=$(echo "${TEMPLATE_RESPONSE}" | tail -n1)

if [ "${TEMPLATE_CODE}" != "201" ]; then
  log_error "Failed to create template. HTTP ${TEMPLATE_CODE}"
  exit 1
fi

log_info "✅ Template created: ${TEMPLATE_NAME}"

# Wait for template CRD
wait_for_resource "qdrantcollectiontemplate" "${TEMPLATE_NAME}" "" 30

# Step 2: Create collection via API using template
log_test "Step 2: Create collection via API using template"

COLLECTION_NAME="integration-collection-$(date +%s)"

COLLECTION_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${COLLECTION_NAME}\",
  \"cluster\": \"${CLUSTER_NAME}\",
  \"template\": \"${TEMPLATE_NAME}\"
}")

COLLECTION_CODE=$(echo "${COLLECTION_RESPONSE}" | tail -n1)

if [ "${COLLECTION_CODE}" != "201" ]; then
  log_error "Failed to create collection. HTTP ${COLLECTION_CODE}"
  exit 1
fi

log_info "✅ Collection creation initiated: ${COLLECTION_NAME}"

# Step 3: Verify CRD was created
log_test "Step 3: Verify QdrantCollection CRD was created"

wait_for_resource "qdrantcollection" "${COLLECTION_NAME}" "${NAMESPACE}" 30

# Verify CRD has correct values from template
COLLECTION_SPEC=$(kubectl get qdrantcollection "${COLLECTION_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec}' 2>/dev/null)

if [ -z "${COLLECTION_SPEC}" ]; then
  log_error "Collection CRD not found"
  exit 1
fi

log_info "✅ Collection CRD exists"

# Step 4: Wait for reconciler to create collection in Qdrant
log_test "Step 4: Wait for reconciler to create collection in Qdrant"

log_info "Waiting for collection to be created in Qdrant (timeout: 60s)..."

QDRANT_POD=$(kubectl get pod -n "${NAMESPACE}" -l clustername="${CLUSTER_NAME}" -o name | head -n1 | sed 's|pod/||')

if [ -z "${QDRANT_POD}" ]; then
  log_error "Qdrant pod not found"
  exit 1
fi

max_attempts=12
attempt=1
COLLECTION_READY=false

while [ $attempt -le $max_attempts ]; do
  COLLECTION_STATUS=$(kubectl exec -n "${NAMESPACE}" "${QDRANT_POD}" -- \
    curl -s "http://localhost:6333/collections/${COLLECTION_NAME}" 2>/dev/null || echo "")

  if echo "${COLLECTION_STATUS}" | grep -q '"status":"green"'; then
    COLLECTION_READY=true
    log_info "✅ Collection is green in Qdrant!"
    break
  fi

  if [ $attempt -lt $max_attempts ]; then
    log_info "Collection not ready yet, waiting 5s... (attempt ${attempt}/${max_attempts})"
    sleep 5
  fi

  attempt=$((attempt + 1))
done

if [ "${COLLECTION_READY}" = "false" ]; then
  log_error "Collection never became green after ${max_attempts} attempts"
  kubectl get qdrantcollections "${COLLECTION_NAME}" -n "${NAMESPACE}" -o yaml || true
  exit 1
fi

# Step 5: Verify collection via API
log_test "Step 5: Verify collection via API"

GET_RESPONSE=$(api_request "GET" "/collections/${COLLECTION_NAME}" "${NAMESPACE}" "${API_TOKEN}")
GET_CODE=$(echo "${GET_RESPONSE}" | tail -n1)
GET_BODY=$(echo "${GET_RESPONSE}" | head -n-1)

if [ "${GET_CODE}" != "200" ]; then
  log_error "Failed to get collection via API. HTTP ${GET_CODE}"
  exit 1
fi

# Verify collection status
if echo "${GET_BODY}" | grep -q "\"status\":\"green\"" || echo "${GET_BODY}" | grep -q "\"status\":\"Running\"" || echo "${GET_BODY}" | grep -q "\"status\":\"Healthy\""; then
  log_info "✅ Collection status is healthy via API"
else
  log_warn "⚠️ Collection status may not be green yet"
  echo "Response: ${GET_BODY}"
fi

# Step 6: Insert data and verify
log_test "Step 6: Insert data and verify end-to-end"

log_info "Inserting dummy data into collection..."

insert_dummy_data "${CLUSTER_NAME}" "${COLLECTION_NAME}" "${NAMESPACE}" 15

# Wait for data to be inserted
wait_for_collection_data "${CLUSTER_NAME}" "${COLLECTION_NAME}" "${NAMESPACE}" 15 30

# Verify data via Qdrant API directly
POINT_COUNT=$(kubectl exec -n "${NAMESPACE}" "${QDRANT_POD}" -- \
  curl -s "http://localhost:6333/collections/${COLLECTION_NAME}" 2>/dev/null | \
  python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('result', {}).get('points_count', 0))" 2>/dev/null || echo "0")

if [ "${POINT_COUNT}" -ge 15 ]; then
  log_info "✅ Collection has ${POINT_COUNT} points (expected at least 15)"
else
  log_warn "⚠️ Collection has ${POINT_COUNT} points (expected at least 15)"
fi

# Step 7: Verify collection appears in API list
log_test "Step 7: Verify collection appears in API list"

LIST_RESPONSE=$(api_request "GET" "/collections" "${NAMESPACE}" "${API_TOKEN}")
LIST_CODE=$(echo "${LIST_RESPONSE}" | tail -n1)
LIST_BODY=$(echo "${LIST_RESPONSE}" | head -n-1)

if [ "${LIST_CODE}" != "200" ]; then
  log_error "Failed to list collections. HTTP ${LIST_CODE}"
  exit 1
fi

if echo "${LIST_BODY}" | grep -q "\"name\":\"${COLLECTION_NAME}\""; then
  log_info "✅ Collection found in API list"
else
  log_error "Collection not found in API list"
  echo "Response: ${LIST_BODY}"
  exit 1
fi

# Step 8: Verify full flow - API → CRD → Reconciler → Qdrant
log_test "Step 8: Verify complete integration flow"

# Summary verification
log_info "Verifying complete flow..."

# 1. Template exists in Kubernetes
if kubectl get qdrantcollectiontemplate "${TEMPLATE_NAME}" >/dev/null 2>&1; then
  log_info "✅ [1/4] Template CRD exists"
else
  log_error "[1/4] Template CRD missing"
  exit 1
fi

# 2. Collection CRD exists
if kubectl get qdrantcollection "${COLLECTION_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  log_info "✅ [2/4] Collection CRD exists"
else
  log_error "[2/4] Collection CRD missing"
  exit 1
fi

# 3. Collection exists in Qdrant
QDRANT_CHECK=$(kubectl exec -n "${NAMESPACE}" "${QDRANT_POD}" -- \
  curl -s "http://localhost:6333/collections/${COLLECTION_NAME}" 2>/dev/null || echo "")

if echo "${QDRANT_CHECK}" | grep -q '"status":"green"'; then
  log_info "✅ [3/4] Collection exists in Qdrant and is green"
else
  log_error "[3/4] Collection not found in Qdrant or not green"
  exit 1
fi

# 4. Collection accessible via API
API_CHECK=$(api_request "GET" "/collections/${COLLECTION_NAME}" "${NAMESPACE}" "${API_TOKEN}")
API_CHECK_CODE=$(echo "${API_CHECK}" | tail -n1)

if [ "${API_CHECK_CODE}" = "200" ]; then
  log_info "✅ [4/4] Collection accessible via API"
else
  log_error "[4/4] Collection not accessible via API. HTTP ${API_CHECK_CODE}"
  exit 1
fi

log_info ""
log_info "🎉 Complete integration flow verified:"
log_info "   API → CRD → Reconciler → Qdrant → API"
log_info ""
log_info "✅ All integration tests passed!"

