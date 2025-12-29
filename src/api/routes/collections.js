import { k8sCustomApi } from '../../k8s-client.js';
import { log } from '../../utils.js';
import { getTemplate } from '../helpers/templates.js';
import { validateCollectionRequest } from '../helpers/validation.js';

// Extract namespace from query params or default
const getNamespace = (url) => {
    const namespace = url.searchParams.get('namespace') || 'default';
    return namespace;
};

// POST /api/v1/collections - Create collection
const createCollection = async (req, res, namespace) => {
    const body = req.body;

    // Validate request
    const validation = validateCollectionRequest(body);
    if (!validation.valid) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Validation failed', details: validation.errors }));
        return;
    }

    const { name, cluster, template, vectors, replication, backup } = body;

    // Resolve template if provided
    let collectionSpec = {};
    if (template) {
        const templateData = await getTemplate(template);
        if (!templateData) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Template not found', template }));
            return;
        }
        // Merge template with request overrides
        collectionSpec = {
            ...templateData.spec,
            ...(vectors && { vectors }),
            ...(replication && { replicationFactor: replication }),
            ...(backup && { snapshots: backup })
        };
    } else {
        // Direct specification
        collectionSpec = {
            vectorSize: vectors.size,
            ...(vectors.distance && { vectors: { distance: vectors.distance } }),
            ...(replication && { replicationFactor: replication }),
            ...(backup && { snapshots: backup })
        };
    }

    // Create QdrantCollection CRD
    const collectionCR = {
        apiVersion: 'qdrant.operator/v1alpha1',
        kind: 'QdrantCollection',
        metadata: {
            name: name,
            namespace: namespace,
            labels: {
                'app.kubernetes.io/managed-by': 'qdrant-operator-api',
                'qdrant.operator/template': template || 'none'
            }
        },
        spec: {
            cluster: cluster,
            vectorSize: collectionSpec.vectorSize,
            shardNumber: collectionSpec.shards || 1,
            replicationFactor: collectionSpec.replicationFactor || 1,
            onDisk: collectionSpec.onDisk !== false,
            ...(collectionSpec.vectors && collectionSpec.vectors.distance && {
                config: {
                    vectors: {
                        distance: collectionSpec.vectors.distance
                    }
                }
            }),
            ...(collectionSpec.snapshots && { snapshots: collectionSpec.snapshots })
        }
    };

    try {
        const created = await k8sCustomApi.createNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollections',
            collectionCR
        );

        log(`✅ Created QdrantCollection CR via API: ${name} in ${namespace}`);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: created.metadata.name,
            name: created.metadata.name,
            namespace: created.metadata.namespace,
            status: 'Pending',
            message: 'Collection creation initiated'
        }));
    } catch (err) {
        if (err.statusCode === 409) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Collection already exists', name }));
        } else {
            log(`❌ Error creating collection: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create collection', message: err.message }));
        }
    }
};

// GET /api/v1/collections - List collections
const listCollections = async (req, res, namespace) => {
    try {
        const collections = await k8sCustomApi.listNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollections'
        );

        const items = (collections.body?.items || []).map((collection) => ({
            id: collection.metadata.name,
            name: collection.metadata.name,
            namespace: collection.metadata.namespace,
            cluster: collection.spec.cluster,
            status: collection.status?.qdrantStatus || 'Unknown',
            shards: collection.spec.shardNumber || 1,
            replicas: collection.spec.replicationFactor || 1,
            vectorSize: collection.spec.vectorSize,
            backup: collection.spec.snapshots ? 'enabled' : 'disabled'
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items, count: items.length }));
    } catch (err) {
        log(`❌ Error listing collections: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to list collections', message: err.message }));
    }
};

// GET /api/v1/collections/{name} - Get collection
const getCollection = async (req, res, namespace, name) => {
    try {
        const collection = await k8sCustomApi.getNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollections',
            name
        );

        const item = {
            id: collection.metadata.name,
            name: collection.metadata.name,
            namespace: collection.metadata.namespace,
            cluster: collection.spec.cluster,
            status: collection.status?.qdrantStatus || 'Unknown',
            shards: collection.spec.shardNumber || 1,
            replicas: collection.spec.replicationFactor || 1,
            vectorSize: collection.spec.vectorSize,
            onDisk: collection.spec.onDisk !== false,
            backup: collection.spec.snapshots ? 'enabled' : 'disabled',
            createdAt: collection.metadata.creationTimestamp
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(item));
    } catch (err) {
        if (err.statusCode === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Collection not found', name }));
        } else {
            log(`❌ Error getting collection: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get collection', message: err.message }));
        }
    }
};

// DELETE /api/v1/collections/{name} - Delete collection
const deleteCollection = async (req, res, namespace, name) => {
    try {
        await k8sCustomApi.deleteNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollections',
            name
        );

        log(`✅ Deleted QdrantCollection CR via API: ${name} in ${namespace}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: name,
            name: name,
            status: 'Deleting',
            message: 'Collection deletion initiated'
        }));
    } catch (err) {
        if (err.statusCode === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Collection not found', name }));
        } else {
            log(`❌ Error deleting collection: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to delete collection', message: err.message }));
        }
    }
};

// Router for collections endpoints
export const collectionsRouter = async (req, res, pathname, method) => {
    const namespace = getNamespace(new URL(req.url, `http://${req.headers.host}`));
    const pathParts = pathname.split('/').filter(Boolean);

    // /api/v1/collections
    if (pathParts.length === 3) {
        if (method === 'POST') {
            await createCollection(req, res, namespace);
            return true;
        } else if (method === 'GET') {
            await listCollections(req, res, namespace);
            return true;
        }
    }

    // /api/v1/collections/{name}
    if (pathParts.length === 4 && pathParts[3]) {
        const name = pathParts[3];
        if (method === 'GET') {
            await getCollection(req, res, namespace, name);
            return true;
        } else if (method === 'DELETE') {
            await deleteCollection(req, res, namespace, name);
            return true;
        }
    }

    return false;
};

