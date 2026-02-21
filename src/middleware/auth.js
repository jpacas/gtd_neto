import { USE_SUPABASE, supabaseAuth, authCookieOptions, clearAuthCookieOptions } from '../config.js';

// IMPROVED: Token refresh middleware - automatically refreshes expired tokens
export async function refreshTokenIfNeeded(req, res, next) {
    if (!USE_SUPABASE || !supabaseAuth) return next();

    // If another middleware already attached auth, skip remote calls.
    if (req.auth?.user) return next();

    const accessToken = req.cookies?.sb_access_token;
    const refreshToken = req.cookies?.sb_refresh_token;

    // No tokens, nothing to refresh
    if (!accessToken || !refreshToken) {
        req.auth = { user: null };
        return next();
    }

    // Try to validate current access token
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(accessToken);

    // Token is valid, no refresh needed
    if (userData?.user && !userError) {
        req.auth = { user: userData.user };
        return next();
    }

    // Token is invalid/expired, try to refresh
    try {
        const { data: refreshData, error: refreshError } = await supabaseAuth.auth.refreshSession({
            refresh_token: refreshToken,
        });

        if (refreshError || !refreshData?.session) {
            // Refresh failed, clear cookies and continue
            res.clearCookie('sb_access_token', clearAuthCookieOptions());
            res.clearCookie('sb_refresh_token', clearAuthCookieOptions());
            req.auth = { user: null };
            return next();
        }

        // Refresh succeeded, update cookies
        res.cookie('sb_access_token', refreshData.session.access_token, authCookieOptions());
        res.cookie('sb_refresh_token', refreshData.session.refresh_token, authCookieOptions());
        req.auth = { user: refreshData.user || null };

        return next();
    } catch (err) {
        console.error('[refreshTokenIfNeeded] Error refreshing token:', err);
        req.auth = { user: null };
        return next();
    }
}

export async function attachAuth(req, res, next) {
    if (req.auth) return next();

    if (!USE_SUPABASE || !supabaseAuth) {
        req.auth = { user: { id: process.env.SUPABASE_OWNER || 'default', email: 'local@offline' } };
        return next();
    }

    const accessToken = req.cookies?.sb_access_token;
    if (!accessToken) {
        req.auth = { user: null };
        return next();
    }

    const { data } = await supabaseAuth.auth.getUser(accessToken);
    req.auth = { user: data?.user || null };
    return next();
}

export function requireAuth(req, res, next) {
    if (!USE_SUPABASE) return next();
    if (req.auth?.user) return next();
    return res.redirect('/login');
}
