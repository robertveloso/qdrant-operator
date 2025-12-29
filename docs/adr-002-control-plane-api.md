# ADR-002: Operator Control Plane API

## Status

Accepted

## Context

Currently, clients create Qdrant collections directly via the Qdrant API. This leads to:

- Inconsistent configurations (shards, replication, onDisk vary per collection)
- Missing automatic backups (backups must be configured manually)
- Operational risk in restores (manual, error-prone operations)
- Lack of audit trail (no record of who created what, when)
- Tight coupling between applications and Qdrant internals

## Decision

The operator will expose an **internal HTTP REST API** (port 8081) that:

1. **Receives high-level requests** (not Qdrant-raw API calls)
2. **Creates/updates CRDs** internally (`QdrantCollection`, `QdrantCollectionTemplate`, `QdrantCollectionRestore`)
3. **Maintains declarative reconciliation** (existing reconciler handles the rest)
4. **Exposes templates, backups, and restore as first-class resources**

### Architecture

```
Client Application
  ↓ HTTP REST (high-level)
Operator API Server
  ↓ Validates & Creates
Kubernetes CRDs
  ↓ Watch Events
Existing Reconciler
  ↓ Applies
Qdrant Cluster
```

### Key Principles

1. **API does NOT execute actions directly** - it only creates/updates CRDs
2. **Reconciliation remains declarative** - existing reconciler handles all Qdrant operations
3. **Templates enable standardization** - collections created via templates inherit best practices
4. **Backups enabled by default** - templates can include backup configuration
5. **Restore is auditable** - restore operations create CRDs with full history

## Implementation

### New CRDs

1. **QdrantCollectionTemplate** (Cluster-scoped)

   - Reusable collection configurations
   - Includes shards, replication, vectors, backup settings
   - Referenced in API: `POST /api/v1/collections` with `"template": "name"`

2. **QdrantCollectionRestore** (Namespaced)
   - Manages restore operations
   - Status: `Pending` → `InProgress` → `Completed` / `Failed`
   - Created via API: `POST /api/v1/restore/collections/{name}`

### API Endpoints

- `POST /api/v1/collections` - Create collection (with optional template)
- `GET /api/v1/collections` - List collections
- `GET /api/v1/collections/{name}` - Get collection
- `DELETE /api/v1/collections/{name}` - Delete collection
- `GET /api/v1/backups/collections/{name}` - List backups
- `POST /api/v1/restore/collections/{name}` - Restore collection
- `GET /api/v1/restore/collections/{name}` - Get restore status
- `GET /api/v1/templates` - List templates
- `GET /api/v1/templates/{name}` - Get template
- `POST /api/v1/templates` - Create template

### Authentication

- Token-based authentication (environment variable `API_TOKEN`)
- Supports `Bearer <token>` or `Token <token>` format
- If no token configured, allows all requests (development mode only)

## Consequences

### Positive

- **Standardization**: All collections created via API use templates with consistent configs
- **Backups by default**: Templates can include backup configuration
- **Controlled restore**: Restore operations are auditable and retryable
- **Reduced coupling**: Applications don't need to know Qdrant internals
- **Governance**: All collection operations go through operator (can add policies, quotas, etc.)
- **Multi-tenant ready**: API can be extended with namespace isolation, quotas, etc.

### Negative

- **Additional complexity**: Operator now manages an API server
- **New surface area**: API must be maintained, documented, versioned
- **Authentication required**: Must manage tokens/credentials
- **Latency**: Extra hop (API → CRD → Reconciler → Qdrant) vs direct Qdrant calls

### Mitigations

- **Complexity**: API is simple - it only creates CRDs, doesn't duplicate reconciler logic
- **Surface area**: API is intentionally limited (high-level only, no Qdrant-raw)
- **Authentication**: Simple token-based auth, can be enhanced later (mTLS, ServiceAccount)
- **Latency**: Control-plane operations (create/delete) are infrequent; data operations (indexing) still go directly to Qdrant

## Alternatives Considered

1. **Clients call Qdrant directly**

   - Rejected: No governance, no backup by default, no standardization

2. **External scripts/tools**

   - Rejected: No declarative reconciliation, no Kubernetes-native lifecycle

3. **Helm charts for collections**

   - Rejected: Helm doesn't reconcile runtime state, no restore operations

4. **Operator as proxy (executes Qdrant API directly)**
   - Rejected: Breaks declarative model, loses reconciliation benefits, harder to test

## Notes

- API is **internal only** (not exposed publicly by default)
- Clients continue to index/search directly to Qdrant (data-plane)
- API only manages lifecycle (control-plane)
- This aligns with mature operator patterns (e.g., PostgreSQL Operator, MongoDB Operator)
