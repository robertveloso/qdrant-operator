# Comparison with Qdrant Cloud Operator

## Introduction

This document provides an honest comparison between this Kubernetes-native Qdrant operator and the Qdrant Cloud Operator. Both serve different use cases and have different design goals.

**Key Distinction**:

- **This operator**: Kubernetes-native, self-hosted, focused on lifecycle management
- **Qdrant Cloud Operator**: SaaS control-plane with cloud-managed orchestration, billing, and SLA enforcement

**Core Concept**: This operator is a **Kubernetes-native Qdrant database operator**; the Qdrant Cloud Operator is a **SaaS control-plane distributed system**. Many differences are not "missing features" but **intentional scope differences**.

This comparison helps you understand when to use each solution based on your requirements.

## Feature Comparison

### Core Features

| Feature                | This Operator             | Qdrant Cloud Operator     | Notes                                  |
| ---------------------- | ------------------------- | ------------------------- | -------------------------------------- |
| Cluster lifecycle      | ✅ Complete               | ✅ Complete               | Both provide full lifecycle management |
| Collection management  | ✅ Complete               | ✅ Complete               | Both manage collections via Qdrant API |
| Multi-node clusters    | ✅ Supported              | ✅ Supported              | Both support horizontal scaling        |
| TLS encryption         | ✅ Client + peer-to-peer  | ✅ Client + peer-to-peer  | Both support TLS                       |
| API key authentication | ✅ Read-write + read-only | ✅ Read-write + read-only | Both support authentication            |
| Custom Qdrant config   | ✅ Via ConfigMap          | ✅ Via operator config    | Different configuration methods        |
| Scheduling options     | ✅ Full support           | ✅ Full support           | Both support K8s scheduling            |

**Verdict**: Core features are **completely covered** by both operators.

### Storage

| Feature               | This Operator           | Qdrant Cloud Operator         | Notes                                     |
| --------------------- | ----------------------- | ----------------------------- | ----------------------------------------- |
| Persistent volumes    | ✅ PVC support          | ✅ PVC support                | Both use standard PVCs                    |
| Storage classes       | ✅ Configurable         | ✅ Configurable               | Both support custom StorageClasses        |
| Volume expansion      | ⚠️ Manual               | ✅ Automatic (online/offline) | Cloud Operator has automatic expansion    |
| Data volume           | ✅ Single PVC           | ✅ Separate PVC               | Cloud Operator uses dedicated data volume |
| Snapshot volume       | ❌ emptyDir (ephemeral) | ✅ Separate PVC               | Cloud Operator persists snapshots         |
| VolumeSnapshots (CSI) | ❌ Not supported        | ✅ Supported                  | Cloud Operator uses CSI snapshots         |
| S3 backups            | ✅ Full support         | ✅ Full support               | Both support S3 backups                   |

**Verdict**: This operator uses S3 for backups (portable, cross-cluster). Cloud Operator adds CSI snapshots (faster, cluster-local).

### Security

| Feature           | This Operator    | Qdrant Cloud Operator | Notes                                  |
| ----------------- | ---------------- | --------------------- | -------------------------------------- |
| TLS               | ✅ Supported     | ✅ Supported          | Both support TLS                       |
| API keys          | ✅ Supported     | ✅ Supported          | Both support authentication            |
| Network Policies  | ❌ Not automatic | ✅ Automatic          | Cloud Operator creates NetworkPolicies |
| Security contexts | ✅ Configurable  | ✅ Configurable       | Both support security contexts         |
| RBAC              | ✅ Standard K8s  | ✅ Standard K8s       | Both use standard RBAC                 |

**Verdict**: This operator relies on users to create NetworkPolicies. Cloud Operator creates them automatically.

### Orchestration

