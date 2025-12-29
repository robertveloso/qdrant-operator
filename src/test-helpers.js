import test from 'ava';
import { calculateSpecHash } from './spec-hash.js';
import { FINALIZER } from './finalizers.js';

/**
 * Unit Tests for Helper Functions
 *
 * Testing Strategy:
 * =================
 * These tests focus on pure functions and small helpers that have
 * deterministic behavior and don't require Kubernetes API mocking.
 *
 * What these tests cover:
 * - Spec normalization and hashing (drift detection)
 * - Finalizer logic (pure checks)
 * - Small utility functions with clear inputs/outputs
 *
 * What these tests DON'T cover:
 * - Kubernetes API calls (covered by E2E)
 * - Watch, leader election, retry logic (covered by E2E)
 * - Complex async flows (covered by E2E)
 */

// Helper: Check if resource has finalizer (extracted from finalizers.js logic)
function hasFinalizer(apiObj) {
  const finalizers = apiObj.metadata?.finalizers || [];
  return finalizers.includes(FINALIZER);
}

// Helper: Check if resource needs cleanup (has deletionTimestamp)
function needsCleanup(apiObj) {
  return !!apiObj.metadata?.deletionTimestamp;
}

// Helper: Extract drift detection logic (pure function from reconciliation.js)
function shouldReconcileStatefulSet(desired, observed) {
  if (!observed) {
    return true; // Needs creation
  }

  const observedReplicas = observed.spec?.replicas || 0;
  const observedImage = observed.spec?.template?.spec?.containers?.[0]?.image || '';
  const desiredImage = desired.image || 'qdrant/qdrant:latest';

  return observedReplicas !== desired.replicas || observedImage !== desiredImage;
}

// ============================================================================
// Tests for calculateSpecHash
// ============================================================================

test('calculateSpecHash: same spec produces same hash', (t) => {
  const spec1 = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3',
    apikey: 'testkey',
    readApikey: 'false',
    tls: { enabled: false },
    resources: { limits: { cpu: '1000m' } },
    persistence: { size: '1Gi' },
    service: 'ClusterIP'
  };

  const spec2 = { ...spec1 };

  const hash1 = calculateSpecHash(spec1);
  const hash2 = calculateSpecHash(spec2);

  t.is(hash1, hash2, 'Same spec should produce same hash');
  t.is(hash1.length, 16, 'Hash should be 16 characters');
});

test('calculateSpecHash: different specs produce different hashes', (t) => {
  const spec1 = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3',
    apikey: 'testkey',
    readApikey: 'false',
    tls: { enabled: false },
    resources: {},
    persistence: {},
    service: 'ClusterIP'
  };

  const spec2 = {
    ...spec1,
    replicas: 5 // Different replicas
  };

  const hash1 = calculateSpecHash(spec1);
  const hash2 = calculateSpecHash(spec2);

  t.not(hash1, hash2, 'Different specs should produce different hashes');
});

test('calculateSpecHash: ignores non-relevant fields', (t) => {
  const spec1 = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3',
    apikey: 'testkey',
    readApikey: 'false',
    tls: { enabled: false },
    resources: {},
    persistence: {},
    service: 'ClusterIP',
    // These should be ignored
    nodeAffinity: { some: 'value' },
    tolerations: []
  };

  const spec2 = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3',
    apikey: 'testkey',
    readApikey: 'false',
    tls: { enabled: false },
    resources: {},
    persistence: {},
    service: 'ClusterIP'
    // Missing nodeAffinity and tolerations
  };

  const hash1 = calculateSpecHash(spec1);
  const hash2 = calculateSpecHash(spec2);

  t.is(hash1, hash2, 'Hash should ignore fields not in normalization');
});

// ============================================================================
// Tests for hasFinalizer
// ============================================================================

test('hasFinalizer: returns true when finalizer exists', (t) => {
  const apiObj = {
    metadata: {
      finalizers: [FINALIZER, 'other-finalizer']
    }
  };

  t.true(hasFinalizer(apiObj), 'Should detect existing finalizer');
});

test('hasFinalizer: returns false when finalizer missing', (t) => {
  const apiObj = {
    metadata: {
      finalizers: ['other-finalizer']
    }
  };

  t.false(hasFinalizer(apiObj), 'Should return false when finalizer missing');
});

test('hasFinalizer: handles missing finalizers array', (t) => {
  const apiObj = {
    metadata: {}
  };

  t.false(hasFinalizer(apiObj), 'Should handle missing finalizers array');
});

test('hasFinalizer: handles missing metadata', (t) => {
  const apiObj = {};

  t.false(hasFinalizer(apiObj), 'Should handle missing metadata');
});

// ============================================================================
// Tests for needsCleanup
// ============================================================================

test('needsCleanup: returns true when deletionTimestamp exists', (t) => {
  const apiObj = {
    metadata: {
      deletionTimestamp: '2024-01-01T00:00:00Z'
    }
  };

  t.true(needsCleanup(apiObj), 'Should detect deletion in progress');
});

test('needsCleanup: returns false when deletionTimestamp missing', (t) => {
  const apiObj = {
    metadata: {}
  };

  t.false(needsCleanup(apiObj), 'Should return false when not deleting');
});

test('needsCleanup: handles missing metadata', (t) => {
  const apiObj = {};

  t.false(needsCleanup(apiObj), 'Should handle missing metadata');
});

// ============================================================================
// Tests for shouldReconcileStatefulSet
// ============================================================================

test('shouldReconcileStatefulSet: returns true when StatefulSet missing', (t) => {
  const desired = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3'
  };

  t.true(
    shouldReconcileStatefulSet(desired, null),
    'Should reconcile when StatefulSet does not exist'
  );
});

test('shouldReconcileStatefulSet: detects replica drift', (t) => {
  const desired = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3'
  };

  const observed = {
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [{ image: 'qdrant/qdrant:v1.16.3' }]
        }
      }
    }
  };

  t.true(shouldReconcileStatefulSet(desired, observed), 'Should detect replica drift');
});

test('shouldReconcileStatefulSet: detects image drift', (t) => {
  const desired = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.17.0'
  };

  const observed = {
    spec: {
      replicas: 3,
      template: {
        spec: {
          containers: [{ image: 'qdrant/qdrant:v1.16.3' }]
        }
      }
    }
  };

  t.true(shouldReconcileStatefulSet(desired, observed), 'Should detect image drift');
});

test('shouldReconcileStatefulSet: returns false when no drift', (t) => {
  const desired = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3'
  };

  const observed = {
    spec: {
      replicas: 3,
      template: {
        spec: {
          containers: [{ image: 'qdrant/qdrant:v1.16.3' }]
        }
      }
    }
  };

  t.false(
    shouldReconcileStatefulSet(desired, observed),
    'Should return false when no drift detected'
  );
});

test('shouldReconcileStatefulSet: uses default image when missing', (t) => {
  const desired = {
    replicas: 3
    // image missing
  };

  const observed = {
    spec: {
      replicas: 3,
      template: {
        spec: {
          containers: [{ image: 'qdrant/qdrant:latest' }]
        }
      }
    }
  };

  t.false(
    shouldReconcileStatefulSet(desired, observed),
    'Should use default image when desired image is missing'
  );
});

test('shouldReconcileStatefulSet: handles missing observed fields', (t) => {
  const desired = {
    replicas: 3,
    image: 'qdrant/qdrant:v1.16.3'
  };

  const observed = {
    spec: {
      // Missing replicas and containers
    }
  };

  t.true(
    shouldReconcileStatefulSet(desired, observed),
    'Should reconcile when observed state is incomplete'
  );
});
