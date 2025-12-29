// Validate collection creation request
export const validateCollectionRequest = (body) => {
    const errors = [];

    if (!body.name) {
        errors.push('name is required');
    } else if (!/^[a-z0-9-]+$/.test(body.name)) {
        errors.push('name must contain only lowercase letters, numbers, and hyphens');
    }

    if (!body.cluster) {
        errors.push('cluster is required');
    }

    // If template is provided, vectors are optional (will come from template)
    // If no template, vectors are required
    if (!body.template) {
        if (!body.vectors || !body.vectors.size) {
            errors.push('vectors.size is required when template is not provided');
        }
        if (body.vectors && body.vectors.size < 1) {
            errors.push('vectors.size must be at least 1');
        }
        if (body.vectors && body.vectors.distance && !['Cosine', 'Euclid', 'Dot'].includes(body.vectors.distance)) {
            errors.push('vectors.distance must be one of: Cosine, Euclid, Dot');
        }
    }

    // Validate replication if provided
    if (body.replication && (body.replication < 1 || !Number.isInteger(body.replication))) {
        errors.push('replication must be a positive integer');
    }

    // Validate backup config if provided
    if (body.backup) {
        if (body.backup.schedule && !isValidCron(body.backup.schedule)) {
            errors.push('backup.schedule must be a valid cron expression');
        }
        if (body.backup.retentionCount && (body.backup.retentionCount < 1 || !Number.isInteger(body.backup.retentionCount))) {
            errors.push('backup.retentionCount must be a positive integer');
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
};

// Simple cron validation (basic check)
const isValidCron = (cron) => {
    const parts = cron.trim().split(/\s+/);
    return parts.length >= 5 && parts.length <= 6;
};

