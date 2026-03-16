import 'dotenv/config';
import express from 'express';
import ejs from 'ejs';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import sanitizeHtml from 'sanitize-html';
import { timingSafeEqual } from 'node:crypto';

import { loadDb, loadItemsForList, loadItemsByStatus, loadItemById, saveDb, saveItem, deleteItemById, isStoreSupabaseMode, newItem, updateItem, findRecentDuplicate, upsertSubscription } from './lib/store.js';
import {
  DESTINATIONS,
  destinationByKey,
  evaluateActionability,
  withHacerMeta,
  randomId,
  withDesglosarMeta,
} from './src/services/gtd-service.js';
import { ImportValidationError, validateAndNormalizeImportPayload } from './src/validators/import-payload.js';
import {
  RequestValidationError,
  sanitizeEnumField,
  sanitizeIdParam,
  sanitizeIntegerField,
  sanitizeTextField,
} from './src/validators/request-validators.js';
import { createObservabilityMiddleware } from './src/middleware/observability.js';
import { createItemRoutes } from './src/routes/items.js';
import { createDestinationRoutes } from './src/routes/destinations.js';
import { createSettingsRoutes } from './src/routes/settings.js';
import { createWeeklyReviewRoutes } from './src/routes/weekly-review.js';
import { createBillingRoutes } from './src/routes/billing.js';
import { loadFlagsMiddleware } from './src/middleware/feature-flags.js';
import { requiresSubscription } from './src/middleware/subscription.js';

const app = express();

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const APP_API_KEY = process.env.APP_API_KEY || '';
const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '64kb';
const IMPORT_JSON_BODY_LIMIT = process.env.IMPORT_JSON_BODY_LIMIT || '10mb';
const AUTH_COOKIE_MAX_AGE_MS = Number(process.env.AUTH_COOKIE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
const CSRF_COOKIE_MAX_AGE_MS = Number(process.env.CSRF_COOKIE_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const APP_URL = process.env.APP_URL || (IS_PRODUCTION ? '' : `http://${HOST}:${PORT}`);

if (IS_PRODUCTION && !USE_SUPABASE && !APP_API_KEY) {
  throw new Error(
    '[gtd_neto] Fatal: insecure production configuration. Set APP_API_KEY or enable USE_SUPABASE=true before startup.'
  );
}

if (!APP_API_KEY) {
  console.warn('[gtd_neto] WARNING: APP_API_KEY is empty. Set it in .env to protect POST endpoints.');
}

if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.warn('[gtd_neto] WARNING: USE_SUPABASE=true but SUPABASE_URL/SUPABASE_ANON_KEY are missing. Login will fail.');
}

// IMPROVED: Enable autoRefreshToken for better session management
const supabaseAuth = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
const {
  cspNonceMiddleware,
  requestIdMiddleware,
  recordOperation,
  metricsHandler,
  notFoundHandler,
  errorHandler,
} = createObservabilityMiddleware({ isProduction: IS_PRODUCTION });

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

function clearAuthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    path: '/',
  };
}

function csrfCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    path: '/',
    maxAge: CSRF_COOKIE_MAX_AGE_MS,
  };
}

function clearCsrfCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    path: '/',
  };
}

// Función de sanitización para prevenir XSS
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return sanitizeHtml(input, {
    allowedTags: [], // No permitir ningún HTML
    allowedAttributes: {},
    disallowedTagsMode: 'escape',
  }).trim();
}

// CSRF Protection manual
function generateCsrfToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('hex');
}

function csrfProtection(req, res, next) {
  // Solo para POST requests
  if (req.method !== 'POST') return next();

  // Stripe webhook has its own signature verification — exempt from CSRF
  if (req.path === '/billing/webhook') return next();

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

function attachCsrfToken(req, res, next) {
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

// Middlewares de seguridad y performance
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');
app.use(compression()); // Comprimir respuestas
app.use(cspNonceMiddleware);
app.use(requestIdMiddleware);

// Helmet para security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting general
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000, // Límite de 1000 requests por ventana
  message: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting estricto para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Solo 5 intentos de login
  message: 'Demasiados intentos de autenticación, intenta de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting para export (prevenir scraping masivo)
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 exports por ventana
  message: 'Demasiadas exportaciones, intenta de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

app.set('view engine', 'ejs');
app.set('views', new URL('./views', import.meta.url).pathname);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
const importJsonParser = express.json({ limit: IMPORT_JSON_BODY_LIMIT });
const rawBodyParser = express.raw({ type: 'application/json' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/import') {
    return importJsonParser(req, res, next);
  }
  // Stripe webhook needs raw body for signature verification
  if (req.method === 'POST' && req.path === '/billing/webhook') {
    return rawBodyParser(req, res, next);
  }
  return jsonParser(req, res, next);
});
app.use(cookieParser());
app.use('/public', express.static(new URL('./public', import.meta.url).pathname));
app.use('/docs', express.static(new URL('./docs', import.meta.url).pathname));

// Evita ruido de 404 en Vercel cuando el navegador pide favicon por defecto
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

// Service Worker (PWA)
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(new URL('./public/sw.js', import.meta.url).pathname);
});

