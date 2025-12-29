import { k8sCustomApi } from '../../k8s-client.js';
import { log } from '../../utils.js';

// Extract namespace from query params or default
const getNamespace = (url) => {
    const namespace = url.searchParams.get('namespace') || 'default';
    return namespace;
};

// POST /api/v1/restore/collections/{name} - Restore collection from backup
const restoreCollection = async (req, res, namespace, collectionName) => {
    const body = req.body;

    // Validate request
    if (!body.backupId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'backupId is required' }));
        return;
    }

    try {
        // Get collection to find cluster
        const collection = await k8sCustomApi.getNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollections',
            collectionName
        );

        const clusterName = collection.spec.cluster;

        // Create QdrantCollectionRestore CRD
        const restoreCR = {
            apiVersion: 'qdrant.operator/v1alpha1',
            kind: 'QdrantCollectionRestore',
            metadata: {
                name: `${collectionName}-restore-${Date.now()}`,
                namespace: namespace,
                labels: {
                    'app.kubernetes.io/managed-by': 'qdrant-operator-api',
                    'qdrant.operator/collection': collectionName
                }
            },
            spec: {
                collection: collectionName,
                cluster: clusterName,
                backupId: body.backupId,
                mode: body.mode || 'replace',
                pauseWrites: body.pauseWrites !== false
            }
        };

        const created = await k8sCustomApi.createNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollectionrestores',
            restoreCR
        );

        log(`✅ Created QdrantCollectionRestore CR via API: ${created.metadata.name}`);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: created.metadata.name,
            collection: collectionName,
            backupId: body.backupId,
            status: 'Pending',
            message: 'Restore operation initiated'
        }));
    } catch (err) {
        if (err.statusCode === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Collection not found', name: collectionName }));
        } else {
            log(`❌ Error creating restore: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to initiate restore', message: err.message }));
        }
    }
};

// GET /api/v1/restore/collections/{name} - Get restore status
const getRestoreStatus = async (req, res, namespace, collectionName) => {
    try {
        // List restore CRs for this collection
        const restores = await k8sCustomApi.listNamespacedCustomObject(
            'qdrant.operator',
            'v1alpha1',
            namespace,
            'qdrantcollectionrestores'
        );

        const collectionRestores = (restores.body?.items || []).filter(
            (restore) => restore.spec.collection === collectionName
        );

        const items = collectionRestores
            .map((restore) => ({
                id: restore.metadata.name,
                collection: restore.spec.collection,
                backupId: restore.spec.backupId,
                mode: restore.spec.mode,
                status: restore.status?.phase || 'Pending',
                message: restore.status?.message || null,
                startedAt: restore.status?.startedAt || null,
                completedAt: restore.status?.completedAt || null,
                error: restore.status?.error || null
            }))
            .sort((a, b) => {
                // Sort by creation time, newest first
                const timeA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
                const timeB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
                return timeB - timeA;
            });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items, count: items.length }));
    } catch (err) {
        log(`❌ Error getting restore status: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to get restore status', message: err.message }));
    }
};

// Router for restore endpoints
export const restoreRouter = async (req, res, pathname, method) => {
    const namespace = getNamespace(new URL(req.url, `http://${req.headers.host}`));
    const pathParts = pathname.split('/').filter(Boolean);

    // /api/v1/restore/collections/{name}
    if (pathParts.length === 4 && pathParts[2] === 'collections' && pathParts[3]) {
        const collectionName = pathParts[3];
        if (method === 'POST') {
            await restoreCollection(req, res, namespace, collectionName);
            return true;
        } else if (method === 'GET') {
            await getRestoreStatus(req, res, namespace, collectionName);
            return true;
        }
    }

    return false;
};

