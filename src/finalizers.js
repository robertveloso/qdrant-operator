import { k8sCustomApi } from './k8s-client.js';
import { errorsTotal } from './metrics.js';
import { log } from './utils.js';

// Finalizer constant
export const FINALIZER = 'qdrant.operator/finalizer';

// Add finalizer to resource (using merge-patch for safety)
export const addFinalizer = async (apiObj, resourceType) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const finalizers = apiObj.metadata.finalizers || [];

  if (finalizers.includes(FINALIZER)) {
    return; // Already has finalizer
  }

  try {
    // Use merge-patch (safer than JSON patch - handles existing fields correctly)
    const updatedFinalizers = [...finalizers, FINALIZER];
    const patch = {
      metadata: {
        finalizers: updatedFinalizers
      }
    };

    await k8sCustomApi.patchNamespacedCustomObject(
      'qdrant.operator',
      'v1alpha1',
      namespace,
      resourceType,
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    log(`Added finalizer to ${resourceType} "${name}"`);
  } catch (err) {
    log(`Error adding finalizer to ${resourceType} "${name}": ${err.message}`);
    errorsTotal.inc({ type: 'finalizer_add' });
  }
};

// Remove finalizer from resource (using merge-patch for safety)
export const removeFinalizer = async (apiObj, resourceType) => {
  const name = apiObj.metadata.name;
  const namespace = apiObj.metadata.namespace;
  const finalizers = apiObj.metadata.finalizers || [];

  if (!finalizers.includes(FINALIZER)) {
    return; // No finalizer to remove
  }

  try {
    // Use merge-patch (safer than JSON patch - handles existing fields correctly)
    const updatedFinalizers = finalizers.filter((f) => f !== FINALIZER);
    const patch = {
      metadata: {
        finalizers: updatedFinalizers
      }
    };

    await k8sCustomApi.patchNamespacedCustomObject(
      'qdrant.operator',
      'v1alpha1',
      namespace,
      resourceType,
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    log(`Removed finalizer from ${resourceType} "${name}"`);
  } catch (err) {
    log(
      `Error removing finalizer from ${resourceType} "${name}": ${err.message}`
    );
    errorsTotal.inc({ type: 'finalizer_remove' });
  }
};
