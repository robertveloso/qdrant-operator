import { log } from '../../utils.js';

// Simple token-based authentication
// Token is read from environment variable or default
const API_TOKEN = process.env.API_TOKEN || process.env.QDRANT_OPERATOR_API_TOKEN;

export const authMiddleware = async (req) => {
    // If no token configured, allow all (development mode)
    if (!API_TOKEN) {
        log('⚠️ WARNING: API_TOKEN not set, allowing all requests (development mode)');
        return { authenticated: true };
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return { authenticated: false, message: 'Missing Authorization header' };
    }

    // Support both "Bearer <token>" and "Token <token>" formats
    const tokenMatch = authHeader.match(/^(Bearer|Token)\s+(.+)$/i);
    if (!tokenMatch) {
        return { authenticated: false, message: 'Invalid Authorization format. Use "Bearer <token>" or "Token <token>"' };
    }

    const token = tokenMatch[2];

    // Compare tokens (constant-time comparison to prevent timing attacks)
    let matches = true;
    if (token.length !== API_TOKEN.length) {
        matches = false;
    } else {
        for (let i = 0; i < token.length; i++) {
            if (token[i] !== API_TOKEN[i]) {
                matches = false;
            }
        }
    }

    if (!matches) {
        return { authenticated: false, message: 'Invalid token' };
    }

    return { authenticated: true };
};