function extractApiKey(req) {
  return req.get('x-api-key') || '';
}

function safeCompareStrings(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function requireApiKey(req, res, next) {
  if (!APP_API_KEY) return next();
  if (USE_SUPABASE && req.auth?.user) return next();
  const key = extractApiKey(req);
  if (key && safeCompareStrings(key, APP_API_KEY)) return next();
  return res.status(401).send('Unauthorized');
}

function ownerForReq(req) {
  return req.auth?.user?.id || process.env.SUPABASE_OWNER || 'default';
}

function userFacingPersistError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();

  if (code === '42P10' || msg.includes('no unique or exclusion constraint')) {
    return 'La base de datos no tiene la configuración esperada para guardar items. Contacta al administrador.';
  }
  if (code === '42501' || msg.includes('permission denied') || msg.includes('row-level security')) {
    return 'No tienes permisos para guardar este item. Vuelve a iniciar sesión.';
  }
  return 'No se pudo guardar el item en este momento. Intenta de nuevo.';
}

async function loadReqDb(req) {
  const startedAt = Date.now();
  try {
    const result = await loadDb({ owner: ownerForReq(req) });
    recordOperation('loadReqDb', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('loadReqDb', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function loadReqItemsByList(req, list, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await loadItemsForList(list, { ...options, owner: ownerForReq(req) });
    recordOperation('loadReqItemsByList', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('loadReqItemsByList', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function loadReqItemsByStatus(req, status, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await loadItemsByStatus(status, { ...options, owner: ownerForReq(req) });
    recordOperation('loadReqItemsByStatus', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('loadReqItemsByStatus', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function loadReqItemById(req, id) {
  const startedAt = Date.now();
  try {
    const result = await loadItemById(id, { owner: ownerForReq(req) });
    recordOperation('loadReqItemById', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('loadReqItemById', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function saveReqDb(req, db) {
  const startedAt = Date.now();
  try {
    const result = await saveDb(db, { owner: ownerForReq(req) });
    recordOperation('saveReqDb', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('saveReqDb', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function saveReqItem(req, item, dbWhenLocal = null) {
  const startedAt = Date.now();
  try {
    if (isStoreSupabaseMode()) {
      const result = await saveItem(item, { owner: ownerForReq(req) });
      recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
      return result;
    }
    if (dbWhenLocal) {
      const result = await saveReqDb(req, dbWhenLocal);
      recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
      return result;
    }
    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === item.id);
    if (idx === -1) db.items = [item, ...(db.items || [])];
    else db.items[idx] = item;
    const result = await saveReqDb(req, db);
    recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('saveReqItem', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function deleteReqItem(req, id, dbWhenLocal = null) {
  const startedAt = Date.now();
  try {
    if (isStoreSupabaseMode()) {
      const result = await deleteItemById(id, { owner: ownerForReq(req) });
      recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
      return result;
    }
    if (dbWhenLocal) {
      const result = await saveReqDb(req, dbWhenLocal);
      recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
      return result;
    }
    const db = await loadReqDb(req);
    db.items = (db.items || []).filter(i => i.id !== id);
    const result = await saveReqDb(req, db);
    recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    recordOperation('deleteReqItem', { ok: false, durationMs: Date.now() - startedAt });
    throw err;
  }
}

// IMPROVED: Token refresh middleware - automatically refreshes expired tokens
async function refreshTokenIfNeeded(req, res, next) {
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

async function attachAuth(req, res, next) {
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

function requireAuth(req, res, next) {
  if (!USE_SUPABASE) return next();
  if (req.auth?.user) return next();
  return res.redirect('/login');
}

function renderPage(res, view, data) {
  const viewsPath = app.get('views');
  const title = data?.title || 'GTD_Neto';
  const flash = data?.flash || null;
  const csrfToken = res.locals?.csrfToken || '';
  const cspNonce = res.locals?.cspNonce || '';
  const body = ejs.renderFile(`${viewsPath}/${view}.ejs`, { ...data, csrfToken, cspNonce });
  return Promise.resolve(body)
    .then(html =>
      res.render('layout', {
        title,
        flash,
        body: html,
        useSupabase: USE_SUPABASE,
        authUser: data?.authUser || res.locals?.authUser || null,
        csrfToken,
        cspNonce,
        hideAppNav: Boolean(data?.hideAppNav),
      })
    )
    .catch(err => {
      console.error(`[renderPage] Error rendering view "${view}":`, err);
      if (!res.headersSent) {
        res.status(500).send('Error rendering page');
      }
    });
}

// IMPROVED: Refresh token before attaching auth
app.use(refreshTokenIfNeeded);
app.use(attachAuth);
app.use(attachCsrfToken); // Agregar CSRF token a todas las respuestas
app.use((req, res, next) => {
  res.locals.authUser = req.auth?.user || null;
  next();
});
app.use(csrfProtection); // Validar CSRF en POST requests

app.get('/login', async (req, res) => {
  if (!USE_SUPABASE) return res.redirect('/');
  if (req.auth?.user) return res.redirect('/');
  return renderPage(res, 'login', {
    title: 'Login',
    needApiKey: false,
    message: String(req.query?.message || ''),
    hideAppNav: true,
  });
});

app.get('/signup', async (req, res) => {
  if (!USE_SUPABASE) return res.redirect('/');
  if (req.auth?.user) return res.redirect('/');
  return renderPage(res, 'signup', { title: 'Registro', needApiKey: false });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());

  // SECURITY: Validate email format before sending to Supabase
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return renderPage(res, 'login', {
      title: 'Login',
      flash: { error: 'Formato de email inválido.' },
      needApiKey: false,
    });
  }

  const password = String(req.body?.password || ''); // No sanitizar password

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    return renderPage(res, 'login', {
      title: 'Login',
      flash: { error: 'Credenciales inválidas.' },
      needApiKey: false,
    });
  }

  res.cookie('sb_access_token', data.session.access_token, authCookieOptions());
  res.cookie('sb_refresh_token', data.session.refresh_token, authCookieOptions());
  return res.redirect('/');
});

app.post('/auth/signup', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());

  // SECURITY: Validate email format before sending to Supabase
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return renderPage(res, 'signup', {
      title: 'Registro',
      flash: { error: 'Formato de email inválido.' },
      needApiKey: false,
    });
  }

  const password = String(req.body?.password || ''); // No sanitizar password

  const { data: signupData, error } = await supabaseAuth.auth.signUp({ email, password });
  if (error) {
    return renderPage(res, 'signup', {
      title: 'Registro',
      flash: { error: error.message || 'No se pudo crear la cuenta.' },
      needApiKey: false,
    });
  }

  // Create 14-day trial subscription row for the new user
  // Non-fatal: if this fails, requiresSubscription middleware will create it on first access
  if (signupData?.user?.id) {
    try {
      await upsertSubscription(signupData.user.id, {
        status: 'trialing',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch (subErr) {
      console.warn('[auth/signup] Could not create trial subscription:', subErr.message);
    }
  }

  return res.redirect('/login?message=Cuenta creada. Revisa tu correo para confirmación si aplica.');
});

app.post('/auth/forgot', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());
  if (!email) return res.redirect('/login?message=Ingresa tu correo para recuperar contraseña.');

  // SECURITY: Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.redirect('/login?message=Formato de email inválido.');
  }

  // SECURITY: Use APP_URL instead of req.get('host') to prevent SSRF attacks
  if (!APP_URL) {
    console.error('[auth/forgot] APP_URL not configured - cannot send password reset');
    return res.redirect('/login?message=Error de configuración. Contacta al administrador.');
  }

  const redirectTo = `${APP_URL}/login?message=Contraseña actualizada. Ya puedes iniciar sesión.`;
  await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
  return res.redirect('/login?message=Si el correo existe, enviamos enlace de recuperación.');
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('sb_access_token', clearAuthCookieOptions());
  res.clearCookie('sb_refresh_token', clearAuthCookieOptions());
  res.clearCookie('csrf_token', clearCsrfCookieOptions());
  return res.redirect('/login');
});

app.use((req, res, next) => {
  const publicPaths = [
    '/', '/login', '/signup',
    '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout',
    '/pricing', '/billing/webhook', '/billing/success', '/billing/cancel',
    '/healthz', '/favicon.ico', '/favicon.png',
  ];
  if (publicPaths.includes(req.path) || req.path.startsWith('/docs/')) return next();
  return requireAuth(req, res, next);
});

// Feature flags for authenticated routes (falls back to defaults on error)
app.use(loadFlagsMiddleware);

// Billing routes (pricing is public; checkout/portal require auth via requireAuth above)
app.use(createBillingRoutes({ renderPage, APP_URL }));

// Subscription gate — redirects expired/canceled users to /pricing
app.use(requiresSubscription);

// Landing page for unauthenticated visitors at /
app.get('/', (req, res, next) => {
  if (USE_SUPABASE && !req.auth?.user) {
    return renderPage(res, 'landing', { title: 'GTD_Neto — Organiza tu vida con GTD', hideAppNav: true });
  }
  return next();
});

// Route factories (dependency injection pattern)
const sharedDeps = {
  loadReqDb, loadReqItemsByList, loadReqItemsByStatus, loadReqItemById,
  saveReqDb, saveReqItem, deleteReqItem, requireApiKey, sanitizeInput,
  renderPage, APP_API_KEY, ownerForReq, userFacingPersistError,
  exportLimiter, validateAndNormalizeImportPayload, ImportValidationError,
};
app.use(createItemRoutes(sharedDeps));
app.use(createDestinationRoutes(sharedDeps));
app.use(createSettingsRoutes({ renderPage, requireApiKey, sanitizeInput, ownerForReq }));
app.use(createWeeklyReviewRoutes({ renderPage, requireApiKey, sanitizeInput, ownerForReq, saveReqItem, loadReqItemsByList, loadReqDb }));

// Vista "Hoy" - Next Actions consolidadas
app.get('/hoy', async (req, res) => {
  const db = await loadReqDb(req);
  const items = db.items || [];

  // Tareas urgentes e importantes de "Hacer" (score >= 12)
  const hacerItems = items
    .filter(i => i.list === 'hacer' && i.status !== 'done')
    .map(i => ({ ...i, ...withHacerMeta(i) }))
    .map(i => {
      const urgency = Number(i.urgency || 3);
      const importance = Number(i.importance || 3);
      const priorityScore = urgency * importance;
      return { ...i, priorityScore };
    })
    .filter(i => i.priorityScore >= 12)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 10);

  // Tareas agendadas (próximos 3 días)
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const threeDaysLater = new Date(todayStart);
  threeDaysLater.setDate(threeDaysLater.getDate() + 3);

  const agendarItems = items
    .filter(i => i.list === 'agendar' && i.status !== 'done' && i.dueDate)
    .map(i => {
      const dueDate = new Date(i.dueDate);
      return { ...i, dueDate, dueDateObj: dueDate };
    })
    .filter(i => !Number.isNaN(i.dueDateObj.getTime()) && i.dueDateObj <= threeDaysLater)
    .sort((a, b) => a.dueDateObj - b.dueDateObj)
    .map(i => ({
      ...i,
      dueDateFormatted: i.dueDateObj.toLocaleDateString('es', {
        weekday: 'short',
        day: 'numeric',
        month: 'short'
      }),
      isToday: i.dueDateObj.toDateString() === todayStart.toDateString(),
      isTomorrow: i.dueDateObj.toDateString() === new Date(todayStart.getTime() + 86400000).toDateString(),
    }));

  // Delegaciones pendientes de seguimiento (más de 2 días)
  const twoDaysAgo = new Date(now.getTime() - (2 * 24 * 60 * 60 * 1000));
  const delegarItems = items
    .filter(i => i.list === 'delegar' && i.status !== 'done')
    .map(i => {
      const movedAt = i.movedToListAt ? new Date(i.movedToListAt) : null;
      return { ...i, movedAt };
    })
    .filter(i => i.movedAt && i.movedAt < twoDaysAgo)
    .sort((a, b) => a.movedAt - b.movedAt)
    .map(i => ({
      ...i,
      daysWaiting: Math.floor((now - i.movedAt) / (24 * 60 * 60 * 1000)),
    }));

  // Calcular tiempo total estimado
  const totalEstimateMin = hacerItems.reduce((sum, i) => sum + (Number(i.estimateMin) || 0), 0);

  return renderPage(res, 'hoy', {
    title: 'Hoy',
    hacerItems,
    agendarItems,
    delegarItems,
    totalEstimateMin,
    todayFormatted: todayStart.toLocaleDateString('es', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    }),
  });
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
// SECURITY: /metricsz requires authentication or API key
app.get('/metricsz', requireApiKey, metricsHandler);

app.use(notFoundHandler);
app.use(errorHandler);

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
  });
}

export default app;
