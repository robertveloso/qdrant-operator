import { k8sCustomApi } from '../../k8s-client.js';
import { log } from '../../utils.js';

// Get template by name (cluster-scoped)
export const getTemplate = async (templateName, namespace) => {
    try {
        const template = await k8sCustomApi.getClusterCustomObject(
            'qdrant.operator',
            'v1alpha1',
            'qdrantcollectiontemplates',
            templateName
        );
        return template.body || template;
    } catch (err) {
        if (err.statusCode === 404) {
            return null;
        }
        log(`Error fetching template "${templateName}": ${err.message}`);
        throw err;
    }
};

// List all templates
export const listTemplates = async () => {
    try {
        const templates = await k8sCustomApi.listClusterCustomObject(
            'qdrant.operator',
            'v1alpha1',
            'qdrantcollectiontemplates'
        );
        return templates.body?.items || [];
    } catch (err) {
        log(`Error listing templates: ${err.message}`);
        throw err;
    }
};

