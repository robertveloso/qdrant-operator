# Scope and Design Decisions

## Overview

**This operator is a Kubernetes-native Qdrant database operator; the Qdrant Cloud Operator is a SaaS control-plane distributed system.**

This is a **Kubernetes-native Qdrant database operator** focused on lifecycle management of Qdrant clusters and collections within Kubernetes. It is designed to be simple, predictable, and aligned with standard Kubernetes patterns.

Unlike SaaS control-plane solutions, this operator operates entirely within your Kubernetes cluster, using standard Kubernetes resources and patterns. It does not require external services, billing systems, or cloud-specific orchestration.

**Key distinction**: Many features present in the Cloud Operator are not "missing" from this operator—they are **intentionally out of scope** to maintain simplicity, predictability, and alignment with Kubernetes-native practices.

## Design Principles

The operator follows these core principles:

1. **Kubernetes-native**: Uses standard Kubernetes resources (StatefulSets, Services, PVCs, Secrets, ConfigMaps) and follows Kubernetes best practices
2. **Simplicity and predictability**: Avoids complex orchestration logic; focuses on declarative reconciliation
3. **Self-contained**: No external control-plane dependencies; everything runs within your cluster
4. **Lifecycle management focus**: Manages creation, updates, and deletion of resources; does not optimize performance or make policy decisions
5. **User control**: Users configure resources, scheduling, and scaling; the operator applies the desired state

## What This Operator Does

The operator provides complete lifecycle management for:

### Qdrant Clusters

- Creation and management of StatefulSets for Qdrant database pods
- Configuration of Services (ClusterIP, NodePort, LoadBalancer)
- Persistent Volume Claims for data storage
- TLS encryption (client and peer-to-peer)
- API key authentication (read-write and read-only)
- Pod Disruption Budgets for high availability
- Custom Qdrant configuration via ConfigMaps
- Scheduling options (tolerations, affinities, topology spread constraints)
- Resource requests and limits
- Sidecar containers and additional volumes

### Qdrant Collections

- Creation and management of collections via Qdrant API
- Configuration of replication, sharding, indexing, quantization
- Backup and restore via S3-compatible storage
- Scheduled backups using CronJobs
- Instant backups on demand

### Operator Features

- Leader election for high availability
- Declarative reconciliation with drift detection
- Periodic reconciliation as safety net
- Finalizers for safe resource cleanup
- Spec validation with clear error messages
- Prometheus metrics for operator behavior
- Comprehensive E2E test suite

## What This Operator Does NOT Do (and Why)

### Cluster Manager / Automatic Shard Rebalancing

**What's missing**: External cluster manager service that automatically rebalances shards across nodes.

**Why**: This is a **design decision**, not a limitation. Automatic shard rebalancing requires:

- An external orchestration service (adds complexity)
- Continuous monitoring and decision-making (policy decisions)
- Coordination across multiple clusters (SaaS control-plane territory)

**Our approach**: Users configure shard distribution when creating collections. For rebalancing, users can:

- Use Qdrant's native API to manage shards
- Create new collections with desired shard configuration
- Use external tools if needed

**Impact**: Shard operations are manual **by design**, to keep the operator simple, predictable, and Kubernetes-native.

### Network Policies

**What's missing**: Automatic creation of NetworkPolicies to restrict network access.

**Why**: This is a **potential enhancement**, not a design decision. NetworkPolicies could be added, but:

- Security policies vary significantly between environments
- Users may prefer to manage NetworkPolicies separately
- Not all clusters have NetworkPolicy support enabled

**Our approach**: Users can create NetworkPolicies manually or use external policy management tools.

**Impact**: No default network isolation, but this can be added by users or as a future enhancement.

### VolumeSnapshots (CSI)

**What's missing**: Native Kubernetes VolumeSnapshot support for backing up PVCs.

**Why**: This is a **real gap** that could be implemented. Currently, backups use S3 storage, which is:

- More portable (works across clusters)
- Independent of storage provider
- Suitable for disaster recovery

**Our approach**: S3 backups are fully functional. VolumeSnapshots could be added as an enhancement for:

- Faster restore within the same cluster
- Integration with storage provider snapshots
- Point-in-time recovery using storage-level snapshots

**Impact**: No native PVC backup, but S3 backups provide cross-cluster portability.

### Resource Optimization Automático

**What's missing**: Automatic CPU/memory reservation calculations (e.g., "reserve 20% for OS").

