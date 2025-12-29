import { k8sCustomApi } from './k8s-client.js';
import { log } from './utils.js';
import { genericTemplate } from './cluster-template.js';

// Get job parameters for restore
const getRestoreJobParameters = async (restoreObj, k8sCustomApi) => {
  const clusterName = restoreObj.spec.cluster;
  const namespace = restoreObj.metadata.namespace;

  const resCluster = await k8sCustomApi.getNamespacedCustomObjectStatus({
    group: 'qdrant.operator',
    version: 'v1alpha1',
    namespace: namespace,
    plural: 'qdrantclusters',
    name: clusterName
  });

  const resCurrent = resCluster;
  const connectionMethod = resCurrent.spec.tls?.enabled ? 'https' : 'http';
  const apikeyEnabled = resCurrent.spec.apikey !== 'false';
  const replicas = resCurrent.spec.replicas;

  return {
    connectionMethod,
    apikeyEnabled,
    replicas,
    jobImage: process.env.JOB_IMAGE
  };
};

// Execute restore operation
export const executeRestore = async (restoreObj, k8sCustomApi, k8sBatchApi) => {
  const name = restoreObj.metadata.name;
  const namespace = restoreObj.metadata.namespace;
  const collectionName = restoreObj.spec.collection;
  const clusterName = restoreObj.spec.cluster;
  const backupId = restoreObj.spec.backupId;

  log(`🔄 Executing restore for collection "${collectionName}" from backup "${backupId}"`);

  try {
    // Get collection to verify it exists
    const collection = await k8sCustomApi.getNamespacedCustomObject({
      group: 'qdrant.operator',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'qdrantcollections',
      name: collectionName
    });

    // Get restore job parameters
    const parameters = await getRestoreJobParameters(restoreObj, k8sCustomApi);

    // Get collection to get S3 config for restore
    if (!collection.spec.snapshots) {
      throw new Error(
        'Collection does not have snapshot configuration. Cannot restore without S3 config.'
      );
    }

    // Create restore job template data
    // The template expects: spec.cluster, spec.snapshots, metadata.name, etc.
    const restoreJobData = {
      metadata: {
        name: restoreObj.metadata.name,
        namespace: namespace,
        resourceVersion: Date.now().toString()
      },
      spec: {
        cluster: clusterName,
        snapshots: {
          ...collection.spec.snapshots,
          restoreSnapshotName: backupId
        }
      },
      ...parameters,
      collectionName: collectionName,
      restoreSnapshotName: backupId
    };

    const restoreJobTemplate = genericTemplate(restoreJobData, 'job-restore.jsr');

    await k8sBatchApi.createNamespacedJob({
      namespace: namespace,
      body: restoreJobTemplate
    });

    log(`✅ Restore job created: ${restoreJobTemplate.metadata.name}`);
    return restoreJobTemplate.metadata.name;
  } catch (err) {
    log(`❌ Error creating restore job: ${err.message}`);
    throw err;
  }
};

// Update restore status
export const updateRestoreStatus = async (restoreObj, phase, message = null, error = null) => {
  const status = {
    phase: phase,
    ...(message && { message }),
    ...(error && { error }),
    ...(phase === 'InProgress' &&
      !restoreObj.status?.startedAt && {
        startedAt: new Date().toISOString()
      }),
    ...(phase === 'Completed' &&
      !restoreObj.status?.completedAt && {
        completedAt: new Date().toISOString()
      }),
    ...(phase === 'Failed' &&
      !restoreObj.status?.completedAt && {
        completedAt: new Date().toISOString()
      })
  };

  try {
    await k8sCustomApi.patchNamespacedCustomObjectStatus(
      'qdrant.operator',
      'v1alpha1',
      restoreObj.metadata.namespace,
      'qdrantcollectionrestores',
      restoreObj.metadata.name,
      { status },
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/merge-patch+json' }
      }
    );
  } catch (err) {
    log(`⚠️ Error updating restore status: ${err.message}`);
  }
};
