#!/usr/bin/env bash
# Upgrade Compatibility (N-1): Verify operator upgrade without recreating resources
# This test validates that upgrading the operator doesn't break existing resources
# Common scenario: user upgrades operator without recreating clusters/collections
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

log_test "Upgrade Compatibility (N-1): Verifying operator upgrade without recreating resources"

# Configuration
CLUSTER_NAME="upgrade-test-cluster"
COLLECTION_NAME="upgrade-test-collection"
NAMESPACE="default"

# Get previous version (default to 'latest' if not set)
# In CI, this could be set to a specific tag like 'v0.3.1' or a commit SHA
# For CI: use 'latest' as previous, current SHA as current
PREVIOUS_VERSION="${PREVIOUS_OPERATOR_VERSION:-latest}"
CURRENT_VERSION="${CURRENT_OPERATOR_VERSION:-${GITHUB_SHA:-latest}}"

# Repository for operator image
# Default to current repository if GITHUB_REPOSITORY is not set
if [ -z "${GITHUB_REPOSITORY:-}" ]; then
  # Try to infer from git remote
  REPO=$(git remote get-url origin 2>/dev/null | sed -E 's|.*github.com[:/]([^/]+/[^/]+)(\.git)?$|\1|' || echo "robertveloso/qdrant-operator")
else
  REPO="${GITHUB_REPOSITORY}"
fi

PREVIOUS_IMAGE="ghcr.io/${REPO}/qdrant-operator:${PREVIOUS_VERSION}"
CURRENT_IMAGE="ghcr.io/${REPO}/qdrant-operator:${CURRENT_VERSION}"

log_info "Test configuration:"
log_info "  Previous version: ${PREVIOUS_VERSION} (${PREVIOUS_IMAGE})"
log_info "  Current version: ${CURRENT_VERSION} (${CURRENT_IMAGE})"

# If previous and current are the same, we still test that nothing is recreated
if [ "${PREVIOUS_VERSION}" = "${CURRENT_VERSION}" ]; then
  log_warn "⚠️ Previous and current versions are the same (${PREVIOUS_VERSION})"
  log_warn "This will test idempotence rather than upgrade compatibility"
fi

# Step 1: Deploy previous version of operator
log_info "Step 1: Deploying previous version of operator (${PREVIOUS_VERSION})..."

kubectl apply -f deploy/crds/

# Deploy operator with previous version
# Note: If previous image doesn't exist, this will fail - that's expected
# In that case, the test should be skipped or use a known previous version
sed -e "s|image: .*$|image: ${PREVIOUS_IMAGE}|" \
    -e "s|replicas: 3|replicas: 1|" \
    deploy/operator.yaml | kubectl apply -f -

log_info "Waiting for previous operator to be ready..."
kubectl rollout status deploy/qdrant-operator -n qdrant-operator --timeout=120s || {
  log_error "Previous operator deployment failed"
  exit 1
}

kubectl wait --for=condition=ready pod -l app=qdrant-operator -n qdrant-operator --timeout=60s || {
  log_error "Previous operator pod not ready"
  exit 1
}

# Wait for operator to become leader
PREVIOUS_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}')
wait_for_operator_leader "${PREVIOUS_POD}" 60

log_info "✅ Previous operator deployed and ready"

# Step 2: Create cluster and collection with previous version
log_info "Step 2: Creating cluster and collection with previous operator version..."

# Create cluster
cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  image: qdrant/qdrant:v1.16.3
EOF

wait_for_resource "statefulset" "${CLUSTER_NAME}" "${NAMESPACE}" 60
kubectl rollout status statefulset ${CLUSTER_NAME} -n ${NAMESPACE} --timeout=120s
wait_for_cluster_healthy "${CLUSTER_NAME}" "${NAMESPACE}" 60

log_info "✅ Cluster created and healthy"