**Why**: This is **intentionally out of scope** and **not desirable** for a self-hosted operator. Resource optimization is:

- Environment-specific (depends on node size, workload, OS)
- A policy decision (users should decide based on their needs)
- Not the operator's responsibility (Kubernetes handles resource allocation)
- SaaS policy, not operator responsibility

**Our approach**: Users configure resource requests and limits based on their requirements. The operator applies them as specified.

**Impact**: Users have full control over resource allocation. The operator does not make policy decisions about resource optimization—this is **by design**.

### Zero-Downtime Upgrade Guarantees

**What's missing**: Automatic zero-downtime upgrade orchestration.

**Why**: This is **not the operator's responsibility**, and **not a design gap**. Zero-downtime depends on:

- Replication factor configuration (user decision)
- Shard distribution (user configuration)
- Traffic patterns (application-level)
- Qdrant's internal consensus mechanism

**Our approach**: The operator performs rolling updates of StatefulSets. Availability during upgrades depends on:

- User's replication factor settings
- User's shard configuration
- Qdrant's built-in high availability features

**Impact**: The operator does not impose zero-downtime policies; availability depends on the topology defined by the user. This is **correct behavior** for a Kubernetes-native operator.

### Métricas Internas do Qdrant DB

**What's missing**: Metrics about shards, consensus, raft, collection internals.

**Why**: This is a **correct boundary**, not a limitation. These metrics are:

- Responsibility of the Qdrant database itself
- Exposed by Qdrant's `/metrics` endpoint
- Should be scraped by Prometheus directly from Qdrant pods

**Our approach**: The operator exposes metrics about its own behavior (reconciliations, errors, queue depth). Qdrant metrics should be scraped from Qdrant pods directly.

**Impact**: Observability is focused on the operator; internal database metrics are the responsibility of Qdrant itself. This is the **correct separation of concerns** and maintains clear boundaries.

### Ingress Management

**What's missing**: Automatic Ingress resource creation and TLS offload configuration.

**Why**: This is a **potential enhancement**. Ingress management is:

- Highly environment-specific (depends on ingress controller)
- Often managed by separate tools (cert-manager, external-dns)
- Can be complex (middlewares, annotations, TLS)

**Our approach**: Users can create Ingress resources manually or use external tools. The operator provides Services that can be exposed via Ingress.

**Impact**: No automatic Ingress, but Services can be exposed via any ingress controller.

## Real Gaps (Potential Future Enhancements)

These are features that could be added if desired:

1. **VolumeSnapshots CSI**: Native Kubernetes snapshot support for PVC backups

   - **Value**: Faster restore, storage-level snapshots
   - **Trade-off**: Less portable than S3 backups

2. **NetworkPolicies Default**: Automatic creation of NetworkPolicies

   - **Value**: Default security posture
   - **Trade-off**: May conflict with existing policies

3. **Status Phases Richer**: More detailed status information

   - **Value**: Better observability
   - **Trade-off**: More complexity in status management

4. **Ingress Management**: Automatic Ingress creation
   - **Value**: Easier external exposure
   - **Trade-off**: Environment-specific complexity

## Boundaries and Responsibilities

### Operator Responsibilities

- Lifecycle management (create, update, delete)
- Declarative reconciliation (desired vs observed state)
- Resource creation (StatefulSets, Services, PVCs, Secrets, ConfigMaps)
- Collection management via Qdrant API
- Backup orchestration (S3)

### User Responsibilities

- Resource sizing (CPU, memory, storage)
- Scheduling decisions (node selectors, tolerations)
- Security policies (NetworkPolicies, RBAC)
- Shard configuration and distribution
- Replication factor decisions
- External exposure (Ingress, LoadBalancer configuration)

### Qdrant Database Responsibilities

- Internal metrics (shards, consensus, raft)
- Query performance
- Data consistency
- High availability (when properly configured)

### Kubernetes Responsibilities

- Resource allocation
- Pod scheduling
- Network policies enforcement
- Storage provisioning

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

This design keeps the operator:

- **Simple**: Easy to understand and maintain
- **Predictable**: Uses standard Kubernetes patterns
- **Flexible**: Users have full control over configuration
- **Reliable**: Focused scope means fewer failure modes

For a detailed comparison with Qdrant Cloud Operator, see [Comparison with Qdrant Cloud Operator](comparison.md).
