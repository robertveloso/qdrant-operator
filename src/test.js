import test from 'ava';
import {
  clusterTemplate,
  clusterSecretTemplate,
  clusterAuthSecretTemplate,
  clusterReadSecretTemplate,
  clusterConfigmapTemplate,
  genericTemplate
} from './cluster-template.js';

/**
 * Unit Tests for Template Generation
 *
 * Testing Strategy:
 * =================
 * These tests validate deterministic manifest generation from Custom Resources.
 * This is the PRIMARY value of unit tests in Kubernetes operators.
 *
 * What these tests cover:
 * - Template functions produce correct Kubernetes manifests
 * - Spec merging works correctly (minimal vs complete)
 * - OwnerReferences, labels, and metadata are set correctly
 * - Volumes, env vars, sidecars, and all spec fields are properly applied
 * - Structural compatibility and contract enforcement
 *
 * What these tests DON'T cover (and shouldn't):
 * - Watch, leader election, finalizers, reconcile loops
 * - API server behavior, timing, race conditions
 * - These are covered by E2E tests (tests/e2e/)
 *
 * Philosophy:
 * "In Kubernetes operators, unit tests protect the code.
 *  E2E tests protect production."
 */

const clusterMinimalPayload = {
  apiVersion: 'qdrant.operator/v1alpha1',
  kind: 'QdrantCluster',
  metadata: {
    name: 'my-cluster',
    namespace: 'default',
    resourceVersion: '1',
    uid: 'test-uid'
  },
  spec: {
    additionalVolumeMounts: [],
    additionalVolumes: [],
    apikey: 'false',
    image: 'qdrant/qdrant:v1.16.3',
    nodeAffinity: {},
    podAntiAffinity: {},
    readApikey: 'false',
    replicas: 1,
    resources: {},
    service: 'ClusterIP',
    sidecarContainers: [],
    tls: {
      enabled: false
    },
    tolerations: [],
    topologySpreadConstraints: []
  }
};

const clusterCompletePayload = {
  apiVersion: 'qdrant.operator/v1alpha1',
  kind: 'QdrantCluster',
  metadata: {
    name: 'my-cluster',
    namespace: 'default',
    resourceVersion: '2',
    uid: 'some-uid'
  },
  spec: {
    additionalVolumeMounts: [
      {
        mountPath: '/qdrant/newfolder',
        name: 'qdrant-newfolder'
      }
    ],
    additionalVolumes: [
      {
        emptyDir: {},
        name: 'qdrant-newfolder'
      }
    ],
    apikey: 'testkey',
    config: {
      cluster: {
        consensus: {
          tick_period_ms: 50
        }
      }
    },
    image: 'qdrant/qdrant:v1.16.3',
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          preference: {
            matchExpressions: [
              {
                key: 'app.stateful/component',
                operator: 'In',
                values: ['qdrant-operator']
              }
            ]
          },
          weight: 1
        }
      ]
    },
    persistence: {
      size: '1Gi',
      storageClassName: 'default'
    },
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          podAffinityTerm: {
            labelSelector: {
              matchExpressions: [
                {
                  key: 'clustername',
                  operator: 'In',
                  values: ['my-cluster']
                }
              ]
            },
            topologyKey: 'kubernetes.io/hostname'
          },
          weight: 100
        }
      ]
    },
    readApikey: 'false',
    replicas: 3,
    resources: {
      limits: {
        cpu: '1000m',
        memory: '500Mi'
      },
      requests: {
        cpu: '10m',
        memory: '100Mi'
      }
    },
    service: 'ClusterIP',
    sidecarContainers: [
      {
        image: 'nginx:1.25',
        name: 'nginx',
        ports: [
          {
            containerPort: 80
          }
        ]
      }
    ],
    tls: {
      enabled: false
    },
    tolerations: [
      {
        effect: 'NoSchedule',
        key: 'app.stateful/component',
        operator: 'Equal',
        value: 'qdrant-operator'
      }
    ],
    topologySpreadConstraints: [
      {
        labelSelector: {
          matchLabels: {
            clustername: 'my-cluster',
            component: 'qdrant'
          }
        },
        maxSkew: 1,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'DoNotSchedule'
      }
    ]
  }
};

