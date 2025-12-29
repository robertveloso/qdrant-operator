import { k8sCustomApi } from '../../k8s-client.js';
import { log } from '../../utils.js';
import { listTemplates, getTemplate } from '../helpers/templates.js';

// GET /api/v1/templates - List all templates
const listTemplatesRoute = async (req, res) => {
  try {
    const templates = await listTemplates();

    const items = templates.map((template) => ({
      id: template.metadata.name,
      name: template.spec.name,
      shards: template.spec.shards || 1,
      replicationFactor: template.spec.replicationFactor || 1,
      onDisk: template.spec.onDisk !== false,
      vectors: template.spec.vectors || null,
      backup: template.spec.backup || null,
      usageCount: template.status?.usageCount || 0,
      lastUsed: template.status?.lastUsed || null
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, count: items.length }));
  } catch (err) {
    log(`❌ Error listing templates: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to list templates', message: err.message }));
  }
};

// GET /api/v1/templates/{name} - Get template
const getTemplateRoute = async (req, res, templateName) => {
  try {
    const template = await getTemplate(templateName, 'default'); // Templates are cluster-scoped

    if (!template) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Template not found', name: templateName }));
      return;
    }

    const item = {
      id: template.metadata.name,
      name: template.spec.name,
      shards: template.spec.shards || 1,
      replicationFactor: template.spec.replicationFactor || 1,
      onDisk: template.spec.onDisk !== false,
      vectors: template.spec.vectors || null,
      backup: template.spec.backup || null,
      usageCount: template.status?.usageCount || 0,
      lastUsed: template.status?.lastUsed || null
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item));
  } catch (err) {
    if (err.statusCode === 404) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Template not found', name: templateName }));
    } else {
      log(`❌ Error getting template: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to get template', message: err.message }));
    }
  }
};

// POST /api/v1/templates - Create template
const createTemplate = async (req, res) => {
  const body = req.body;

  // Validate
  if (!body.name) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'name is required' }));
    return;
  }

  if (!/^[a-z0-9-]+$/.test(body.name)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'name must contain only lowercase letters, numbers, and hyphens' })
    );
    return;
  }

  // Create QdrantCollectionTemplate CRD
  const templateCR = {
    apiVersion: 'qdrant.operator/v1alpha1',
    kind: 'QdrantCollectionTemplate',
    metadata: {
      name: body.name,
      labels: {
        'app.kubernetes.io/managed-by': 'qdrant-operator-api'
      }
    },
    spec: {
      name: body.name,
      shards: body.shards || 1,
      replicationFactor: body.replicationFactor || 1,
      onDisk: body.onDisk !== false,
      ...(body.vectors && { vectors: body.vectors }),
      ...(body.backup && { backup: body.backup })
    }
  };

  try {
    const created = await k8sCustomApi.createClusterCustomObject(
      'qdrant.operator',
      'v1alpha1',
      'qdrantcollectiontemplates',
      templateCR
    );

    log(`✅ Created QdrantCollectionTemplate CR via API: ${body.name}`);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: created.metadata.name,
        name: created.spec.name,
        message: 'Template created successfully'
      })
    );
  } catch (err) {
    if (err.statusCode === 409) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Template already exists', name: body.name }));
    } else {
      log(`❌ Error creating template: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create template', message: err.message }));
    }
  }
};

// Router for templates endpoints
export const templatesRouter = async (req, res, pathname, method) => {
  const pathParts = pathname.split('/').filter(Boolean);

  // /api/v1/templates
  if (pathParts.length === 3) {
    if (method === 'GET') {
      await listTemplatesRoute(req, res);
      return true;
    } else if (method === 'POST') {
      await createTemplate(req, res);
      return true;
    }
  }

  // /api/v1/templates/{name}
  if (pathParts.length === 4 && pathParts[3]) {
    const templateName = pathParts[3];
    if (method === 'GET') {
      await getTemplateRoute(req, res, templateName);
      return true;
    }
  }

  return false;
};
