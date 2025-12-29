import { k8sCustomApi, k8sBatchApi } from '../../k8s-client.js';
import { log } from '../../utils.js';

// Extract namespace from query params or default
const getNamespace = (url) => {
    const namespace = url.searchParams.get('namespace') || 'default';
    return namespace;
};

// GET /api/v1/backups/collections/{name} - List backups for a collection
const listCollectionBackups = async (req, res, namespace, collectionName) => {
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

        // List backup jobs for this collection
        const jobs = await k8sBatchApi.listNamespacedJob(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `app.kubernetes.io/managed-by=qdrant-operator`
        );

        // Filter jobs related to this collection
        const backupJobs = jobs.body.items.filter((job) => {
            const jobName = job.metadata.name;
            return jobName.includes(collectionName) && jobName.includes('backup');
        });

        // Extract backup information from jobs
        const backups = backupJobs
            .map((job) => {
                const jobName = job.metadata.name;
                // Extract timestamp from job name (format: collection-backup-{timestamp})
                const timestampMatch = jobName.match(/backup-(\d+)/);
                const timestamp = timestampMatch ? parseInt(timestampMatch[1]) : null;

                return {
                    id: jobName,
                    type: 'scheduled',
                    status: job.status.succeeded ? 'completed' : job.status.failed ? 'failed' : 'in-progress',
                    createdAt: job.metadata.creationTimestamp,
                    completedAt: job.status.completionTime || null,
                    ...(timestamp && { backupId: new Date(timestamp).toISOString() })
                };
            })
            .sort((a, b) => {
                // Sort by creation time, newest first
                return new Date(b.createdAt) - new Date(a.createdAt);
            });

        // Also check QdrantCollectionBackup CRDs
        try {
            const backupCRs = await k8sCustomApi.listNamespacedCustomObject(
                'qdrant.operator',
                'v1alpha1',
                namespace,
                'qdrantcollectionbackups'
            );

            const collectionBackups = (backupCRs.body?.items || []).filter(
                (backup) => backup.spec.collectionName === collectionName
            );

            // Merge backup CRs with job-based backups
            collectionBackups.forEach((backupCR) => {
                backups.push({
                    id: backupCR.metadata.name,
                    type: 'manual',
                    status: 'configured',
                    createdAt: backupCR.metadata.creationTimestamp,
                    schedule: backupCR.spec.snapshots.backupSchedule || null
                });
            });
        } catch (err) {
            // QdrantCollectionBackup CRDs might not exist, ignore
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: backups, count: backups.length }));
    } catch (err) {
        if (err.statusCode === 404) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Collection not found', name: collectionName }));
        } else {
            log(`❌ Error listing backups: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to list backups', message: err.message }));
        }
    }
};

// Router for backups endpoints
export const backupsRouter = async (req, res, pathname, method) => {
    const namespace = getNamespace(new URL(req.url, `http://${req.headers.host}`));
    const pathParts = pathname.split('/').filter(Boolean);

    // /api/v1/backups/collections/{name}
    if (pathParts.length === 4 && pathParts[2] === 'collections' && pathParts[3]) {
        const collectionName = pathParts[3];
        if (method === 'GET') {
            await listCollectionBackups(req, res, namespace, collectionName);
            return true;
        }
    }

    return false;
};