const expectedMinimalTemplate = {
  apiVersion: 'apps/v1',
  kind: 'StatefulSet',
  metadata: {
    name: 'my-cluster',
    namespace: 'default',
    ownerReferences: [
      {
        apiVersion: 'qdrant.operator/v1alpha1',
        kind: 'QdrantCluster',
        name: 'my-cluster',
        uid: 'test-uid'
      }
    ],
    labels: { clustername: 'my-cluster', component: 'qdrant' }
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: { clustername: 'my-cluster', component: 'qdrant' }
    },
    serviceName: 'my-cluster-headless',
    template: {
      metadata: { labels: { clustername: 'my-cluster', component: 'qdrant' } },
      spec: {
        containers: [
          {
            name: 'qdrant',
            image: 'qdrant/qdrant:v1.16.3',
            imagePullPolicy: 'IfNotPresent',
            env: [
              {
                name: 'QDRANT_INIT_FILE_PATH',
                value: '/qdrant/init/.qdrant-initialized'
              },
              { name: 'QDRANT__CLUSTER__ENABLED', value: 'true' }
            ],
            command: ['/bin/bash', '-c'],
            args: ['./config/initialize.sh'],
            ports: [
              { name: 'http', containerPort: 6333 },
              { name: 'grpc', containerPort: 6334 },
              { name: 'p2p', containerPort: 6335 }
            ],
            readinessProbe: {
              tcpSocket: { port: 6333 },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 1,
              failureThreshold: 6,
              successThreshold: 1
            },
            resources: {},
            lifecycle: { preStop: { exec: { command: ['sleep', '3'] } } },
            volumeMounts: [
              { name: 'qdrant-storage', mountPath: '/qdrant/storage' },
              {
                name: 'qdrant-config',
                mountPath: '/qdrant/config/initialize.sh',
                subPath: 'initialize.sh'
              },
              {
                name: 'qdrant-config',
                mountPath: '/qdrant/config/production.yaml',
                subPath: 'production.yaml'
              },
              { name: 'qdrant-snapshots', mountPath: '/qdrant/snapshots' },
              { name: 'qdrant-init', mountPath: '/qdrant/init' }
            ]
          }
        ],
        affinity: { nodeAffinity: {}, podAntiAffinity: {} },
        tolerations: [],
        topologySpreadConstraints: [],
        volumes: [
          {
            name: 'qdrant-config',
            configMap: { name: 'my-cluster', defaultMode: 493 }
          },
          { name: 'qdrant-snapshots', emptyDir: {} },
          { name: 'qdrant-init', emptyDir: {} },
          { name: 'qdrant-storage', emptyDir: {} }
        ]
      }
    },
    volumeClaimTemplates: null
  }
};

