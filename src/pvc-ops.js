import { k8sCoreApi, k8sSnapshotApi } from './k8s-client.js';
import { log } from './utils.js';
import { genericTemplate } from './cluster-template.js';

// Convert storage size to bytes for comparison
const parseStorageSize = (sizeStr) => {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*([EPTGMK]i?)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();
  const multipliers = {
    '': 1,
    K: 1000,
    KI: 1024,
    M: 1000 ** 2,
    MI: 1024 ** 2,
    G: 1000 ** 3,
    GI: 1024 ** 3,
    T: 1000 ** 4,
    TI: 1024 ** 4,
    P: 1000 ** 5,
    PI: 1000 ** 5,
    E: 1000 ** 6,
    EI: 1024 ** 6
  };
  return value * (multipliers[unit] || 1);
};

// Check if PVC needs expansion
const needsExpansion = (currentSize, desiredSize) => {
  const currentBytes = parseStorageSize(currentSize);
  const desiredBytes = parseStorageSize(desiredSize);
  return desiredBytes > currentBytes;
};

// Expand PVC automatically when size increases
export const expandPVCIfNeeded = async (apiObj) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const replicas = apiObj.spec.replicas || 1;

  // Only expand if persistence is configured
  if (!apiObj.spec.persistence || !apiObj.spec.persistence.size) {
    return;
  }

  const desiredSize = apiObj.spec.persistence.size;
  const storageClassName = apiObj.spec.persistence.storageClassName || 'default';

  // Check each PVC for the cluster
  for (let i = 0; i < replicas; i++) {
    const pvcName = `qdrant-storage-${name}-${i}`;
    try {
      const pvc = await k8sCoreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: namespace
      });

      const currentSize = pvc.spec.resources?.requests?.storage;
      if (!currentSize) {
        log(`⚠️ PVC "${pvcName}" has no size specified, skipping expansion`);
        continue;
      }

      if (needsExpansion(currentSize, desiredSize)) {
        log(`📈 Expanding PVC "${pvcName}" from ${currentSize} to ${desiredSize}...`);

        // Patch PVC to increase size
        const patch = [
          {
            op: 'replace',
            path: '/spec/resources/requests/storage',
            value: desiredSize
          }
        ];

        await k8sCoreApi.patchNamespacedPersistentVolumeClaim(
          pvcName,
          namespace,
          patch,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            headers: { 'Content-Type': 'application/json-patch+json' }
          }
        );

        log(`✅ PVC "${pvcName}" expansion requested (${currentSize} -> ${desiredSize})`);
        log(
          `ℹ️ Note: PVC expansion may take time depending on storage provider. Pods may need to be restarted.`
        );
      } else if (currentSize !== desiredSize && !needsExpansion(desiredSize, currentSize)) {
        // Size decreased - log warning (Kubernetes doesn't support shrinking)
        log(
          `⚠️ PVC "${pvcName}" size decrease requested (${currentSize} -> ${desiredSize}), but PVCs cannot be shrunk. Current size will be maintained.`
        );
      }
    } catch (err) {
      if (err.statusCode === 404) {
        // PVC doesn't exist yet - will be created with correct size
        log(`ℹ️ PVC "${pvcName}" doesn't exist yet, will be created with size ${desiredSize}`);
      } else {
        log(`⚠️ Error checking/expanding PVC "${pvcName}": ${err.message}`);
      }
    }
  }
};

// Create VolumeSnapshot for PVC backup
export const createVolumeSnapshot = async (
  clusterName,
  namespace,
  snapshotName,
  pvcName,
  snapshotClassName = null
) => {
  try {
    // Check if snapshot already exists
    try {
      await k8sSnapshotApi.getNamespacedCustomObject({
        group: 'snapshot.storage.k8s.io',
        version: 'v1',
        namespace: namespace,
        plural: 'volumesnapshots',
        name: snapshotName
      });
      log(`VolumeSnapshot "${snapshotName}" already exists`);
      return snapshotName;
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
      // Snapshot doesn't exist, create it
    }

    const snapshotBody = {
      apiVersion: 'snapshot.storage.k8s.io/v1',
      kind: 'VolumeSnapshot',
      metadata: {
        name: snapshotName,
        namespace: namespace,
        labels: {
          clustername: clusterName,
          component: 'qdrant',
          'app.kubernetes.io/managed-by': 'qdrant-operator'
        }
      },
      spec: {
        source: {
          persistentVolumeClaimName: pvcName
        },
        ...(snapshotClassName && { volumeSnapshotClassName: snapshotClassName })
      }
    };

    await k8sSnapshotApi.createNamespacedCustomObject(
      'snapshot.storage.k8s.io',
      'v1',
      namespace,
      'volumesnapshots',
      snapshotBody
    );

    log(`✅ VolumeSnapshot "${snapshotName}" created for PVC "${pvcName}"`);
    return snapshotName;
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('not found')) {
      log(
        `⚠️ VolumeSnapshot API not available in this cluster (CSI snapshot feature may not be installed)`
      );
      return null;
    }
    log(`❌ Error creating VolumeSnapshot "${snapshotName}": ${err.message}`);
    throw err;
  }
};

