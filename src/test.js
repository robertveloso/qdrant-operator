import test from 'ava';
import {
  clusterTemplate,
  clusterSecretTemplate,
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