const expectedCompleteTemplate = {
  apiVersion: 'apps/v1',
  kind: 'StatefulSet',
  metadata: {
    name: 'my-cluster',
    namespace: 'default',
    ownerReferences: [
      {
        apiVersion: 'qdrant.operator/v1alpha1',
        kind: 'QdrantCluster',
        name: 'my-cluster',
        uid: 'some-uid'
      }
    ],
    labels: { clustername: 'my-cluster', component: 'qdrant' }
  },
  spec: {
    replicas: 3,
    selector: {
      matchLabels: { clustername: 'my-cluster', component: 'qdrant' }
    },
    serviceName: 'my-cluster-headless',
    template: {
      metadata: { labels: { clustername: 'my-cluster', component: 'qdrant' } },
      spec: {
        containers: [
          {
            name: 'qdrant',
            image: 'qdrant/qdrant:v1.16.3',
            imagePullPolicy: 'IfNotPresent',
            env: [
              {
                name: 'QDRANT_INIT_FILE_PATH',
                value: '/qdrant/init/.qdrant-initialized'
              },
              { name: 'QDRANT__CLUSTER__ENABLED', value: 'true' }
            ],
            command: ['/bin/bash', '-c'],
            args: ['./config/initialize.sh'],
            ports: [
              { name: 'http', containerPort: 6333 },
              { name: 'grpc', containerPort: 6334 },
              { name: 'p2p', containerPort: 6335 }
            ],
            readinessProbe: {
              tcpSocket: { port: 6333 },
              initialDelaySeconds: 5,
              periodSeconds: 10,
              timeoutSeconds: 1,
              failureThreshold: 6,
              successThreshold: 1
            },
            resources: {
              limits: { cpu: '1000m', memory: '500Mi' },
              requests: { cpu: '10m', memory: '100Mi' }
            },
            lifecycle: { preStop: { exec: { command: ['sleep', '3'] } } },
            volumeMounts: [
              { name: 'qdrant-storage', mountPath: '/qdrant/storage' },
              {
                name: 'qdrant-config',
                mountPath: '/qdrant/config/initialize.sh',
                subPath: 'initialize.sh'
              },
              {
                name: 'qdrant-config',
                mountPath: '/qdrant/config/production.yaml',
                subPath: 'production.yaml'
              },
              {
                name: 'qdrant-secret',
                mountPath: '/qdrant/config/local.yaml',
                subPath: 'local.yaml'
              },
              { name: 'qdrant-snapshots', mountPath: '/qdrant/snapshots' },
              { name: 'qdrant-init', mountPath: '/qdrant/init' },
              { mountPath: '/qdrant/newfolder', name: 'qdrant-newfolder' }
            ]
          },
          { image: 'nginx:1.25', name: 'nginx', ports: [{ containerPort: 80 }] }
        ],
        affinity: {
          nodeAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              {
                preference: {
                  matchExpressions: [
                    {
                      key: 'app.stateful/component',
                      operator: 'In',
                      values: ['qdrant-operator']
                    }
                  ]
                },
                weight: 1
              }
            ]
          },
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              {
                podAffinityTerm: {
                  labelSelector: {
                    matchExpressions: [
                      {
                        key: 'clustername',
                        operator: 'In',
                        values: ['my-cluster']
                      }
                    ]
                  },
                  topologyKey: 'kubernetes.io/hostname'
                },
                weight: 100
              }
            ]
          }
        },
        tolerations: [
          {
            effect: 'NoSchedule',
            key: 'app.stateful/component',
            operator: 'Equal',
            value: 'qdrant-operator'
          }
        ],
        topologySpreadConstraints: [
          {
            labelSelector: {
              matchLabels: { clustername: 'my-cluster', component: 'qdrant' }
            },
            maxSkew: 1,
            topologyKey: 'topology.kubernetes.io/zone',
            whenUnsatisfiable: 'DoNotSchedule'
          }
        ],
        volumes: [
          {
            name: 'qdrant-config',
            configMap: { name: 'my-cluster', defaultMode: 493 }
          },
          { name: 'qdrant-snapshots', emptyDir: {} },
          { name: 'qdrant-init', emptyDir: {} },
          {
            name: 'qdrant-secret',
            secret: { secretName: 'my-cluster-auth-config', defaultMode: 256 }
          },
          { emptyDir: {}, name: 'qdrant-newfolder' }
        ]
      }
    },
    volumeClaimTemplates: [
      {
        metadata: {
          name: 'qdrant-storage',
          labels: { clustername: 'my-cluster', component: 'qdrant' }
        },
        spec: {
          storageClassName: 'default',
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '1Gi' } }
        }
      }
    ]
  }
};