// Get VolumeSnapshot status
export const getVolumeSnapshotStatus = async (snapshotName, namespace) => {
  try {
    const snapshot = await k8sSnapshotApi.getNamespacedCustomObject({
      group: 'snapshot.storage.k8s.io',
      version: 'v1',
      namespace: namespace,
      plural: 'volumesnapshots',
      name: snapshotName
    });

    const status = snapshot.status;
    const ready = status?.readyToUse === true;
    const snapshotHandle = status?.boundVolumeSnapshotContentName;

    return {
      ready,
      snapshotHandle,
      creationTime: status?.creationTime,
      restoreSize: status?.restoreSize
    };
  } catch (err) {
    if (err.statusCode === 404) {
      return null;
    }
    throw err;
  }
};

// Create VolumeSnapshot for all PVCs in a cluster
export const createClusterVolumeSnapshot = async (
  apiObj,
  snapshotName,
  snapshotClassName = null
) => {
  const clusterName = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const replicas = apiObj.spec.replicas || 1;

  if (!apiObj.spec.persistence) {
    log(`⚠️ Cluster "${clusterName}" has no persistence configured, cannot create VolumeSnapshot`);
    return null;
  }

  const snapshots = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (let i = 0; i < replicas; i++) {
    const pvcName = `qdrant-storage-${clusterName}-${i}`;
    const individualSnapshotName = `${snapshotName}-${i}-${timestamp}`;

    try {
      // Verify PVC exists
      await k8sCoreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: namespace
      });

      const createdSnapshot = await createVolumeSnapshot(
        clusterName,
        namespace,
        individualSnapshotName,
        pvcName,
        snapshotClassName
      );

      if (createdSnapshot) {
        snapshots.push({
          pvcName,
          snapshotName: createdSnapshot
        });
      }
    } catch (err) {
      if (err.statusCode === 404) {
        log(`⚠️ PVC "${pvcName}" not found, skipping snapshot`);
      } else {
        log(`⚠️ Error creating snapshot for PVC "${pvcName}": ${err.message}`);
      }
    }
  }

  if (snapshots.length === 0) {
    log(`⚠️ No snapshots created for cluster "${clusterName}"`);
    return null;
  }

  log(`✅ Created ${snapshots.length} VolumeSnapshot(s) for cluster "${clusterName}"`);
  return snapshots;
};

// Restore PVC from VolumeSnapshot
export const restorePVCFromSnapshot = async (
  clusterName,
  namespace,
  pvcName,
  snapshotName,
  storageClassName = null
) => {
  try {
    // Get snapshot details
    const snapshot = await k8sSnapshotApi.getNamespacedCustomObject({
      group: 'snapshot.storage.k8s.io',
      version: 'v1',
      namespace: namespace,
      plural: 'volumesnapshots',
      name: snapshotName
    });

    if (!snapshot.status?.readyToUse) {
      throw new Error(
        `VolumeSnapshot "${snapshotName}" is not ready (status: ${snapshot.status?.boundVolumeSnapshotContentName || 'unknown'})`
      );
    }

    const restoreSize = snapshot.status?.restoreSize;

    // Check if PVC already exists
    let pvcExists = false;
    try {
      await k8sCoreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: namespace
      });
      pvcExists = true;
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
    }

    if (pvcExists) {
      log(`⚠️ PVC "${pvcName}" already exists. Restore requires deleting existing PVC first.`);
      return false;
    }

    // Create PVC from snapshot
    const pvcBody = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: namespace,
        labels: {
          clustername: clusterName,
          component: 'qdrant',
          'app.kubernetes.io/managed-by': 'qdrant-operator',
          'qdrant.operator/restored-from': snapshotName
        }
      },
      spec: {
        dataSource: {
          name: snapshotName,
          kind: 'VolumeSnapshot',
          apiGroup: 'snapshot.storage.k8s.io'
        },
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: restoreSize || '10Gi' // Fallback if restoreSize not available
          }
        },
        ...(storageClassName && { storageClassName })
      }
    };

    await k8sCoreApi.createNamespacedPersistentVolumeClaim({
      namespace: namespace,
      body: pvcBody
    });

    log(`✅ PVC "${pvcName}" created from VolumeSnapshot "${snapshotName}"`);
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('not found')) {
      log(`⚠️ VolumeSnapshot API not available or snapshot not found: ${err.message}`);
      return false;
    }
    log(`❌ Error restoring PVC from snapshot: ${err.message}`);
    throw err;
  }
};