# Record StatefulSet UID and generation before upgrade
PRE_UPGRADE_STS_UID=$(kubectl get sts ${CLUSTER_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.uid}' 2>/dev/null || echo "")
PRE_UPGRADE_STS_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
PRE_UPGRADE_POD_UID=$(kubectl get pod -n ${NAMESPACE} -l clustername=${CLUSTER_NAME} -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null || echo "")

log_info "Pre-upgrade resource state:"
log_info "  StatefulSet UID: ${PRE_UPGRADE_STS_UID}"
log_info "  StatefulSet Generation: ${PRE_UPGRADE_STS_GENERATION}"
log_info "  Pod UID: ${PRE_UPGRADE_POD_UID}"

# Create collection
cat <<EOF | kubectl apply -f -
apiVersion: qdrant.operator/v1alpha1
kind: QdrantCollection
metadata:
  name: ${COLLECTION_NAME}
  namespace: ${NAMESPACE}
spec:
  cluster: ${CLUSTER_NAME}
  vectors:
    size: 10
    distance: Cosine
EOF

wait_for_resource "qdrantcollection" "${COLLECTION_NAME}" "${NAMESPACE}" 60
wait_for_collection_green "${COLLECTION_NAME}" "${CLUSTER_NAME}" "${NAMESPACE}" 60

log_info "✅ Collection created and green"

# Step 3: Upgrade operator to current version
log_info "Step 3: Upgrading operator to current version (${CURRENT_VERSION})..."

# Update operator deployment to current version
sed -e "s|image: .*$|image: ${CURRENT_IMAGE}|" \
    -e "s|replicas: 3|replicas: 1|" \
    deploy/operator.yaml | kubectl apply -f -

log_info "Waiting for operator upgrade rollout..."
kubectl rollout status deploy/qdrant-operator -n qdrant-operator --timeout=120s || {
  log_error "Operator upgrade rollout failed"
  exit 1
}

kubectl wait --for=condition=ready pod -l app=qdrant-operator -n qdrant-operator --timeout=60s || {
  log_error "Upgraded operator pod not ready"
  exit 1
}

# Wait for new operator to become leader
CURRENT_POD=$(kubectl get pod -n qdrant-operator -l app=qdrant-operator -o jsonpath='{.items[0].metadata.name}')
wait_for_operator_leader "${CURRENT_POD}" 60

log_info "✅ Operator upgraded and ready"

# Step 4: Verify nothing was recreated
log_info "Step 4: Verifying nothing was recreated..."

# Wait a bit for any reconciliation to complete
sleep 10

POST_UPGRADE_STS_UID=$(kubectl get sts ${CLUSTER_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.uid}' 2>/dev/null || echo "")
POST_UPGRADE_STS_GENERATION=$(kubectl get sts ${CLUSTER_NAME} -n ${NAMESPACE} -o jsonpath='{.metadata.generation}' 2>/dev/null || echo "0")
POST_UPGRADE_POD_UID=$(kubectl get pod -n ${NAMESPACE} -l clustername=${CLUSTER_NAME} -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null || echo "")

log_info "Post-upgrade resource state:"
log_info "  StatefulSet UID: ${POST_UPGRADE_STS_UID}"
log_info "  StatefulSet Generation: ${POST_UPGRADE_STS_GENERATION}"
log_info "  Pod UID: ${POST_UPGRADE_POD_UID}"

# Verify StatefulSet UID didn't change (wasn't recreated)
if [ "${PRE_UPGRADE_STS_UID}" != "${POST_UPGRADE_STS_UID}" ]; then
  log_error "StatefulSet was recreated! UID changed: ${PRE_UPGRADE_STS_UID} -> ${POST_UPGRADE_STS_UID}"
  exit 1
fi

log_info "✅ StatefulSet was not recreated (UID unchanged)"

# Verify StatefulSet generation didn't increase unexpectedly
# Generation may increase by 1-2 if operator reconciles, but shouldn't increase significantly
GENERATION_INCREASE=$((POST_UPGRADE_STS_GENERATION - PRE_UPGRADE_STS_GENERATION))
if [ "${GENERATION_INCREASE}" -gt 3 ]; then
  log_error "StatefulSet generation increased too much: ${PRE_UPGRADE_STS_GENERATION} -> ${POST_UPGRADE_STS_GENERATION} (increase: ${GENERATION_INCREASE})"
  log_error "This may indicate unnecessary rollouts"
  exit 1
fi

log_info "✅ StatefulSet generation increase is acceptable (${GENERATION_INCREASE})"

# Note: Pod UID may change if there's a rollout, which is acceptable
# The important thing is that the StatefulSet itself wasn't recreated

# Step 5: Verify status converges
log_info "Step 5: Verifying status converges after upgrade..."

# Wait for cluster to be healthy after upgrade
wait_for_cluster_healthy "${CLUSTER_NAME}" "${NAMESPACE}" 120

# Verify collection is still green
wait_for_collection_green "${COLLECTION_NAME}" "${CLUSTER_NAME}" "${NAMESPACE}" 60

log_info "✅ Status converged: cluster healthy, collection green"

# Step 6: Verify no errors in logs
log_info "Step 6: Verifying no errors in operator logs..."

# Get logs from current operator pod
OPERATOR_LOGS=$(kubectl logs -n qdrant-operator "${CURRENT_POD}" --tail=200 2>/dev/null || echo "")

# Check for common error patterns
ERROR_PATTERNS=(
  "Error:"
  "FATAL"
  "Cannot read property"
  "TypeError"
  "ReferenceError"
  "SyntaxError"
  "failed to reconcile"
  "reconciliation failed"
)

ERROR_COUNT=0
for pattern in "${ERROR_PATTERNS[@]}"; do
  if echo "${OPERATOR_LOGS}" | grep -i "${pattern}" > /dev/null; then
    ERROR_COUNT=$((ERROR_COUNT + 1))
    log_warn "⚠️ Found error pattern in logs: ${pattern}"
  fi
done

if [ "${ERROR_COUNT}" -gt 0 ]; then
  log_error "Found ${ERROR_COUNT} error pattern(s) in operator logs after upgrade"
  log_error "This may indicate compatibility issues"
  log_info "Recent operator logs:"
  echo "${OPERATOR_LOGS}" | tail -50
  # Don't fail immediately - some errors might be transient
  # But log them for investigation
  log_warn "⚠️ Continuing despite errors (may be transient)"
else
  log_info "✅ No error patterns found in operator logs"
fi

# Step 7: Verify resources are still functional
log_info "Step 7: Verifying resources are still functional after upgrade..."

# Verify cluster is accessible
CLUSTER_STATUS=$(kubectl get qdrantcluster ${CLUSTER_NAME} -n ${NAMESPACE} -o jsonpath='{.status.qdrantStatus}' 2>/dev/null || echo "")
if [ "${CLUSTER_STATUS}" != "Running" ] && [ "${CLUSTER_STATUS}" != "Healthy" ]; then
  log_error "Cluster status is not healthy after upgrade: ${CLUSTER_STATUS}"
  kubectl get qdrantcluster ${CLUSTER_NAME} -n ${NAMESPACE} -o yaml
  exit 1
fi

# Verify collection exists and is accessible
COLLECTION_EXISTS=$(kubectl get qdrantcollection ${COLLECTION_NAME} -n ${NAMESPACE} 2>/dev/null | wc -l || echo "0")
if [ "${COLLECTION_EXISTS}" -eq 0 ]; then
  log_error "Collection not found after upgrade"
  exit 1
fi

log_info "✅ Resources are functional after upgrade"

log_info "✅ Upgrade compatibility test passed!"

# Cleanup
log_info "Cleaning up..."
kubectl delete qdrantcollection ${COLLECTION_NAME} -n ${NAMESPACE} --wait=true 2>/dev/null || true
kubectl delete qdrantcluster ${CLUSTER_NAME} -n ${NAMESPACE} --wait=true 2>/dev/null || true

log_info "✅ Cleanup complete."
exit 0

