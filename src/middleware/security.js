import sanitizeHtml from 'sanitize-html';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { IS_PRODUCTION, APP_API_KEY, USE_SUPABASE, csrfCookieOptions } from '../config.js';

// Función de sanitización para prevenir XSS
export function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return sanitizeHtml(input, {
        allowedTags: [], // No permitir ningún HTML
        allowedAttributes: {},
        disallowedTagsMode: 'escape',
    }).trim();
}

// CSRF Protection manual
export function generateCsrfToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Buffer.from(bytes).toString('hex');
}

export function csrfProtection(req, res, next) {
    // Solo para POST requests
    if (req.method !== 'POST') return next();

    // Verificar token CSRF
    const tokenFromBody = req.body?._csrf;
    const tokenFromHeader = req.get('x-csrf-token');
    const tokenFromRequest = tokenFromBody || tokenFromHeader;
    const tokenFromSession = req.cookies?.csrf_token;

    if (!tokenFromRequest || !tokenFromSession) {
        return res.status(403).send('CSRF token inválido. Recarga la página e intenta de nuevo.');
    }

    // SECURITY: Use timing-safe comparison to prevent timing attacks
    if (!safeCompareStrings(tokenFromRequest, tokenFromSession)) {
        return res.status(403).send('CSRF token inválido. Recarga la página e intenta de nuevo.');
    }

    next();
}

export function attachCsrfToken(req, res, next) {
    // Generar token si no existe
    if (!req.cookies?.csrf_token) {
        const token = generateCsrfToken();
        res.cookie('csrf_token', token, csrfCookieOptions());
        res.locals.csrfToken = token;
    } else {
        res.locals.csrfToken = req.cookies.csrf_token;
    }
    next();
}

// Helper para comparación segura de strings
export function safeCompareStrings(a, b) {
    try {
        const left = Buffer.from(String(a || ''), 'utf8');
        const right = Buffer.from(String(b || ''), 'utf8');
        if (left.length !== right.length) return false;
        return timingSafeEqual(left, right);
    } catch {
        return false;
    }
}

// Helper para extraer API key
export function extractApiKey(req) {
    return req.get('x-api-key') || '';
}

// Middleware para requerir API key
export function requireApiKey(req, res, next) {
    if (!APP_API_KEY) return next();
    if (USE_SUPABASE && req.auth?.user) return next();
    const key = extractApiKey(req);
    if (key && safeCompareStrings(key, APP_API_KEY)) return next();
    return res.status(401).send('Unauthorized');
}

// Rate limiting general
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 1000, // Límite de 1000 requests por ventana
    message: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting estricto para auth
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // Solo 5 intentos de login
    message: 'Demasiados intentos de autenticación, intenta de nuevo en 15 minutos.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting para export (prevenir scraping masivo)
export const exportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10, // 10 exports por ventana
    message: 'Demasiadas exportaciones, intenta de nuevo en 15 minutos.',
    standardHeaders: true,
    legacyHeaders: false,
});