| Feature                     | This Operator        | Qdrant Cloud Operator      | Notes                                        |
| --------------------------- | -------------------- | -------------------------- | -------------------------------------------- |
| Cluster Manager             | ❌ Not included      | ✅ External service        | Cloud Operator uses external cluster-manager |
| Automatic shard rebalancing | ❌ Manual            | ✅ Automatic               | Cloud Operator rebalances automatically      |
| Resharding                  | ❌ Manual (recreate) | ✅ In-place resharding     | Cloud Operator supports resharding           |
| Zero-downtime upgrades      | ⚠️ Depends on config | ✅ Guaranteed (multi-node) | Cloud Operator guarantees zero-downtime      |
| Rolling updates             | ✅ Standard K8s      | ✅ Enhanced                | Cloud Operator has enhanced rollout logic    |

**Verdict**: This operator focuses on lifecycle management **by design** (simplicity, predictability, Kubernetes-native). Cloud Operator adds advanced orchestration via external services, which is appropriate for SaaS but adds complexity and external dependencies.

### Observability

| Feature            | This Operator                    | Qdrant Cloud Operator                     | Notes                                   |
| ------------------ | -------------------------------- | ----------------------------------------- | --------------------------------------- |
| Operator metrics   | ✅ Prometheus                    | ✅ Prometheus                             | Both expose operator metrics            |
| Qdrant DB metrics  | ⚠️ User scrapes                  | ✅ Integrated                             | Cloud Operator integrates DB metrics    |
| Grafana dashboards | ❌ Not provided                  | ✅ Provided                               | Cloud Operator includes dashboards      |
| Status phases      | ⚠️ Basic (Pending/Running/Error) | ✅ Rich (Healthy/OperationInProgress/etc) | Cloud Operator has richer status        |
| Cluster health     | ⚠️ Via Qdrant API                | ✅ Via operator status                    | Cloud Operator exposes health in status |

**Verdict**: This operator focuses on operator metrics. Qdrant metrics should be scraped directly from Qdrant pods—this is the **correct boundary** (not a limitation). Cloud Operator integrates everything, which is appropriate for a SaaS control-plane but not necessary for a database operator.

### Networking

| Feature             | This Operator                      | Qdrant Cloud Operator | Notes                                    |
| ------------------- | ---------------------------------- | --------------------- | ---------------------------------------- |
| Service types       | ✅ ClusterIP/NodePort/LoadBalancer | ✅ All types          | Both support all service types           |
| Ingress             | ❌ Manual                          | ✅ Automatic          | Cloud Operator creates Ingress           |
| Service annotations | ⚠️ Limited                         | ✅ Full support       | Cloud Operator supports annotations      |
| LoadBalancer config | ⚠️ Basic                           | ✅ Cloud-specific     | Cloud Operator has cloud-specific config |

**Verdict**: This operator provides Services; users configure Ingress/LoadBalancer. Cloud Operator automates external exposure.

### Backup and Restore

| Feature               | This Operator    | Qdrant Cloud Operator  | Notes                        |
| --------------------- | ---------------- | ---------------------- | ---------------------------- |
| S3 backups            | ✅ Full support  | ✅ Full support        | Both support S3              |
| Scheduled backups     | ✅ CronJob-based | ✅ Operator-managed    | Different implementation     |
| VolumeSnapshots       | ❌ Not supported | ✅ Supported           | Cloud Operator uses CSI      |
| Restore from S3       | ✅ Supported     | ✅ Supported           | Both support S3 restore      |
| Restore from snapshot | ❌ S3 only       | ✅ S3 + VolumeSnapshot | Cloud Operator supports both |

**Verdict**: This operator uses S3 (portable). Cloud Operator adds CSI snapshots (faster, cluster-local).

### Resource Management

| Feature                  | This Operator   | Qdrant Cloud Operator      | Notes                               |
| ------------------------ | --------------- | -------------------------- | ----------------------------------- |
| Resource requests/limits | ✅ User-defined | ✅ User-defined            | Both support resource configuration |
| Automatic optimization   | ❌ Not included | ✅ 20% reservation default | Cloud Operator has defaults         |
| CPU/memory tuning        | ⚠️ Manual       | ✅ Automatic suggestions   | Cloud Operator provides guidance    |

**Verdict**: This operator gives users full control **by design** (not a limitation). Cloud Operator provides defaults and suggestions, which is appropriate for SaaS but makes policy decisions that may not fit all environments. Resource optimization is **intentionally out of scope** for this operator.

