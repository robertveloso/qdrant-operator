import { createHash } from 'crypto';
import { k8sCustomApi } from './k8s-client.js';
import { settingStatus } from './state.js';

// Calculate hash of spec for observed state tracking (formalizes "Observed State")
export const calculateSpecHash = (spec) => {
  // Normalize spec by selecting fields that affect reconciliation
  // and sorting to ensure consistent hashing
  const normalized = {
    replicas: spec.replicas,
    image: spec.image,
    apikey: spec.apikey,
    readApikey: spec.readApikey,
    tls: spec.tls,
    resources: spec.resources,
    persistence: spec.persistence,
    service: spec.service
  };
  const specString = JSON.stringify(normalized);
  return createHash('sha256').update(specString).digest('hex').substring(0, 16); // Use first 16 chars for brevity
};

// Update last applied hash in status (for observed state tracking)
export const updateLastAppliedHash = async (apiObj, hash) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const resourceKey = `${namespace}/${name}`;
  settingStatus.set(resourceKey, 'update');

  const maxRetries = 3;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const readObj = await k8sCustomApi.getNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name
      });
      const resCurrent = readObj;
      const newStatus = {
        apiVersion: apiObj.apiVersion,
        kind: apiObj.kind,
        metadata: {
          name: apiObj.metadata.name,
          resourceVersion: resCurrent.metadata.resourceVersion
        },
        status: {
          ...resCurrent.status,
          lastAppliedHash: hash
        }
      };

      await k8sCustomApi.replaceNamespacedCustomObjectStatus({
        group: 'qdrant.operator',
        version: 'v1alpha1',
        namespace: namespace,
        plural: 'qdrantclusters',
        name: name,
        body: newStatus
      });
      setTimeout(() => settingStatus.delete(resourceKey), 300);
      return;
    } catch (err) {
      const errorCode =
        err.code || err.statusCode || (err.body && JSON.parse(err.body).code);
      if (
        errorCode === 409 ||
        (err.message && err.message.includes('Conflict'))
      ) {
        retries++;
        if (retries < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * retries));
          continue;
        }
      } else {
        setTimeout(() => settingStatus.delete(resourceKey), 300);
        return;
      }
    }
  }
  setTimeout(() => settingStatus.delete(resourceKey), 300);
};
