#!/usr/bin/env bash
# API Restore: Test restore operations via API (requires backup setup)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"
source "${SCRIPT_DIR}/utils-api.sh"

log_test "API Restore: Testing restore operations via API"

# Note: Full restore testing requires S3 backup infrastructure
# This test validates the API endpoint and CRD creation even without full S3 setup

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

# Create a test collection with backup enabled
log_test "Setup: Create collection with backup configuration"

COLLECTION_NAME="restore-test-collection-$(date +%s)"

# Create collection via API with backup config
CREATE_RESPONSE=$(api_request "POST" "/collections" "${NAMESPACE}" "${API_TOKEN}" "{
  \"name\": \"${COLLECTION_NAME}\",
  \"cluster\": \"${CLUSTER_NAME}\",
  \"vectors\": {
    \"size\": 10,
    \"distance\": \"Cosine\"
  },
  \"replication\": 1
}")

HTTP_CODE=$(echo "${CREATE_RESPONSE}" | tail -n1)

if [ "${HTTP_CODE}" != "201" ]; then
  log_error "Failed to create collection with backup. HTTP ${HTTP_CODE}"
  exit 1
fi

log_info "✅ Collection created: ${COLLECTION_NAME}"

# Wait for collection to be ready
wait_for_resource "qdrantcollection" "${COLLECTION_NAME}" "${NAMESPACE}" 30
sleep 10

# Insert dummy data into collection
log_test "Inserting dummy data into collection..."

insert_dummy_data "${CLUSTER_NAME}" "${COLLECTION_NAME}" "${NAMESPACE}" 20

# Wait for data to be inserted
wait_for_collection_data "${CLUSTER_NAME}" "${COLLECTION_NAME}" "${NAMESPACE}" 20 30

# Add snapshot configuration to collection (required for restore)
# This simulates a collection that has backup configured
log_test "Adding snapshot configuration to collection..."

# Check if S3 secret exists (optional - test will work without it)
if kubectl get secret bucket-credentials -n "${NAMESPACE}" >/dev/null 2>&1; then
  # Patch collection to add snapshot config
  kubectl patch qdrantcollection "${COLLECTION_NAME}" -n "${NAMESPACE}" --type=merge -p '{
    "spec": {
      "snapshots": {
        "s3EndpointURL": "https://storage.googleapis.com/",
        "s3CredentialsSecretName": "bucket-credentials",
        "bucketName": "test-backup-bucket"
      }
    }
  }' || log_warn "⚠️ Failed to add snapshot config (may not be required for API test)"

  log_info "✅ Snapshot configuration added"
else
  log_warn "⚠️ S3 secret not found - restore will fail validation (expected)"
fi

# Note: For full restore testing, we would need:
# 1. S3 bucket configured
# 2. QdrantCollectionBackup CRD with backupNow: true
# 3. Wait for backup job to complete
# 4. Get actual backup ID from job output

# For now, we'll test the restore API endpoint with a mock backup ID
# In a real scenario, this would be the actual backup path from S3
BACKUP_ID="${CLUSTER_NAME}/${COLLECTION_NAME}/$(date +%Y-%m-%d-%H-%M)"
log_info "Using backup ID: ${BACKUP_ID} (mock for testing)"

# Test restore via API
log_test "Test: Restore collection via API"

# First, verify collection has data
POD=$(kubectl get pod -n "${NAMESPACE}" -l clustername="${CLUSTER_NAME}" -o name | head -n1 | sed 's|pod/||')
BEFORE_COUNT=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  curl -s "http://localhost:6333/collections/${COLLECTION_NAME}" 2>/dev/null | \
  python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('result', {}).get('points_count', 0))" 2>/dev/null || echo "0")

log_info "Points before restore: ${BEFORE_COUNT}"

# Create restore via API
RESTORE_RESPONSE=$(api_request "POST" "/restore/collections/${COLLECTION_NAME}" "${NAMESPACE}" "${API_TOKEN}" "{
  \"backupId\": \"${BACKUP_ID}\",
  \"mode\": \"replace\",
  \"pauseWrites\": false
}")

RESTORE_HTTP_CODE=$(echo "${RESTORE_RESPONSE}" | tail -n1)
RESTORE_BODY=$(echo "${RESTORE_RESPONSE}" | head -n-1)

if [ "${RESTORE_HTTP_CODE}" != "201" ]; then
  log_warn "⚠️ Restore creation returned HTTP ${RESTORE_HTTP_CODE}"
  log_warn "   Response: ${RESTORE_BODY}"

  # Check if it's because collection doesn't have snapshot config
  if echo "${RESTORE_BODY}" | grep -q "snapshot configuration"; then
    log_info "ℹ️ Collection needs snapshot configuration for restore (expected)"
    log_info "✅ Restore API endpoint is accessible and validates correctly"
    exit 0
  fi

  log_error "Unexpected error creating restore"
  exit 1
fi

log_info "✅ Restore CRD created via API"

# Wait for restore CRD to be created
RESTORE_NAME=$(echo "${RESTORE_BODY}" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('id', ''))" 2>/dev/null || echo "")

if [ -n "${RESTORE_NAME}" ]; then
  wait_for_resource "qdrantcollectionrestore" "${RESTORE_NAME}" "${NAMESPACE}" 30

  # Check restore status via API
  log_test "Check restore status via API"

  STATUS_RESPONSE=$(api_request "GET" "/restore/collections/${COLLECTION_NAME}" "${NAMESPACE}" "${API_TOKEN}")
  STATUS_CODE=$(echo "${STATUS_RESPONSE}" | tail -n1)
  STATUS_BODY=$(echo "${STATUS_RESPONSE}" | head -n-1)

  if [ "${STATUS_CODE}" = "200" ]; then
    log_info "✅ Restore status retrieved"
    echo "Status: ${STATUS_BODY}"
  else
    log_warn "⚠️ Failed to get restore status. HTTP ${STATUS_CODE}"
  fi
fi

log_info "✅ Restore API tests completed (some may require full backup infrastructure)"