const expectedCompleteSecretTemplate = {
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: {
    name: 'my-cluster-apikey',
    namespace: 'default',
    ownerReferences: [
      {
        apiVersion: 'qdrant.operator/v1alpha1',
        kind: 'QdrantCluster',
        name: 'my-cluster',
        uid: 'some-uid'
      }
    ]
  },
  data: { 'api-key': 'dGVzdGtleQ==' }
};

const expectedCompleteServiceTemplate = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'my-cluster-headless',
    namespace: 'default',
    ownerReferences: [
      {
        apiVersion: 'qdrant.operator/v1alpha1',
        kind: 'QdrantCluster',
        name: 'my-cluster',
        uid: 'some-uid'
      }
    ]
  },
  spec: {
    clusterIP: 'None',
    publishNotReadyAddresses: true,
    ports: [
      { name: 'http', port: 6333, targetPort: 6333 },
      { name: 'grpc', port: 6334, targetPort: 6334 },
      { name: 'p2p', port: 6335, targetPort: 6335 }
    ],
    selector: { clustername: 'my-cluster', component: 'qdrant' }
  }
};

test('Minimal cluster template', (t) => {
  const actual = clusterTemplate(clusterMinimalPayload);
  t.deepEqual(
    actual,
    expectedMinimalTemplate,
    'Minimal cluster spec should generate correct StatefulSet manifest'
  );
});

test('Complete cluster template', (t) => {
  const actual = clusterTemplate(clusterCompletePayload);
  t.deepEqual(
    actual,
    expectedCompleteTemplate,
    'Complete cluster spec should generate correct StatefulSet with all features'
  );
});

test('Complete cluster apikey secret template', (t) => {
  const actual = clusterSecretTemplate(
    clusterCompletePayload,
    clusterCompletePayload.spec.apikey
  );
  t.deepEqual(
    actual,
    expectedCompleteSecretTemplate,
    'API key secret should be correctly generated and base64 encoded'
  );
});

test('Complete cluster headless service template', (t) => {
  const actual = genericTemplate(
    clusterCompletePayload,
    'service-headless.jsr'
  );
  t.deepEqual(
    actual,
    expectedCompleteServiceTemplate,
    'Headless service template should have correct clusterIP and ports'
  );
});

test('Cluster auth secret template without read-only apikey', (t) => {
  const actual = clusterAuthSecretTemplate(
    clusterCompletePayload,
    'testkey',
    'false'
  );
  t.is(actual.kind, 'Secret');
  t.is(actual.metadata.name, 'my-cluster-auth-config');
  t.truthy(actual.data['local.yaml']);
  // Decode and verify content
  const decoded = atob(actual.data['local.yaml']);
  t.true(decoded.includes('api_key: testkey'));
  t.false(decoded.includes('read_only_api_key'));
});

test('Cluster auth secret template with read-only apikey', (t) => {
  const actual = clusterAuthSecretTemplate(
    clusterCompletePayload,
    'testkey',
    'readonlykey'
  );
  t.is(actual.kind, 'Secret');
  t.is(actual.metadata.name, 'my-cluster-auth-config');
  t.truthy(actual.data['local.yaml']);
  // Decode and verify content
  const decoded = atob(actual.data['local.yaml']);
  t.true(decoded.includes('api_key: testkey'));
  t.true(decoded.includes('read_only_api_key: readonlykey'));
});

test('Cluster read-only secret template', (t) => {
  const actual = clusterReadSecretTemplate(
    clusterCompletePayload,
    'readonlykey'
  );
  t.is(actual.kind, 'Secret');
  t.is(actual.metadata.name, 'my-cluster-read-apikey');
  t.is(actual.data['api-key'], btoa('readonlykey'));
});

test('Cluster configmap template with config', (t) => {
  const actual = clusterConfigmapTemplate(clusterCompletePayload);
  t.is(actual.kind, 'ConfigMap');
  t.is(actual.metadata.name, 'my-cluster');
  t.truthy(actual.data['production.yaml']);
  // Verify YAML content includes config values
  const yamlContent = actual.data['production.yaml'];
  t.true(yamlContent.includes('consensus:'));
  t.true(yamlContent.includes('tick_period_ms: 50'));
});