// List VolumeSnapshots for a cluster
export const listClusterVolumeSnapshots = async (clusterName, namespace) => {
  try {
    const snapshots = await k8sSnapshotApi.listNamespacedCustomObject({
      group: 'snapshot.storage.k8s.io',
      version: 'v1',
      namespace: namespace,
      plural: 'volumesnapshots'
    });

    // Filter snapshots for this cluster
    const clusterSnapshots = (snapshots.items || []).filter(
      (snapshot) =>
        snapshot.metadata?.labels?.clustername === clusterName &&
        snapshot.metadata?.labels?.component === 'qdrant'
    );

    return clusterSnapshots.map((snapshot) => ({
      name: snapshot.metadata.name,
      namespace: snapshot.metadata.namespace,
      ready: snapshot.status?.readyToUse || false,
      creationTime: snapshot.status?.creationTime,
      restoreSize: snapshot.status?.restoreSize,
      pvcName: snapshot.spec?.source?.persistentVolumeClaimName
    }));
  } catch (err) {
    if (err.statusCode === 404 || err.message?.includes('not found')) {
      log(`⚠️ VolumeSnapshot API not available: ${err.message}`);
      return [];
    }
    throw err;
  }
};

// Delete old snapshots based on retention policy
export const cleanupOldSnapshots = async (clusterName, namespace, retentionCount) => {
  const snapshots = await listClusterVolumeSnapshots(clusterName, namespace);

  if (snapshots.length <= retentionCount) {
    return;
  }

  // Sort by creation time (oldest first)
  const sortedSnapshots = snapshots
    .filter((s) => s.ready)
    .sort((a, b) => {
      const timeA = a.creationTime ? new Date(a.creationTime).getTime() : 0;
      const timeB = b.creationTime ? new Date(b.creationTime).getTime() : 0;
      return timeA - timeB;
    });

  const toDelete = sortedSnapshots.slice(0, sortedSnapshots.length - retentionCount);

  for (const snapshot of toDelete) {
    try {
      await k8sSnapshotApi.deleteNamespacedCustomObject(
        'snapshot.storage.k8s.io',
        'v1',
        namespace,
        'volumesnapshots',
        snapshot.name
      );
      log(`🗑️ Deleted old VolumeSnapshot "${snapshot.name}" (retention policy)`);
    } catch (err) {
      log(`⚠️ Error deleting snapshot "${snapshot.name}": ${err.message}`);
    }
  }
};

// Create CronJob for scheduled VolumeSnapshots
export const applyVolumeSnapshotCronJob = async (apiObj) => {
  const { k8sBatchApi } = await import('./k8s-client.js');
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const schedule = apiObj.spec.volumeSnapshots?.schedule;

  if (!schedule) {
    // Delete CronJob if schedule was removed
    try {
      await k8sBatchApi.deleteNamespacedCronJob({
        name: `${name}-volumesnapshot`,
        namespace: namespace
      });
      log(`🗑️ Deleted VolumeSnapshot CronJob "${name}-volumesnapshot" (schedule removed)`);
    } catch (err) {
      // CronJob doesn't exist, ignore
    }
    return;
  }

  const snapshotClassName =
    apiObj.spec.volumeSnapshots.snapshotClassName ||
    apiObj.spec.persistence?.volumeSnapshotClassName;
  const retentionCount = apiObj.spec.volumeSnapshots.retentionCount || 7;

  // Create CronJob template
  const cronJobTemplate = genericTemplate(
    {
      ...apiObj,
      snapshotClassName: snapshotClassName || '',
      replicas: apiObj.spec.replicas || 1,
      retentionCount: retentionCount,
      timestamp: Date.now()
    },
    'cronjob-volumesnapshot.jsr'
  );

  try {
    // Check if CronJob exists
    await k8sBatchApi.readNamespacedCronJob({
      name: `${name}-volumesnapshot`,
      namespace: namespace
    });
    // Update existing CronJob
    await k8sBatchApi.replaceNamespacedCronJob({
      name: `${name}-volumesnapshot`,
      namespace: namespace,
      body: cronJobTemplate
    });
    log(`✅ VolumeSnapshot CronJob "${name}-volumesnapshot" updated`);
  } catch (err) {
    if (err.statusCode === 404) {
      // Create new CronJob
      await k8sBatchApi.createNamespacedCronJob({
        namespace: namespace,
        body: cronJobTemplate
      });
      log(`✅ VolumeSnapshot CronJob "${name}-volumesnapshot" created (schedule: ${schedule})`);
    } else {
      log(`⚠️ Error managing VolumeSnapshot CronJob: ${err.message}`);
    }
  }
};
