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

import { loadDb, loadItemsForList, loadItemsByStatus, loadItemById, saveDb, saveItem, deleteItemById, isStoreSupabaseMode, newItem, updateItem, findRecentDuplicate } from './lib/store.js';
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
import { createAuthRoutes } from './src/routes/auth.js';
import { createItemRoutes } from './src/routes/items.js';
import { createDestinationRoutes } from './src/routes/destinations.js';
import { createSettingsRoutes } from './src/routes/settings.js';
import { createWeeklyReviewRoutes } from './src/routes/weekly-review.js';
import { loadMetaByKind } from './lib/meta-store.js';
import { SYSTEM_CONTEXTS, SYSTEM_AREAS } from './src/services/gtd-service.js';

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
const ENFORCE_FEATURE_FLAGS = String(process.env.ENFORCE_FEATURE_FLAGS || '').toLowerCase() === 'true';

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

// --- Cookie helpers ---
function authCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, path: '/', maxAge: AUTH_COOKIE_MAX_AGE_MS };
}
function clearAuthCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, path: '/' };
}
function csrfCookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/', maxAge: CSRF_COOKIE_MAX_AGE_MS };
}
function clearCsrfCookieOptions() {
  return { httpOnly: true, sameSite: 'strict', secure: IS_PRODUCTION, path: '/' };
}

// --- Security helpers ---
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'escape' }).trim();
}

function generateCsrfToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('hex');
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

function csrfProtection(req, res, next) {
  if (req.method !== 'POST') return next();
  const tokenFromBody = req.body?._csrf;
  const tokenFromHeader = req.get('x-csrf-token');
  const tokenFromRequest = tokenFromBody || tokenFromHeader;
  const tokenFromSession = req.cookies?.csrf_token;
  if (!tokenFromRequest || !tokenFromSession) {
    return res.status(403).send('CSRF token inválido. Recarga la página e intenta de nuevo.');
  }
  if (!safeCompareStrings(tokenFromRequest, tokenFromSession)) {
    return res.status(403).send('CSRF token inválido. Recarga la página e intenta de nuevo.');
  }
  next();
}

function attachCsrfToken(req, res, next) {
  if (!req.cookies?.csrf_token) {
    const token = generateCsrfToken();
    res.cookie('csrf_token', token, csrfCookieOptions());
    res.locals.csrfToken = token;
  } else {
    res.locals.csrfToken = req.cookies.csrf_token;
  }
  next();
}

function extractApiKey(req) {
  return req.get('x-api-key') || '';
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

// --- Data access helpers ---
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

// --- Auth middleware ---
async function refreshTokenIfNeeded(req, res, next) {
  if (!USE_SUPABASE || !supabaseAuth) return next();
  if (req.auth?.user) return next();

  const accessToken = req.cookies?.sb_access_token;
  const refreshToken = req.cookies?.sb_refresh_token;

  if (!accessToken || !refreshToken) {
    req.auth = { user: null };
    return next();
  }

  const { data: userData, error: userError } = await supabaseAuth.auth.getUser(accessToken);
  if (userData?.user && !userError) {
    req.auth = { user: userData.user };
    return next();
  }

  try {
    const { data: refreshData, error: refreshError } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
    if (refreshError || !refreshData?.session) {
      res.clearCookie('sb_access_token', clearAuthCookieOptions());
      res.clearCookie('sb_refresh_token', clearAuthCookieOptions());
      req.auth = { user: null };
      return next();
    }
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

// --- Render helper ---
function renderPage(res, view, data) {
  const viewsPath = app.get('views');
  const title = data?.title || 'GTD_Neto';
  const flash = data?.flash || null;
  const csrfToken = res.locals?.csrfToken || '';
  const cspNonce = res.locals?.cspNonce || '';
  const navCounts = res.locals?.navCounts || {};
  const featureFlags = res.locals?.featureFlags || {};
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
        navCounts,
        featureFlags,
      })
    )
    .catch(err => {
      console.error(`[renderPage] Error rendering view "${view}":`, err);
      if (!res.headersSent) res.status(500).send('Error rendering page');
    });
}

// --- Rate limiters ---
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos de autenticación, intenta de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiadas exportaciones, intenta de nuevo en 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Express setup ---
if (IS_PRODUCTION) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(cspNonceMiddleware);
app.use(requestIdMiddleware);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'"],
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

app.use(generalLimiter);