test('Cluster configmap template without config', (t) => {
  const actual = clusterConfigmapTemplate(clusterMinimalPayload);
  t.is(actual.kind, 'ConfigMap');
  t.is(actual.metadata.name, 'my-cluster');
  t.is(actual.data['production.yaml'], '');
});

test('NetworkPolicy template', (t) => {
  const actual = genericTemplate(
    clusterCompletePayload,
    'networkpolicy.jsr'
  );
  t.is(actual.kind, 'NetworkPolicy');
  t.is(actual.metadata.name, 'my-cluster');
  t.deepEqual(actual.spec.podSelector.matchLabels, {
    clustername: 'my-cluster',
    component: 'qdrant'
  });
  t.true(actual.spec.policyTypes.includes('Ingress'));
  t.true(actual.spec.policyTypes.includes('Egress'));
  t.truthy(actual.spec.ingress);
  t.truthy(actual.spec.egress);
});

test('PodDisruptionBudget template', (t) => {
  const actual = genericTemplate(clusterCompletePayload, 'pdb.jsr');
  t.is(actual.kind, 'PodDisruptionBudget');
  t.is(actual.metadata.name, 'my-cluster');
  t.is(actual.spec.minAvailable, '50%');
  t.deepEqual(actual.spec.selector.matchLabels, {
    clustername: 'my-cluster',
    component: 'qdrant'
  });
});

test('Service template (ClusterIP)', (t) => {
  const actual = genericTemplate(clusterCompletePayload, 'service.jsr');
  t.is(actual.kind, 'Service');
  t.is(actual.metadata.name, 'my-cluster');
  t.is(actual.spec.type, 'ClusterIP');
  t.is(actual.spec.ports.length, 3);
  t.true(actual.spec.ports.some((p) => p.name === 'http' && p.port === 6333));
  t.true(actual.spec.ports.some((p) => p.name === 'grpc' && p.port === 6334));
  t.true(actual.spec.ports.some((p) => p.name === 'p2p' && p.port === 6335));
});

test('Service template (NodePort)', (t) => {
  const nodePortPayload = {
    ...clusterCompletePayload,
    spec: { ...clusterCompletePayload.spec, service: 'NodePort' }
  };
  const actual = genericTemplate(nodePortPayload, 'service.jsr');
  t.is(actual.spec.type, 'NodePort');
});

test('Service template (LoadBalancer)', (t) => {
  const lbPayload = {
    ...clusterCompletePayload,
    spec: { ...clusterCompletePayload.spec, service: 'LoadBalancer' }
  };
  const actual = genericTemplate(lbPayload, 'service.jsr');
  t.is(actual.spec.type, 'LoadBalancer');
});

test('Edge case: Empty arrays for additional volumes and mounts', (t) => {
  const payloadWithEmptyArrays = {
    ...clusterMinimalPayload,
    spec: {
      ...clusterMinimalPayload.spec,
      additionalVolumeMounts: [],
      additionalVolumes: [],
      sidecarContainers: []
    }
  };
  const actual = clusterTemplate(payloadWithEmptyArrays);
  t.truthy(actual);
  t.is(actual.kind, 'StatefulSet');
  // Should not crash with empty arrays
  t.truthy(actual.spec.template.spec.containers);
  t.truthy(actual.spec.template.spec.volumes);
});

test('Edge case: Missing optional fields', (t) => {
  const minimalPayload = {
    ...clusterMinimalPayload,
    spec: {
      replicas: 1,
      image: 'qdrant/qdrant:v1.16.3',
      service: 'ClusterIP',
      apikey: 'false',
      readApikey: 'false',
      tls: { enabled: false },
      // Include required array fields as empty arrays
      additionalVolumeMounts: [],
      additionalVolumes: [],
      sidecarContainers: [],
      tolerations: [],
      topologySpreadConstraints: [],
      nodeAffinity: {},
      podAntiAffinity: {},
      resources: {}
    }
  };
  const actual = clusterTemplate(minimalPayload);
  t.truthy(actual);
  t.is(actual.kind, 'StatefulSet');
  // Should handle missing fields gracefully
  t.truthy(actual.spec.template.spec.containers[0]);
});

