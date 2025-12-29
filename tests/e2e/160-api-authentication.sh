#!/usr/bin/env bash
# API Authentication: Test authentication (token valid/invalid)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"
source "${SCRIPT_DIR}/utils-api.sh"

log_test "API Authentication: Testing authentication"

# Get operator pod
POD=$(get_operator_pod)
if [ -z "${POD}" ]; then
  log_error "Operator pod not found"
  exit 1
fi

log_info "Using operator pod: ${POD}"

# Get API token
API_TOKEN=$(get_api_token "${POD}")

NAMESPACE="default"

# Test 1: Request without token (should work in dev mode, or fail in prod)
log_test "Test 1: Request without authentication token"

NO_AUTH_RESPONSE=$(api_request "GET" "/collections" "${NAMESPACE}" "")
NO_AUTH_CODE=$(echo "${NO_AUTH_RESPONSE}" | tail -n1)

if [ -z "${API_TOKEN}" ]; then
  # Development mode - should allow requests
  if [ "${NO_AUTH_CODE}" = "200" ] || [ "${NO_AUTH_CODE}" = "401" ]; then
    log_info "✅ No token request handled correctly (dev mode or auth required)"
  else
    log_warn "⚠️ Unexpected response code: ${NO_AUTH_CODE}"
  fi
else
  # Production mode - should require token
  if [ "${NO_AUTH_CODE}" = "401" ]; then
    log_info "✅ Authentication required (401 Unauthorized)"
  else
    log_warn "⚠️ Expected 401, got ${NO_AUTH_CODE} (auth may be disabled)"
  fi
fi

# Test 2: Request with invalid token
log_test "Test 2: Request with invalid token"

INVALID_RESPONSE=$(api_request "GET" "/collections" "${NAMESPACE}" "invalid-token-12345")
INVALID_CODE=$(echo "${INVALID_RESPONSE}" | tail -n1)

if [ -z "${API_TOKEN}" ]; then
  # Development mode - invalid token might still work
  log_info "ℹ️ Development mode: invalid token may be accepted"
else
  # Production mode - should reject invalid token
  if [ "${INVALID_CODE}" = "401" ]; then
    log_info "✅ Invalid token rejected (401 Unauthorized)"
  else
    log_warn "⚠️ Expected 401 for invalid token, got ${INVALID_CODE}"
  fi
fi

# Test 3: Request with valid token (if token exists)
log_test "Test 3: Request with valid token"

if [ -n "${API_TOKEN}" ]; then
  VALID_RESPONSE=$(api_request "GET" "/collections" "${NAMESPACE}" "${API_TOKEN}")
  VALID_CODE=$(echo "${VALID_RESPONSE}" | tail -n1)

  if [ "${VALID_CODE}" = "200" ]; then
    log_info "✅ Valid token accepted (200 OK)"
  else
    log_warn "⚠️ Valid token returned ${VALID_CODE}"
  fi
else
  log_info "ℹ️ No API token configured - skipping valid token test"
fi

# Test 4: Test different auth header formats
log_test "Test 4: Test different auth header formats"

if [ -n "${API_TOKEN}" ]; then
  # Test "Token" format (alternative to "Bearer")
  TOKEN_RESPONSE=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Token ${API_TOKEN}" \
    "http://qdrant-operator.qdrant-operator:8081/api/v1/collections?namespace=${NAMESPACE}" 2>/dev/null || echo -e "\n000")

  TOKEN_CODE=$(echo "${TOKEN_RESPONSE}" | tail -n1)

  if [ "${TOKEN_CODE}" = "200" ]; then
    log_info "✅ 'Token' format accepted"
  else
    log_warn "⚠️ 'Token' format returned ${TOKEN_CODE}"
  fi
fi

log_info "✅ Authentication tests completed"

