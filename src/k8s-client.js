import * as k8s from '@kubernetes/client-node';

// Load KubeConfig
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

// Initialize various K8S APIs
export const k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
export const k8sCustomApi = kc.makeApiClient(k8s.CustomObjectsApi);
export const k8sPolicyApi = kc.makeApiClient(k8s.PolicyV1Api);
export const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
export const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
export const k8sCoordinationApi = kc.makeApiClient(k8s.CoordinationV1Api);
export const k8sNetworkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
export const k8sSnapshotApi = kc.makeApiClient(k8s.CustomObjectsApi); // For VolumeSnapshots (snapshot.storage.k8s.io)
export const watch = new k8s.Watch(kc);