app.set('view engine', 'ejs');
app.set('views', new URL('./views', import.meta.url).pathname);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
const jsonParser = express.json({ limit: JSON_BODY_LIMIT });
const importJsonParser = express.json({ limit: IMPORT_JSON_BODY_LIMIT });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/import') return importJsonParser(req, res, next);
  return jsonParser(req, res, next);
});
app.use(cookieParser());
app.use('/public', express.static(new URL('./public', import.meta.url).pathname));
app.use('/docs', express.static(new URL('./docs', import.meta.url).pathname));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(new URL('./public/sw.js', import.meta.url).pathname);
});

app.use(refreshTokenIfNeeded);
app.use(attachAuth);
app.use(attachCsrfToken);
app.use((req, res, next) => {
  res.locals.authUser = req.auth?.user || null;
  next();
});
app.use(csrfProtection);

// navCounts middleware — single aggregation pass for all authenticated routes
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const publicPaths = ['/login', '/signup', '/healthz', '/favicon.ico', '/favicon.png', '/metricsz'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/public/') || req.path.startsWith('/docs/')) return next();
  if (!req.auth?.user && USE_SUPABASE) return next();

  try {
    const db = await loadReqDb(req);
    const items = db.items || [];
    const counts = items.reduce((acc, item) => {
      if (item.status !== 'done') {
        const key = String(item.list || 'collect');
        acc[key] = (acc[key] || 0) + 1;
      }
      return acc;
    }, {});
    res.locals.navCounts = counts;
  } catch {
    res.locals.navCounts = {};
  }
  next();
});

// feature flags defaults (all enabled when ENFORCE_FEATURE_FLAGS is false)
app.use((req, res, next) => {
  res.locals.featureFlags = {
    weekly_review: true,
    custom_contexts: true,
    custom_areas: true,
    command_palette: true,
  };
  next();
});

// --- Public routes check ---
app.use((req, res, next) => {
  const publicPaths = ['/login', '/signup', '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout', '/healthz', '/favicon.ico', '/favicon.png'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/docs/')) return next();
  return requireAuth(req, res, next);
});

// --- Route factories (shared deps) ---
const routeDeps = {
  loadReqDb,
  loadReqItemsByList,
  loadReqItemsByStatus,
  loadReqItemById,
  saveReqDb,
  saveReqItem,
  deleteReqItem,
  requireApiKey,
  sanitizeInput,
  userFacingPersistError,
  renderPage,
  APP_API_KEY,
  ownerForReq,
  exportLimiter,
  validateAndNormalizeImportPayload,
  ImportValidationError,
};

// contexts/areas middleware — inject into res.locals for filter bars
app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const publicPaths = ['/login', '/signup', '/healthz', '/favicon.ico', '/favicon.png', '/metricsz'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/public/') || req.path.startsWith('/docs/')) return next();
  if (!req.auth?.user && USE_SUPABASE) return next();

  try {
    const owner = ownerForReq(req);
    const [customContexts, customAreas] = await Promise.all([
      loadMetaByKind('context', { owner }),
      loadMetaByKind('area', { owner }),
    ]);
    res.locals.allContexts = [...SYSTEM_CONTEXTS, ...customContexts.map(c => c.value).filter(Boolean)];
    res.locals.allAreas = [...SYSTEM_AREAS, ...customAreas.map(a => a.value).filter(Boolean)];
  } catch {
    res.locals.allContexts = SYSTEM_CONTEXTS;
    res.locals.allAreas = SYSTEM_AREAS;
  }
  next();
});

// Mount auth routes
app.use(createAuthRoutes({
  USE_SUPABASE,
  supabaseAuth,
  APP_URL,
  sanitizeInput,
  authCookieOptions,
  clearAuthCookieOptions,
  clearCsrfCookieOptions,
  authLimiter,
  renderPage,
}));

// Mount item routes
app.use(createItemRoutes(routeDeps));

// Mount destination routes
app.use(createDestinationRoutes(routeDeps));

// Mount settings routes
app.use(createSettingsRoutes({ renderPage, requireApiKey, sanitizeInput, ownerForReq }));

// Mount weekly review routes (created lazily after its module is ready)
app.use(createWeeklyReviewRoutes({ ...routeDeps, loadMetaByKind }));

// Onboarding page
app.get('/onboarding', requireApiKey, (req, res) => {
  renderPage(res, 'onboarding', { title: 'Bienvenido' });
});

// --- Health / Metrics ---
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/metricsz', requireApiKey, metricsHandler);

app.use(notFoundHandler);
app.use(errorHandler);

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
  });
}

export default app;
