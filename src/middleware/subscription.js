import { getUserSubscription, upsertSubscription } from '../../lib/store.js';

const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';

// Paths that bypass subscription check
const SKIP_PATHS = new Set([
  '/', '/pricing', '/login', '/signup',
  '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout',
  '/healthz', '/metricsz', '/favicon.ico', '/favicon.png',
]);

export async function requiresSubscription(req, res, next) {
  // Billing only enforced in Supabase mode (local dev is always open)
  if (!USE_SUPABASE) return next();

  // Skip public and billing paths
  if (SKIP_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/billing/') || req.path.startsWith('/public/') || req.path.startsWith('/docs/')) return next();

  // requireAuth already blocked unauthenticated users — if we're here, user exists
  const userId = req.auth?.user?.id;
  if (!userId) return next();

  try {
    let sub = await getUserSubscription(userId);

    // Gap 1 fix: create trial row if none exists (e.g. pre-billing signup or DB failure at signup)
    if (!sub) {
      sub = await upsertSubscription(userId, {
        status: 'trialing',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }

    req.subscription = sub;

    const now = new Date();

    if (sub.status === 'trialing') {
      if (new Date(sub.trial_ends_at) > now) return next();
      return res.redirect('/pricing?reason=trial_expired');
    }

    if (sub.status === 'active' || sub.status === 'past_due') return next();

    // canceled or expired
    return res.redirect('/pricing?reason=subscription_ended');
  } catch (err) {
    // Fail-open: DB error → let user through so a Supabase outage doesn't lock out paying users
    console.error('[requiresSubscription] DB error, failing open:', err.message);
    return next();
  }
}
