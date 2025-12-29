# Operator Control Plane API - Usage Guide

## Overview

The Qdrant Operator exposes a REST API that acts as a **control-plane for data management**. This API provides high-level endpoints for managing collections, templates, backups, and restore operations.

## Architecture

```
Client Application
  ↓ HTTP REST
Operator API (Port 8081)
  ↓ Creates/Updates
Kubernetes CRDs
  ↓ Watch Events
Reconciler
  ↓ Applies
Qdrant Cluster
```

## Authentication

The API uses token-based authentication. Set the `API_TOKEN` environment variable in the operator deployment, then include it in requests:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://qdrant-operator.qdrant-operator:8081/api/v1/collections
```

**Note**: If `API_TOKEN` is not set, the API allows all requests (development mode only).

## Endpoints

### Collections

#### Create Collection

```http
POST /api/v1/collections?namespace=default
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "name": "products",
  "cluster": "my-cluster",
  "template": "default-vectors",
  "vectors": {
    "size": 768,
    "distance": "Cosine"
  },
  "replication": 2,
  "backup": {
    "enabled": true,
    "schedule": "0 2 * * *",
    "retentionCount": 7
  }
}
```

**Response:**
```json
{
  "id": "products",
  "name": "products",
  "namespace": "default",
  "status": "Pending",
  "message": "Collection creation initiated"
}
```

#### List Collections

```http
GET /api/v1/collections?namespace=default
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "items": [
    {
      "id": "products",
      "name": "products",
      "namespace": "default",
      "cluster": "my-cluster",
      "status": "green",
      "shards": 6,
      "replicas": 2,
      "vectorSize": 768,
      "backup": "enabled"
    }
  ],
  "count": 1
}
```

#### Get Collection

```http
GET /api/v1/collections/products?namespace=default
Authorization: Bearer YOUR_TOKEN
```

#### Delete Collection

```http
DELETE /api/v1/collections/products?namespace=default
Authorization: Bearer YOUR_TOKEN
```

### Templates

#### Create Template

```http
POST /api/v1/templates
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "name": "default-vectors",
  "shards": 6,
  "replicationFactor": 2,
  "onDisk": true,
  "vectors": {
    "size": 768,
    "distance": "Cosine"
  },
  "backup": {
    "enabled": true,
    "schedule": "0 2 * * *",
    "retentionCount": 7
  }
}
```

#### List Templates

```http
GET /api/v1/templates
Authorization: Bearer YOUR_TOKEN
```

#### Get Template

```http
GET /api/v1/templates/default-vectors
Authorization: Bearer YOUR_TOKEN
```

### Backups

#### List Collection Backups

```http
GET /api/v1/backups/collections/products?namespace=default
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "items": [
    {
      "id": "products-backup-1234567890",
      "type": "scheduled",
      "status": "completed",
      "createdAt": "2025-01-02T02:00:00Z",
      "completedAt": "2025-01-02T02:05:00Z",
      "backupId": "2025-01-02T02:00:00Z"
    }
  ],
  "count": 1
}
```

### Restore

#### Restore Collection

```http
POST /api/v1/restore/collections/products?namespace=default
Content-Type: application/json
Authorization: Bearer YOUR_TOKEN

{
  "backupId": "2025-01-02T02:00:00Z",
  "mode": "replace",
  "pauseWrites": true
}
```

**Response:**
```json
{
  "id": "products-restore-1234567890",
  "collection": "products",
  "backupId": "2025-01-02T02:00:00Z",
  "status": "Pending",
  "message": "Restore operation initiated"
}
```

#### Get Restore Status

```http
GET /api/v1/restore/collections/products?namespace=default
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "items": [
    {
      "id": "products-restore-1234567890",
      "collection": "products",
      "backupId": "2025-01-02T02:00:00Z",
      "mode": "replace",
      "status": "Completed",
      "message": "Restore completed successfully",
      "startedAt": "2025-01-02T10:00:00Z",
      "completedAt": "2025-01-02T10:05:00Z"
    }
  ],
  "count": 1
}
```

## Examples

### Create Collection with Template

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "products",
    "cluster": "my-cluster",
    "template": "default-vectors"
  }' \
  "http://qdrant-operator.qdrant-operator:8081/api/v1/collections?namespace=default"
```

### Create Collection without Template

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "products",
    "cluster": "my-cluster",
    "vectors": {
      "size": 768,
      "distance": "Cosine"
    },
    "replication": 2
  }' \
  "http://qdrant-operator.qdrant-operator:8081/api/v1/collections?namespace=default"
```

### Restore Collection

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "backupId": "2025-01-02T02:00:00Z",
    "mode": "replace"
  }' \
  "http://qdrant-operator.qdrant-operator:8081/api/v1/restore/collections/products?namespace=default"
```

## Service Discovery

The API is exposed via a Kubernetes Service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: qdrant-operator
  namespace: qdrant-operator
spec:
  ports:
    - name: api
      port: 8081
      targetPort: 8081
```

Access from within the cluster:
- `http://qdrant-operator.qdrant-operator:8081/api/v1/`

Access from outside (requires Ingress or Port Forward):
```bash
kubectl port-forward -n qdrant-operator svc/qdrant-operator 8081:8081
```

## Error Handling

All endpoints return standard HTTP status codes:

- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized
- `404` - Not Found
- `409` - Conflict (resource already exists)
- `500` - Internal Server Error

Error responses include details:

```json
{
  "error": "Validation failed",
  "details": [
    "name is required",
    "cluster is required"
  ]
}
```

