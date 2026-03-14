import { loadFeatureFlags } from '../../lib/meta-store.js';

const ENFORCE = String(process.env.ENFORCE_FEATURE_FLAGS || '').toLowerCase() === 'true';

const DEFAULT_FLAGS = {
  weekly_review: true,
  custom_contexts: true,
  custom_areas: true,
  command_palette: true,
};

// Middleware: loads feature flags into res.locals.featureFlags for authenticated routes
// CRITICAL: falls back to defaults if DB fails — never throws
export async function loadFlagsMiddleware(req, res, next) {
  // Only run for authenticated routes
  if (!req.auth?.user) {
    res.locals.featureFlags = { ...DEFAULT_FLAGS };
    return next();
  }

  if (!ENFORCE) {
    // When enforcement is off, all flags are enabled
    res.locals.featureFlags = { ...DEFAULT_FLAGS };
    return next();
  }

  try {
    const owner = req.auth.user.id || process.env.SUPABASE_OWNER || 'default';
    const flags = await loadFeatureFlags({ owner });
    res.locals.featureFlags = { ...DEFAULT_FLAGS, ...flags };
  } catch {
    // CRITICAL: always fall back to defaults — never block the user
    res.locals.featureFlags = { ...DEFAULT_FLAGS };
  }

  next();
}

// Guard middleware: requires a specific feature flag to be enabled
// If the flag is false and ENFORCE_FEATURE_FLAGS=true, renders the upgrade page
export function requireFlag(flagName) {
  return (req, res, next) => {
    if (!ENFORCE) return next();

    const flags = res.locals.featureFlags || DEFAULT_FLAGS;
    if (flags[flagName] === true) return next();

    // Render upgrade prompt
    const viewsPath = res.app?.get('views') || '';
    res.status(403);

    // Try to render upgrade view; fall back to simple message
    try {
      res.render('upgrade', {
        title: 'Función Premium',
        flagName,
        csrfToken: res.locals?.csrfToken || '',
        cspNonce: res.locals?.cspNonce || '',
        useSupabase: Boolean(process.env.USE_SUPABASE === 'true'),
        authUser: res.locals?.authUser || null,
        hideAppNav: false,
        navCounts: res.locals?.navCounts || {},
        featureFlags: flags,
        flash: null,
        body: '',
      });
    } catch {
      res.send('Esta función requiere una cuenta Premium.');
    }
  };
}
