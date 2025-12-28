import { log } from './utils.js';
import { genericTemplate } from './cluster-template.js';

// prepare connection params
export const getConnectionParameters = async (apiObj, k8sCustomApi, k8sCoreApi) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const clusterName = apiObj.spec.cluster;
  var parameters = {};
  // read the cluster custom object
  try {
    const resCluster = await k8sCustomApi.getNamespacedCustomObjectStatus({
      group: 'qdrant.operator',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'qdrantclusters',
      name: clusterName
    });
    const resCurrent = resCluster;
    // set http or https connection scheme
    if (typeof resCurrent.spec.tls == 'undefined') {
      parameters.url = 'http://';
    } else {
      parameters.url = resCurrent.spec.tls.enabled ? 'https://' : 'http://';
    }
    parameters.url += `${clusterName}.${namespace}:6333/collections/${name}`;
    parameters.headers = { 'Content-Type': 'application/json' };
    // set apikey header if required
    if (resCurrent.spec.apikey !== 'false') {
      const resSecret = await k8sCoreApi.readNamespacedSecret({
        name: `${clusterName}-apikey`,
        namespace: namespace
      });
      const resApikey = atob(resSecret.data['api-key']);
      parameters.headers['api-key'] = resApikey;
    }
    return parameters;
  } catch (err) {
    log(
      `Error getting connection parameters for collection "${name}" in cluster "${clusterName}": ${err.message}`
    );
    throw err;
  }
};

// prepare connection params
const getJobParameters = async (apiObj, k8sCustomApi) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const clusterName = apiObj.spec.cluster;
  var parameters = {};
  // read the cluster custom object
  const resCluster = await k8sCustomApi.getNamespacedCustomObjectStatus({
    group: 'qdrant.operator',
    version: 'v1alpha1',
    namespace: namespace,
    plural: 'qdrantclusters',
    name: clusterName
  });
  const resCurrent = resCluster;
  // set http or https connection scheme
  if (typeof resCurrent.spec.tls == 'undefined') {
    parameters.connectionMethod = 'http';
  } else {
    parameters.connectionMethod = resCurrent.spec.tls.enabled
      ? 'https'
      : 'http';
  }
  parameters.apikeyEnabled = resCurrent.spec.apikey !== 'false';
  parameters.replicas = resCurrent.spec.replicas;
  parameters.jobImage = process.env.JOB_IMAGE;
  return parameters;
};

// apply snapshot jobs
export const applyJobs = async (apiObj, k8sCustomApi, k8sBatchApi) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  // spec.snapshots is undefined, return
  if (typeof apiObj.spec.snapshots == 'undefined') {
    return;
  }
  // get cluster params for the job
  const parameters = await getJobParameters(apiObj, k8sCustomApi);
  // set additional configs
  if (apiObj.spec.snapshots.backupNow) {
    try {
      log(
        `Running a backup job for Collection "${name}" in the Cluster "${apiObj.spec.cluster}"...`
      );
      const newBackupJobTemplate = genericTemplate(
        {
          ...apiObj,
          ...parameters
        },
        'job-backup.jsr'
      );
      await k8sBatchApi.createNamespacedJob({
        namespace: namespace,
        body: newBackupJobTemplate
      });
      log(
        `Backup Job "${newBackupJobTemplate.metadata.name}" was successfully started!`
      );
    } catch (err) {
      log(err);
    }
  }
  if (apiObj.spec.snapshots.restoreSnapshotName !== '') {
    try {
      log(
        `Running a restore job for Collection "${name}" in the Cluster "${apiObj.spec.cluster}"...`
      );
      const newRestoreJobTemplate = genericTemplate(
        {
          ...apiObj,
          ...parameters
        },
        'job-restore.jsr'
      );
      await k8sBatchApi.createNamespacedJob({
        namespace: namespace,
        body: newRestoreJobTemplate
      });
      log(
        `Restore Job "${newRestoreJobTemplate.metadata.name}" was successfully started!`
      );
    } catch (err) {
      log(err);
    }
  }
  if (apiObj.spec.snapshots.backupSchedule !== '') {
    const newBackupCronjobTemplate = genericTemplate(
      {
        ...apiObj,
        ...parameters
      },
      'cronjob-backup.jsr'
    );
    try {
      // read cronjob if exists
      const res = await k8sBatchApi.readNamespacedCronJob({
        name: `${name}-backup`,
        namespace: namespace
      });
      const cronjob = res;
      log(`CronJob "${name}-backup" already exists!`);
      // and replace it
      await k8sBatchApi.replaceNamespacedCronJob({
        name: `${name}-backup`,
        namespace: namespace,
        body: newBackupCronjobTemplate
      });
      log(`CronJob "${name}-backup" was successfully updated!`);
      return;
    } catch (err) {
      log(`CronJob "${name}-backup" is not available. Creating...`);
    }
    try {
      // create new backup cronjob
      await k8sBatchApi.createNamespacedCronJob({
        namespace: namespace,
        body: newBackupCronjobTemplate
      });
      log(`CronJob "${name}-backup" was successfully created!`);
    } catch (err) {
      log(err);
    }
  }
};

