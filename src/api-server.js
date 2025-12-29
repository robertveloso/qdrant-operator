import { createServer } from 'http';
import { k8sCustomApi } from './k8s-client.js';
import { log } from './utils.js';
import { collectionsRouter } from './api/routes/collections.js';
import { backupsRouter } from './api/routes/backups.js';
import { restoreRouter } from './api/routes/restore.js';
import { templatesRouter } from './api/routes/templates.js';
import { authMiddleware } from './api/middleware/auth.js';

let apiServer = null;

// Parse request body
const parseBody = (req) => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
};

// Route handler
const handleRequest = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Parse URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // Health check
  if (pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'api' }));
    return;
  }

  // API routes
  if (pathname.startsWith('/api/v1/')) {
    try {
      // Authentication
      const authResult = await authMiddleware(req);
      if (!authResult.authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: authResult.message }));
        return;
      }

      // Parse body for POST/PUT
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        req.body = await parseBody(req);
      }

      // Route to appropriate handler
      let handled = false;

      if (pathname.startsWith('/api/v1/collections')) {
        handled = await collectionsRouter(req, res, pathname, method);
      } else if (pathname.startsWith('/api/v1/backups')) {
        handled = await backupsRouter(req, res, pathname, method);
      } else if (pathname.startsWith('/api/v1/restore')) {
        handled = await restoreRouter(req, res, pathname, method);
      } else if (pathname.startsWith('/api/v1/templates')) {
        handled = await templatesRouter(req, res, pathname, method);
      }

      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: pathname }));
      }
    } catch (err) {
      log(`API error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
    }
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
};

export const startApiServer = (port = 8081) => {
  if (apiServer) {
    return; // Already started
  }

  apiServer = createServer(handleRequest);

  apiServer.listen(port, () => {
    log(`API server started on port ${port}`);
    log(`API available at http://localhost:${port}/api/v1/`);
  });

  return apiServer;
};

export const stopApiServer = () => {
  if (apiServer) {
    apiServer.close();
    apiServer = null;
    log('API server stopped');
  }
};