## Analysis by Category

### Core Features: ✅ Completely Covered

Both operators provide complete lifecycle management for Qdrant clusters and collections. There are no gaps in core functionality.

### Storage: Different Approaches

- **This operator**: S3 backups (portable, cross-cluster, disaster recovery friendly)
- **Cloud Operator**: S3 + CSI snapshots (faster restore, storage-level integration)

**Trade-off**: S3 is more portable; CSI snapshots are faster but cluster-local.

### Security: Network Policies Gap

- **This operator**: Users create NetworkPolicies manually
- **Cloud Operator**: Automatic NetworkPolicy creation

**Impact**: This operator requires manual security configuration. This is a **real gap** that could be addressed.

### Orchestration: Design Difference

- **This operator**: Lifecycle management only; users configure shards manually
- **Cloud Operator**: External cluster-manager with automatic rebalancing

**Trade-off**: This operator is simpler and more predictable. Cloud Operator provides automation at the cost of external dependencies.

### Observability: Different Boundaries

- **This operator**: Operator metrics only; Qdrant metrics scraped from pods (correct boundary)
- **Cloud Operator**: Integrated metrics and dashboards

**Trade-off**: This operator maintains clear boundaries. Cloud Operator provides integrated observability.

## When to Use Each

### Use This Operator If:

- ✅ You want a **self-hosted, Kubernetes-native** solution
- ✅ You prefer **full control** over configuration and policies
- ✅ You want **no external dependencies** (no control-plane services)
- ✅ You value **simplicity and predictability**
- ✅ You're comfortable with **manual shard management**
- ✅ You want **portable backups** (S3 works across clusters)
- ✅ You prefer **standard Kubernetes patterns**

**Best for**: Self-hosted Kubernetes, air-gapped environments, organizations that want full control.

### Use Qdrant Cloud Operator If:

- ✅ You want **SaaS-managed orchestration**
- ✅ You need **automatic shard rebalancing**
- ✅ You want **integrated billing and SLA enforcement**
- ✅ You prefer **zero-downtime guarantees** (multi-node)
- ✅ You want **integrated observability** (dashboards, metrics)
- ✅ You need **in-place resharding** without recreating collections
- ✅ You want **automatic NetworkPolicies**

**Best for**: Cloud deployments, organizations that want managed orchestration, teams that prefer automation over control.

## Conclusion

This operator **completely covers** the scope of a **Kubernetes-native Qdrant database operator**, including:

- Complete lifecycle management of clusters and collections
- Security (TLS, API keys)
- Scheduling and resource management
- Functional backups via S3
- Robust declarative reconciliation
- Real E2E tests

The main differences from the Qdrant Cloud Operator are not failures, but **scope differences**:

- The Cloud Operator includes an **external SaaS control-plane**
- Features like automatic resharding, billing, SLA enforcement, and resource optimization are **cloud-managed**, not operator-managed

The main **real gaps** (if desired to evolve) are:

1. VolumeSnapshots CSI (native PVC backup)
2. NetworkPolicies default (security)
3. Richer status phases (observability)

Features like Cluster Manager, zero-downtime guarantees, and automatic resource optimization are **intentionally out of scope** to keep the operator simple, predictable, and aligned with Kubernetes practices.

Both operators are **production-ready** but serve different use cases:

- **This operator**: Focused, Kubernetes-native, self-hosted, user-controlled
- **Qdrant Cloud Operator**: Full-featured, SaaS-integrated, cloud-managed, automation-focused

The choice depends on your requirements:

- **Control vs Automation**: This operator gives you control; Cloud Operator provides automation
- **Simplicity vs Features**: This operator is simpler; Cloud Operator has more features
- **Self-hosted vs SaaS**: This operator is self-contained; Cloud Operator requires cloud services

Neither is "better" — they're designed for different scenarios. This operator excels at being a **reliable, predictable, Kubernetes-native database operator**. The Cloud Operator excels at being a **comprehensive, cloud-managed orchestration platform**.

For detailed scope and design decisions, see [SCOPE.md](SCOPE.md).
