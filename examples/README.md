# Qdrant Operator Examples

This directory contains example YAML files demonstrating how to use the Qdrant Operator.

## Features

The operator includes the following enterprise-grade features:

- **Finalizers**: Automatically added to resources for safe deletion with cleanup
- **Prometheus Metrics**: Exposed on port 8080 at `/metrics` endpoint
- **Declarative Reconciliation**: Compares desired vs observed state, detects drift
- **Cache (Informer-style)**: Reduces API Server calls for better performance
- **Spec Hash Tracking**: Optimizes reconciliation by comparing spec hashes

## Cluster Examples

### Minimal Cluster (`qdrant-cluster-minimal.yaml`)

Basic cluster with minimal configuration:

```bash
kubectl apply -f examples/qdrant-cluster-minimal.yaml
```

### Cluster with API Keys (`qdrant-cluster-apikey.yaml`)

Cluster with read/write API keys enabled:

```bash
kubectl apply -f examples/qdrant-cluster-apikey.yaml
```

### Cluster with TLS (`qdrant-cluster-tls.yaml`)

Cluster with TLS encryption enabled:

```bash
kubectl apply -f examples/qdrant-cluster-tls.yaml
```

### Complete Cluster (`qdrant-cluster-complete.yaml`)

Production-ready cluster with all features:

- Multiple replicas
- API keys
- TLS
- Persistence
- Resource limits
- Scheduling constraints
- Sidecar containers

```bash
kubectl apply -f examples/qdrant-cluster-complete.yaml
```

## Collection Examples

### Minimal Collection (`qdrant-collection-minimal.yaml`)

Basic collection with default settings:

```bash
kubectl apply -f examples/qdrant-collection-minimal.yaml
```

### Complete Collection (`qdrant-collection-complete.yaml`)

Collection with advanced configuration:

- Custom HNSW parameters
- Quantization
- Snapshot configuration
- Backup scheduling

```bash
kubectl apply -f examples/qdrant-collection-complete.yaml
```

### Collection with Replication (`qdrant-collection-replication.yaml`)

Collection configured for high availability with replication.

### Collection with Snapshots (`qdrant-collection-snapshot.yaml`)

Collection with snapshot and backup configuration.

## Backup Examples

### Collection Backup (`qdrant-collection-backup.yaml`)

Backup management for existing collections (without operator managing the collection itself):

```bash
kubectl apply -f examples/qdrant-collection-backup.yaml
```

This CRD allows you to:
- Create instant backups
- Schedule periodic backups
- Restore from snapshots

## Operator Features

### Finalizers

Finalizers are **automatically added** by the operator. When you delete a resource:

1. Resource enters `deletionTimestamp` state
2. Operator performs cleanup (scale down, resource cleanup)
3. Finalizer is removed
4. Resource is finally deleted

You don't need to manually add finalizers to your resources.

### Prometheus Metrics

The operator exposes metrics on port 8080:

- `/metrics` - Prometheus metrics endpoint
- `/health` - Health check endpoint

Available metrics:
- `qdrant_operator_reconcile_total` - Total reconciliations
- `qdrant_operator_reconcile_duration_seconds` - Reconciliation duration
- `qdrant_operator_reconcile_queue_depth` - Queue depth
- `qdrant_operator_clusters_managed` - Number of managed clusters
- `qdrant_operator_collections_managed` - Number of managed collections
- `qdrant_operator_watch_restarts_total` - Watch restarts
- `qdrant_operator_errors_total` - Error counts
- `qdrant_operator_leader` - Leader election status

### Declarative Reconciliation

The operator uses declarative reconciliation:

- Compares desired (CR spec) vs observed (actual state)
- Detects drift automatically
- Periodic reconciliation every 5 minutes
- Spec hash comparison for fast path optimization

### Status Fields

The operator automatically manages status fields:

- `status.qdrantStatus` - Current status (Pending, Running)
- `status.lastAppliedHash` - Hash of last applied spec (for optimization)
- `status.cleanupPhase` - Cleanup phase during deletion (Retrying, Completed, Failed)
- `status.cleanupAttempts` - Number of cleanup attempts

## Version Information

- **Qdrant Version**: v1.16.3 (latest validated)
- **Operator Version**: 0.3.3+

## Notes

- All examples use the latest validated Qdrant version (v1.16.3)
- Finalizers are managed automatically - no manual configuration needed
- Metrics are available on port 8080 by default
- The operator performs periodic reconciliation to detect and fix drift

