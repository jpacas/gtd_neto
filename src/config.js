import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const PORT = Number(process.env.PORT || 3001);
export const HOST = process.env.HOST || '127.0.0.1';
export const APP_API_KEY = process.env.APP_API_KEY || '';
export const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
export const SUPABASE_URL = process.env.SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '64kb';
export const IMPORT_JSON_BODY_LIMIT = process.env.IMPORT_JSON_BODY_LIMIT || '10mb';
export const AUTH_COOKIE_MAX_AGE_MS = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
export const CSRF_COOKIE_MAX_AGE_MS = Number(process.env.CSRF_COOKIE_MAX_AGE_MS || 24 * 60 * 60 * 1000);
export const APP_URL = process.env.APP_URL || (IS_PRODUCTION ? '' : `http://${HOST}:${PORT}`);

// Security check for production
if (IS_PRODUCTION && !USE_SUPABASE && !APP_API_KEY) {
    throw new Error(
        '[gtd_neto] Fatal: insecure production configuration. Set APP_API_KEY or enable USE_SUPABASE=true before startup.'
    );
}

// Supabase auth client (for client-side operations respecting RLS)
export const supabaseAuth = (SUPABASE_URL && SUPABASE_ANON_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: true, // ✅ ENABLED
            detectSessionInUrl: false,
        },
    })
    : null;

// Cookie options helpers
export function authCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        path: '/',
        maxAge: AUTH_COOKIE_MAX_AGE_MS,
    };
}

export function clearAuthCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION,
        path: '/',
    };
}

export function csrfCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: IS_PRODUCTION,
        path: '/',
        maxAge: CSRF_COOKIE_MAX_AGE_MS,
    };
}

export function clearCsrfCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: IS_PRODUCTION,
        path: '/',
    };
}
