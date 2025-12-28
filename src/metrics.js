import client from 'prom-client';
import { createServer } from 'http';

// Create a Registry to register the metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Reconciliation metrics
export const reconcileTotal = new client.Counter({
  name: 'qdrant_operator_reconcile_total',
  help: 'Total number of reconciliations',
  labelNames: ['resource_type', 'result'],
  registers: [register]
});

export const reconcileDuration = new client.Histogram({
  name: 'qdrant_operator_reconcile_duration_seconds',
  help: 'Duration of reconciliation in seconds',
  labelNames: ['resource_type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

// Watch metrics
export const watchRestarts = new client.Counter({
  name: 'qdrant_operator_watch_restarts_total',
  help: 'Total number of watch restarts',
  labelNames: ['resource_type', 'reason'],
  registers: [register]
});

export const watchActive = new client.Gauge({
  name: 'qdrant_operator_watch_active',
  help: 'Number of active watches',
  labelNames: ['resource_type'],
  registers: [register]
});

// State metrics
export const clustersManaged = new client.Gauge({
  name: 'qdrant_operator_clusters_managed',
  help: 'Number of Qdrant clusters being managed',
  registers: [register]
});

export const collectionsManaged = new client.Gauge({
  name: 'qdrant_operator_collections_managed',
  help: 'Number of Qdrant collections being managed',
  registers: [register]
});

// Error metrics
export const errorsTotal = new client.Counter({
  name: 'qdrant_operator_errors_total',
  help: 'Total number of errors',
  labelNames: ['type'],
  registers: [register]
});

// Leader election metrics
export const leaderElection = new client.Gauge({
  name: 'qdrant_operator_leader',
  help: 'Whether this pod is the leader (1) or not (0)',
  registers: [register]
});

// Queue depth metrics
export const reconcileQueueDepth = new client.Gauge({
  name: 'qdrant_operator_reconcile_queue_depth',
  help: 'Number of resources waiting for reconciliation',
  registers: [register]
});

// Drift detection metrics
export const driftDetectedTotal = new client.Counter({
  name: 'qdrant_operator_drift_detected_total',
  help: 'Total number of drift detections (when spec hash differs from last applied)',
  labelNames: ['resource_type'],
  registers: [register]
});

// Start metrics server
let metricsServer = null;

export const startMetricsServer = (port = 8080) => {
  if (metricsServer) {
    return; // Already started
  }

  metricsServer = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(`Error generating metrics: ${err.message}`);
      }
    } else if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  metricsServer.listen(port, () => {
    console.log(`Metrics server started on port ${port}`);
    console.log(`Metrics available at http://localhost:${port}/metrics`);
  });

  return metricsServer;
};

export const stopMetricsServer = () => {
  if (metricsServer) {
    metricsServer.close();
    metricsServer = null;
  }
};