test('Job backup template structure', (t) => {
  const backupJobData = {
    metadata: {
      name: 'test-collection',
      namespace: 'default',
      resourceVersion: '123'
    },
    spec: {
      cluster: 'my-cluster',
      snapshots: {
        s3CredentialsSecretName: 'bucket-credentials',
        bucketName: 'test-bucket',
        s3EndpointURL: 'https://s3.amazonaws.com'
      }
    },
    apikeyEnabled: true,
    jobImage: 'qdrant/backup:latest'
  };
  const actual = genericTemplate(backupJobData, 'job-backup.jsr');
  t.is(actual.kind, 'Job');
  t.is(actual.metadata.name, 'test-collection-backup-123');
  t.is(actual.spec.template.spec.containers[0].name, 'backup');
  t.is(actual.spec.template.spec.containers[0].image, 'qdrant/backup:latest');
  // Verify environment variables
  const envVars = actual.spec.template.spec.containers[0].env;
  t.true(envVars.some((e) => e.name === 'CLUSTER_NAME' && e.value === 'my-cluster'));
  t.true(envVars.some((e) => e.name === 'BUCKET_NAME' && e.value === 'test-bucket'));
});

test('Job restore template structure', (t) => {
  const restoreJobData = {
    metadata: {
      name: 'test-restore',
      namespace: 'default',
      resourceVersion: '456'
    },
    spec: {
      cluster: 'my-cluster',
      snapshots: {
        s3CredentialsSecretName: 'bucket-credentials',
        bucketName: 'test-bucket',
        s3EndpointURL: 'https://s3.amazonaws.com',
        restoreSnapshotName: 'backup-2024-01-01'
      }
    },
    collectionName: 'test-collection',
    restoreSnapshotName: 'backup-2024-01-01',
    apikeyEnabled: true,
    connectionMethod: 'http',
    replicas: 3,
    jobImage: 'qdrant/restore:latest'
  };
  const actual = genericTemplate(restoreJobData, 'job-restore.jsr');
  t.is(actual.kind, 'Job');
  t.is(actual.metadata.name, 'test-restore-restore-456');
  t.is(actual.spec.template.spec.containers[0].name, 'restore');
  // Verify restore-specific env vars
  const envVars = actual.spec.template.spec.containers[0].env;
  t.true(envVars.some((e) => e.name === 'COLLECTION_NAME' && e.value === 'test-collection'));
  t.true(envVars.some((e) => e.name === 'SNAPSHOT_NAME' && e.value === 'backup-2024-01-01'));
});

test('Job volumesnapshot template structure', (t) => {
  const snapshotJobData = {
    metadata: {
      name: 'my-cluster',
      namespace: 'default',
      uid: 'test-uid'
    },
    apiVersion: 'qdrant.operator/v1alpha1',
    kind: 'QdrantCluster',
    replicas: 3,
    snapshotClassName: 'csi-snapshotter',
    timestamp: '1234567890'
  };
  const actual = genericTemplate(snapshotJobData, 'job-volumesnapshot.jsr');
  t.is(actual.kind, 'Job');
  t.true(actual.metadata.name.includes('my-cluster-volumesnapshot'));
  t.is(actual.spec.template.spec.containers[0].name, 'volumesnapshot');
  t.is(actual.spec.template.spec.serviceAccountName, 'qdrant-operator-sa');
  // Verify owner reference
  t.truthy(actual.metadata.ownerReferences);
  t.is(actual.metadata.ownerReferences[0].kind, 'QdrantCluster');
});
