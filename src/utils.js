// Log format
export const log = (message) => {
  console.log(`${new Date().toLocaleString()}: ${message}`);
};

// Log Kubernetes API errors with full details (statusCode, body, response, etc.)
// This is essential for debugging operator issues, as the k8s client JS hides useful info
export const logK8sError = (err, context = '') => {
  log(`❌ Kubernetes API error ${context}`);

  if (err?.statusCode) {
    log(`   statusCode: ${err.statusCode}`);
  }

  if (err?.message) {
    log(`   message: ${err.message}`);
  }

  if (err?.body) {
    try {
      const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
      log(`   body: ${JSON.stringify(body, null, 2)}`);
    } catch {
      log(`   body (raw): ${err.body}`);
    }
  }

  if (err?.response?.statusCode) {
    log(`   response.statusCode: ${err.response.statusCode}`);
  }

  if (err?.response?.headers) {
    log(`   response.headers: ${JSON.stringify(err.response.headers)}`);
  }
};