export const createCollection = async (apiObj, k8sCustomApi, k8sCoreApi) => {
  const name = apiObj.metadata.name;
  log(
    `🎯 createCollection called for "${name}" in cluster "${apiObj.spec.cluster}"`
  );
  try {
    const parameters = await getConnectionParameters(
      apiObj,
      k8sCustomApi,
      k8sCoreApi
    );
    // prepare payload
    var body = {
      vectors: {
        size: apiObj.spec.vectorSize,
        distance: 'Cosine',
        on_disk: apiObj.spec.onDisk
      },
      shard_number: apiObj.spec.shardNumber,
      replication_factor: apiObj.spec.replicationFactor
    };
    // set additional configs if defined
    if (typeof apiObj.spec.config !== 'undefined') {
      body = { ...body, ...apiObj.spec.config };
    }
    log(
      `Trying to create a Collection "${name}" in the Cluster "${apiObj.spec.cluster}"...`
    );
    log(`   URL: ${parameters.url}`);
    log(`   Body: ${JSON.stringify(body)}`);
    // PUT request to Qdrant API with timeout
    let resp;
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      resp = await fetch(parameters.url, {
        method: 'PUT',
        headers: parameters.headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        log(`❌ Request to Qdrant API timed out after 30 seconds`);
        throw new Error(
          `Request timeout: Failed to create collection "${name}" - Qdrant API did not respond within 30 seconds`
        );
      } else if (
        fetchErr.code === 'ECONNREFUSED' ||
        fetchErr.message.includes('ECONNREFUSED')
      ) {
        log(`❌ Connection refused to Qdrant API at ${parameters.url}`);
        throw new Error(
          `Connection refused: Cannot connect to Qdrant cluster "${apiObj.spec.cluster}". Is the cluster running?`
        );
      } else if (
        fetchErr.code === 'ENOTFOUND' ||
        fetchErr.message.includes('ENOTFOUND')
      ) {
        log(`❌ DNS resolution failed for Qdrant API at ${parameters.url}`);
        throw new Error(
          `DNS resolution failed: Cannot resolve hostname for cluster "${apiObj.spec.cluster}"`
        );
      } else {
        log(`❌ Network error connecting to Qdrant API: ${fetchErr.message}`);
        throw new Error(`Network error: ${fetchErr.message}`);
      }
    }

    // Parse response JSON
    let data;
    try {
      const text = await resp.text();
      if (!text) {
        log(`⚠️ Empty response from Qdrant API`);
        throw new Error('Empty response from Qdrant API');
      }
      data = JSON.parse(text);
    } catch (parseErr) {
      log(`❌ Failed to parse response from Qdrant API: ${parseErr.message}`);
      log(`   Response status: ${resp.status} ${resp.statusText}`);
      log(
        `   Response headers: ${JSON.stringify(Object.fromEntries(resp.headers.entries()))}`
      );
      throw new Error(
        `Invalid JSON response from Qdrant API: ${parseErr.message}`
      );
    }

    log(
      `Response status: "${JSON.stringify(data.status)}", time: "${data.time}".`
    );

    // Check HTTP status code first
    if (!resp.ok) {
      const errorMsg =
        data.status?.error || `HTTP ${resp.status}: ${resp.statusText}`;
      log(
        `❌ Collection creation failed with HTTP ${resp.status}: ${JSON.stringify(errorMsg)}`
      );
      throw new Error(`Failed to create collection: ${errorMsg}`);
    }

    // Check for errors in response body
    // Qdrant API returns { status: { error: "..." } } on error, or { status: "ok" } on success
    if (data.status && typeof data.status === 'object' && data.status.error) {
      const errorMsg = JSON.stringify(data.status.error);
      log(`❌ Collection creation returned error: ${errorMsg}`);
      throw new Error(`Collection creation failed: ${errorMsg}`);
    }

    // Verify success - Qdrant returns status: "ok" on success
    if (data.status === 'ok') {
      log(`✅ Collection "${name}" created successfully`);
    } else if (
      data.status &&
      typeof data.status === 'object' &&
      !data.status.error
    ) {
      // Some Qdrant versions might return different success format
      log(
        `✅ Collection "${name}" created successfully (status: ${JSON.stringify(data.status)})`
      );
    } else {
      // Unexpected response format - log warning but don't fail
      // This handles edge cases where Qdrant might return different formats
      log(
        `⚠️ Unexpected response format for collection "${name}": ${JSON.stringify(data.status)}. Assuming success since HTTP status was ${resp.status}.`
      );
    }
  } catch (err) {
    log(`❌ Error creating collection "${name}": ${err.message}`);
    if (err.stack) {
      log(`   Stack: ${err.stack}`);
    }
    throw err;
  }
};

export const updateCollection = async (apiObj, k8sCustomApi, k8sCoreApi) => {
  const name = apiObj.metadata.name;
  const parameters = await getConnectionParameters(
    apiObj,
    k8sCustomApi,
    k8sCoreApi
  );
  // prepare payload
  var body = {
    vectors: {
      '': {
        size: apiObj.spec.vectorSize,
        distance: 'Cosine',
        on_disk: apiObj.spec.onDisk
      }
    },
    shard_number: apiObj.spec.shardNumber,
    replication_factor: apiObj.spec.replicationFactor
  };
  // set additional configs
  if (typeof apiObj.spec.config !== 'undefined') {
    body = { ...body, ...apiObj.spec.config };
  }
  try {
    log(
      `Trying to update a Collection "${name}" in the Cluster "${apiObj.spec.cluster}"...`
    );
    // PATCH request to Qdrant API
    const resp = await fetch(parameters.url, {
      method: 'PATCH',
      headers: parameters.headers,
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    log(`Status: "${JSON.stringify(data.status)}", time: "${data.time}".`);
  } catch (err) {
    log(err);
  }
};

export const deleteCollection = async (apiObj, k8sCustomApi, k8sCoreApi) => {
  const name = apiObj.metadata.name;
  const parameters = await getConnectionParameters(
    apiObj,
    k8sCustomApi,
    k8sCoreApi
  );
  try {
    log(
      `Trying to delete a Collection "${name}" in the Cluster "${apiObj.spec.cluster}"...`
    );
    // DELETE request to qdrant API
    const resp = await fetch(parameters.url, {
      method: 'DELETE',
      headers: parameters.headers
    });
    const data = await resp.json();
    log(`Status: "${JSON.stringify(data.status)}", time: "${data.time}".`);
  } catch (err) {
    log(err);
  }
};
