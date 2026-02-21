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
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/import') {
    return importJsonParser(req, res, next);
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

  const { error } = await supabaseAuth.auth.signUp({ email, password });
  if (error) {
    return renderPage(res, 'signup', {
      title: 'Registro',
      flash: { error: error.message || 'No se pudo crear la cuenta.' },
      needApiKey: false,
    });
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
  const publicPaths = ['/login', '/signup', '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout', '/healthz', '/favicon.ico', '/favicon.png'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/docs/')) return next();
  return requireAuth(req, res, next);
});

app.get('/', async (req, res) => {
  const db = await loadReqDb(req);
  const items = db.items || [];

  // Single-pass aggregation
  const counts = items.reduce((acc, item) => {
    if (item.status === 'done') {
      acc.done += 1;
    } else {
      const key = String(item.list || 'collect');
      acc.byList[key] = (acc.byList[key] || 0) + 1;
    }
    return acc;
  }, { done: 0, byList: {} });

  const cards = [
    { label: 'Collect', count: counts.byList.collect || 0, href: '/collect', hint: 'Captura rápida' },
    ...DESTINATIONS.map(d => ({
      label: d.label,
      count: counts.byList[d.key] || 0,
      href: `/${d.key}`,
      hint: d.hint,
    })),
    { label: 'Terminado', count: counts.done, href: '/terminado', hint: 'Historial de completadas' },
  ];

  return renderPage(res, 'dashboard', {
    title: 'Dashboard',
    cards,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.get('/stats', async (req, res) => {
  const db = await loadReqDb(req);
  const items = db.items || [];

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(todayStart);
  monthStart.setDate(monthStart.getDate() - 30);

  // Single-pass aggregation para todas las métricas
  const result = items.reduce((acc, item) => {
    if (item.status === 'done' && item.completedAt) {
      acc.completedCount += 1;
      const completedDate = new Date(item.completedAt);
      if (!Number.isNaN(completedDate.getTime())) {
        if (completedDate >= todayStart) acc.completedToday += 1;
        if (completedDate >= weekStart) acc.completedWeek += 1;
        if (completedDate >= monthStart) acc.completedMonth += 1;

        const dayKey = completedDate.toISOString().slice(0, 10);
        acc.completedPerDay.set(dayKey, (acc.completedPerDay.get(dayKey) || 0) + 1);
      }
    } else {
      acc.activeCount += 1;
      const list = String(item.list || 'collect');
      if (Object.prototype.hasOwnProperty.call(acc.byList, list)) {
        acc.byList[list] += 1;
      }
    }
    return acc;
  }, {
    activeCount: 0,
    completedCount: 0,
    completedToday: 0,
    completedWeek: 0,
    completedMonth: 0,
    completedPerDay: new Map(),
    byList: DESTINATIONS.reduce((acc, d) => ({ ...acc, [d.key]: 0 }), { collect: 0 }),
  });

  const stats = {
    total: items.length,
    active: result.activeCount,
    completed: result.completedCount,
    completedToday: result.completedToday,
    completedWeek: result.completedWeek,
    completedMonth: result.completedMonth,
  };

  // Últimos 7 días de actividad
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - i);
    const dayKey = date.toISOString().slice(0, 10);
    const count = result.completedPerDay.get(dayKey) || 0;

    last7Days.push({
      date: date.toLocaleDateString('es', { weekday: 'short', day: 'numeric' }),
      count,
    });
  }

  // Calcular promedio
  const avgPerDay = stats.completedWeek / 7;

  return renderPage(res, 'stats', {
    title: 'Estadísticas',
    stats,
    byList: result.byList,
    last7Days,
    avgPerDay: avgPerDay.toFixed(1),
    maxCount: Math.max(...last7Days.map(d => d.count), 1),
  });
});

app.get('/collect', async (req, res) => {
  try {
    const items = (await loadReqItemsByList(req, 'collect', { excludeDone: true }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return await renderPage(res, 'collect', {
      title: 'Collect',
      items,
      destinations: DESTINATIONS,
      needApiKey: Boolean(APP_API_KEY),
      flash: req.query?.error ? { error: String(req.query.error) } : null,
    });
  } catch (err) {
    console.error('[collect] Error:', err);
    res.status(500).send('Error loading collect page');
  }
});

app.post('/collect/add', requireApiKey, async (req, res) => {
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  try {
    const input = sanitizeTextField(req.body?.input, sanitizeInput, { field: 'input', required: true, maxLen: 500 });
    if (!input) {
      if (wantsJson) {
        return res.status(400).json({ ok: false, error: 'empty_input' });
      }
      return res.redirect('/collect');
    }

    // Guard anti-duplicados: verificar sin cargar toda la DB
    const recentDuplicate = await findRecentDuplicate(input, { owner: ownerForReq(req) });

    if (recentDuplicate) {
      if (wantsJson) {
        return res.json({ ok: true, item: recentDuplicate, deduped: true });
      }
      return res.redirect('/collect');
    }

    const item = updateItem(newItem({ input }), {
      title: input,
      kind: 'action',
      list: 'collect',
      status: 'unprocessed',
    });

    // En modo Supabase, usar saveItem directamente sin cargar toda la DB
    if (isStoreSupabaseMode()) {
      await saveReqItem(req, item);
    } else {
      // Modo local: cargar DB, agregar item, guardar
      const db = await loadReqDb(req);
      db.items = [item, ...(db.items || [])];
      await saveReqDb(req, db);
    }

    if (wantsJson) {
      return res.json({ ok: true, item, deduped: false });
    }

    return res.redirect('/collect');
  } catch (err) {
    console.error('[/collect/add] Error:', err);
    if (err instanceof RequestValidationError) {
      if (wantsJson) {
        return res.status(err.status || 400).json({ ok: false, error: err.message });
      }
      return res.redirect('/collect');
    }

    const userMessage = userFacingPersistError(err);

    if (wantsJson) {
      return res.status(500).json({
        ok: false,
        error: 'persist_failed',
        message: userMessage,
      });
    }
    return res.redirect(`/collect?error=${encodeURIComponent(userMessage)}`);
  }
});

app.post('/collect/:id/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const input = sanitizeTextField(req.body?.input, sanitizeInput, { field: 'input', required: true, maxLen: 500 });
    if (!input) return res.redirect('/collect');

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'collect') return res.redirect('/collect');
      const next = updateItem(current, { input, title: input });
      await saveReqItem(req, next);
      return res.redirect('/collect');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'collect');
    if (idx === -1) return res.redirect('/collect');

    db.items[idx] = updateItem(db.items[idx], { input, title: input });
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/collect');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/collect');
    throw err;
  }
});

app.post('/collect/:id/send', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const destination = sanitizeEnumField(req.body?.destination, DESTINATIONS.map(d => d.key), sanitizeInput, 'destination');
    if (!destinationByKey(destination)) return res.status(400).send('Bad destination');

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current) return res.redirect('/collect');

      const basePatch = {
        list: destination,
        status: 'processed',
      };
      let patch = basePatch;
      if (destination === 'hacer') patch = withHacerMeta(current, basePatch);
      if (destination === 'desglosar') patch = withDesglosarMeta(current, basePatch);

      const next = updateItem(current, patch);
      await saveReqItem(req, next);
      return res.redirect('/collect');
    }

    const db = await loadReqDb(req);
  // Validación de owner implícita: loadReqDb solo carga items del usuario actual
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) return res.redirect('/collect');

  const basePatch = {
    list: destination,
    status: 'processed',
  };

  let patch = basePatch;
  if (destination === 'hacer') patch = withHacerMeta(db.items[idx], basePatch);
  if (destination === 'desglosar') patch = withDesglosarMeta(db.items[idx], basePatch);

    db.items[idx] = updateItem(db.items[idx], patch);
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/collect');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.status(err.status || 400).send(err.message);
    throw err;
  }
});

app.post('/items/:id/tags', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const tagsInput = sanitizeTextField(req.body?.tags, sanitizeInput, { field: 'tags', required: false, maxLen: 400 });

  // Parse tags: split por comas, trim, filtrar vacíos, lowercase
  const tags = tagsInput
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0 && t.length <= 20)
    .slice(0, 5); // Máximo 5 tags

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current) return res.status(404).json({ ok: false, error: 'Item not found' });
      await saveReqItem(req, updateItem(current, { tags }));
      return res.json({ ok: true, tags });
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id);
    if (idx === -1) {
      return res.status(404).json({ ok: false, error: 'Item not found' });
    }

    db.items[idx] = updateItem(db.items[idx], { tags });
    await saveReqItem(req, db.items[idx], db);

    return res.json({ ok: true, tags });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    throw err;
  }
});

app.get('/hacer', async (req, res) => {
  const items = (await loadReqItemsByList(req, 'hacer', { excludeDone: true }))
    .map(i => ({ ...i, ...withHacerMeta(i) }))
    .sort((a, b) => {
      const byUrgency = Number(b.urgency || 0) - Number(a.urgency || 0);
      if (byUrgency !== 0) return byUrgency;
      return Number(b.importance || 0) - Number(a.importance || 0);
    });

  return renderPage(res, 'hacer', {
    title: 'Hacer',
    items,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/hacer/add', requireApiKey, async (req, res) => {
  // Regla: Hacer solo recibe items desde Collect
  return res.status(405).type('text').send('Method not allowed: agrega en Collect y luego envía a Hacer.');
});

app.post('/hacer/:id/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'hacer') return res.redirect('/hacer');
      const patch = {
        title: sanitizeTextField(req.body?.title || current.title || current.input || '', sanitizeInput, { field: 'title', required: true, maxLen: 280 }),
        urgency: sanitizeIntegerField(req.body?.urgency ?? current.urgency ?? 3, { field: 'urgency', min: 1, max: 5, fallback: 3 }),
        importance: sanitizeIntegerField(req.body?.importance ?? current.importance ?? 3, { field: 'importance', min: 1, max: 5, fallback: 3 }),
        estimateMin: sanitizeIntegerField(req.body?.estimateMin ?? current.estimateMin ?? 10, { field: 'estimateMin', min: 1, max: 600, fallback: 10 }),
      };
      const next = updateItem(current, withHacerMeta(current, patch));
      await saveReqItem(req, next);
      return res.redirect('/hacer');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
    if (idx === -1) return res.redirect('/hacer');

    const current = db.items[idx];
    const patch = {
      title: sanitizeTextField(req.body?.title || current.title || current.input || '', sanitizeInput, { field: 'title', required: true, maxLen: 280 }),
      urgency: sanitizeIntegerField(req.body?.urgency ?? current.urgency ?? 3, { field: 'urgency', min: 1, max: 5, fallback: 3 }),
      importance: sanitizeIntegerField(req.body?.importance ?? current.importance ?? 3, { field: 'importance', min: 1, max: 5, fallback: 3 }),
      estimateMin: sanitizeIntegerField(req.body?.estimateMin ?? current.estimateMin ?? 10, { field: 'estimateMin', min: 1, max: 600, fallback: 10 }),
    };

    db.items[idx] = updateItem(current, withHacerMeta(current, patch));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/hacer');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/hacer');
    throw err;
  }
});

app.post('/hacer/:id/complete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const comment = sanitizeInput(String(req.body?.comment || ''));

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'hacer') return res.redirect('/hacer');
      const next = updateItem(current, {
        status: 'done',
        completedAt: new Date().toISOString(),
        completionComment: comment || null,
      });
      await saveReqItem(req, next);
      return res.redirect('/hacer');
    }

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
  if (idx === -1) return res.redirect('/hacer');

  db.items[idx] = updateItem(db.items[idx], {
    status: 'done',
    completedAt: new Date().toISOString(),
    completionComment: comment || null,
  });
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/hacer');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/hacer');
    throw err;
  }
});

app.get('/terminado', async (req, res) => {
  const items = (await loadReqItemsByStatus(req, 'done'))
    .sort((a, b) => String(b.completedAt || b.updatedAt || '').localeCompare(String(a.completedAt || a.updatedAt || '')));

  return renderPage(res, 'terminado', {
    title: 'Terminado',
    items,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/terminado/:id/comment', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const comment = sanitizeInput(String(req.body?.completionComment || ''));

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.status !== 'done') return res.redirect('/terminado');
      await saveReqItem(req, updateItem(current, { completionComment: comment || null }));
      return res.redirect('/terminado');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.status === 'done');
    if (idx === -1) return res.redirect('/terminado');

    db.items[idx] = updateItem(db.items[idx], { completionComment: comment || null });
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/terminado');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/terminado');
    throw err;
  }
});

app.get('/agendar', async (req, res) => {
  const items = (await loadReqItemsByList(req, 'agendar', { excludeDone: true }))
    .map(i => ({ ...i, ...evaluateActionability(i.title || i.input || '') }))
    .sort((a, b) => {
      const ad = String(a.scheduledFor || '9999-12-31');
      const bd = String(b.scheduledFor || '9999-12-31');
      return ad.localeCompare(bd); // fecha más próxima primero
    });

  return renderPage(res, 'agendar', {
    title: 'Agendar',
    items,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/agendar/:id/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const scheduledFor = sanitizeInput(String(req.body?.scheduledFor || ''));

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'agendar') return res.redirect('/agendar');
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      const next = updateItem(current, {
        title,
        scheduledFor: scheduledFor || null,
      });
      await saveReqItem(req, next);
      return res.redirect('/agendar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
    if (idx === -1) return res.redirect('/agendar');

    const current = db.items[idx];
    const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
    db.items[idx] = updateItem(current, {
      title,
      scheduledFor: scheduledFor || null,
    });

    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/agendar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/agendar');
    throw err;
  }
});

app.post('/agendar/:id/complete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'agendar') return res.redirect('/agendar');
      const next = updateItem(current, {
        status: 'done',
        completedAt: new Date().toISOString(),
        completionComment: null,
      });
      await saveReqItem(req, next);
      return res.redirect('/agendar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
    if (idx === -1) return res.redirect('/agendar');

    db.items[idx] = updateItem(db.items[idx], {
      status: 'done',
      completedAt: new Date().toISOString(),
      completionComment: null,
    });
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/agendar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/agendar');
    throw err;
  }
});

app.get('/delegar', async (req, res) => {
  const groupBy = String(req.query?.groupBy || 'date') === 'owner' ? 'owner' : 'date';
  const ownerFilter = String(req.query?.owner || '').trim().toLowerCase();
  const error = String(req.query?.error || '');

  const baseItems = (await loadReqItemsByList(req, 'delegar', { excludeDone: true }))
    .map(i => ({
      ...i,
      delegatedTo: String(i.delegatedTo || '').trim(),
      delegatedFor: String(i.delegatedFor || '').trim(),
    }))
    .filter(i => !ownerFilter || i.delegatedTo.toLowerCase().includes(ownerFilter));

  const items = baseItems.sort((a, b) => {
    const ad = String(a.delegatedFor || '9999-12-31');
    const bd = String(b.delegatedFor || '9999-12-31');
    return ad.localeCompare(bd); // más próxima primero, sin fecha al final
  });

  const groupsMap = new Map();
  for (const item of items) {
    const key = groupBy === 'owner'
      ? (item.delegatedTo || 'Sin responsable')
      : (item.delegatedFor || 'Sin fecha');
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push(item);
  }

  const groups = Array.from(groupsMap.entries()).map(([label, rows]) => ({ label, rows }));

  return renderPage(res, 'delegar', {
    title: 'Delegar',
    items,
    groups,
    groupBy,
    ownerFilter: String(req.query?.owner || ''),
    error,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/delegar/:id/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const delegatedFor = sanitizeTextField(req.body?.delegatedFor, sanitizeInput, { field: 'delegatedFor', required: true, maxLen: 40 });
    const delegatedTo = sanitizeTextField(req.body?.delegatedTo, sanitizeInput, { field: 'delegatedTo', required: true, maxLen: 120 });

    if (!delegatedFor || !delegatedTo) {
      return res.redirect('/delegar?error=missing_fields');
    }

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'delegar') return res.redirect('/delegar?error=not_found');
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      await saveReqItem(req, updateItem(current, {
        title,
        delegatedFor,
        delegatedTo,
      }));
      return res.redirect('/delegar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'delegar');
    if (idx === -1) return res.redirect('/delegar?error=not_found');

    const current = db.items[idx];
    const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
    db.items[idx] = updateItem(current, {
      title,
      delegatedFor,
      delegatedTo,
    });

    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/delegar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/delegar?error=missing_fields');
    throw err;
  }
});

app.get('/desglosar', async (req, res) => {
  const items = (await loadReqItemsByList(req, 'desglosar', { excludeDone: true }))
    .map(i => withDesglosarMeta(i))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

  return renderPage(res, 'desglosar', {
    title: 'Desglosar',
    items,
    destinations: DESTINATIONS.filter(d => ['hacer', 'agendar', 'delegar'].includes(d.key)),
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/desglosar/:id/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
      const current = withDesglosarMeta(currentRaw);
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));
      const next = updateItem(current, withDesglosarMeta(current, { title, objective }));
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');

    const current = withDesglosarMeta(db.items[idx]);
    const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
    const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));

    db.items[idx] = updateItem(current, withDesglosarMeta(current, {
      title,
      objective,
    }));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/subtasks/add', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const text = sanitizeInput(String(req.body?.subtask || ''));
    if (!text) return res.redirect('/desglosar');

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
      const current = withDesglosarMeta(currentRaw);
      const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
      const next = updateItem(current, withDesglosarMeta(current, { subtasks }));
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');

    const current = withDesglosarMeta(db.items[idx]);
    const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
    db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/subtasks/:subId/send', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const subId = sanitizeIdParam(req.params.subId, sanitizeInput);
    const destination = String(req.body?.destination || '');
    if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.status(400).send('Bad destination');

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');

      const current = withDesglosarMeta(currentRaw);
      const subtasks = [...(current.subtasks || [])];
      const subIdx = subtasks.findIndex(s => String(s.id) === subId);
      if (subIdx === -1) return res.redirect('/desglosar');

      const subtask = subtasks[subIdx];
      const text = String(subtask.text || '').trim();
      if (!text) return res.redirect('/desglosar');

      const base = newItem({ input: text });
      let newTask = updateItem(base, {
        title: text,
        kind: 'action',
        list: destination,
        status: 'processed',
        sourceProjectId: id,
        sourceSubtaskId: subId,
      });
      if (destination === 'hacer') newTask = updateItem(newTask, withHacerMeta(newTask));

      subtasks[subIdx] = { ...subtask, status: 'sent', sentTo: destination, sentItemId: newTask.id };
      const updatedProject = updateItem(current, withDesglosarMeta(current, { subtasks }));
      await saveReqItem(req, updatedProject);
      await saveReqItem(req, newTask);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');

    const current = withDesglosarMeta(db.items[idx]);
    const subtasks = [...(current.subtasks || [])];
    const subIdx = subtasks.findIndex(s => String(s.id) === subId);
    if (subIdx === -1) return res.redirect('/desglosar');

    const subtask = subtasks[subIdx];
    const text = String(subtask.text || '').trim();
    if (!text) return res.redirect('/desglosar');

    const base = newItem({ input: text });
    let newTask = updateItem(base, {
      title: text,
      kind: 'action',
      list: destination,
      status: 'processed',
      sourceProjectId: id,
      sourceSubtaskId: subId,
    });
    if (destination === 'hacer') newTask = updateItem(newTask, withHacerMeta(newTask));

    subtasks[subIdx] = { ...subtask, status: 'sent', sentTo: destination, sentItemId: newTask.id };
    db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
    db.items = [newTask, ...(db.items || [])];
    await saveReqDb(req, db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/subtasks/:subId/complete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const subId = sanitizeIdParam(req.params.subId, sanitizeInput);

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
      const current = withDesglosarMeta(currentRaw);
      const subtasks = [...(current.subtasks || [])];
      const subIdx = subtasks.findIndex(s => String(s.id) === subId);
      if (subIdx === -1) return res.redirect('/desglosar');
      subtasks[subIdx] = { ...subtasks[subIdx], status: 'done', completedAt: new Date().toISOString() };
      const next = updateItem(current, withDesglosarMeta(current, { subtasks }));
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');
    const current = withDesglosarMeta(db.items[idx]);
    const subtasks = [...(current.subtasks || [])];
    const subIdx = subtasks.findIndex(s => String(s.id) === subId);
    if (subIdx === -1) return res.redirect('/desglosar');
    subtasks[subIdx] = { ...subtasks[subIdx], status: 'done', completedAt: new Date().toISOString() };
    db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/subtasks/:subId/update', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const subId = sanitizeIdParam(req.params.subId, sanitizeInput);
    const raw = req.body?.subtaskText;
    const text = sanitizeInput(String(raw || '')).trim();
    if (!text || text.length > 280) return res.redirect('/desglosar');

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
      const current = withDesglosarMeta(currentRaw);
      const subtasks = [...(current.subtasks || [])];
      const subIdx = subtasks.findIndex(s => String(s.id) === subId);
      if (subIdx === -1) return res.redirect('/desglosar');
      if (subtasks[subIdx].status === 'sent') return res.redirect('/desglosar');
      subtasks[subIdx] = { ...subtasks[subIdx], text };
      const next = updateItem(current, withDesglosarMeta(current, { subtasks }));
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');
    const current = withDesglosarMeta(db.items[idx]);
    const subtasks = [...(current.subtasks || [])];
    const subIdx = subtasks.findIndex(s => String(s.id) === subId);
    if (subIdx === -1) return res.redirect('/desglosar');
    if (subtasks[subIdx].status === 'sent') return res.redirect('/desglosar');
    subtasks[subIdx] = { ...subtasks[subIdx], text };
    db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/subtasks/:subId/delete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    const subId = sanitizeIdParam(req.params.subId, sanitizeInput);

    if (isStoreSupabaseMode()) {
      const currentRaw = await loadReqItemById(req, id);
      if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
      const current = withDesglosarMeta(currentRaw);
      const subtasks = (current.subtasks || []).filter(s => String(s.id) !== subId);
      const next = updateItem(current, withDesglosarMeta(current, { subtasks }));
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');
    const current = withDesglosarMeta(db.items[idx]);
    const subtasks = (current.subtasks || []).filter(s => String(s.id) !== subId);
    db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

app.post('/desglosar/:id/complete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);

    if (isStoreSupabaseMode()) {
      const current = await loadReqItemById(req, id);
      if (!current || current.list !== 'desglosar') return res.redirect('/desglosar');
      const next = updateItem(current, { status: 'done', completedAt: new Date().toISOString() });
      await saveReqItem(req, next);
      return res.redirect('/desglosar');
    }

    const db = await loadReqDb(req);
    const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
    if (idx === -1) return res.redirect('/desglosar');
    db.items[idx] = updateItem(db.items[idx], { status: 'done', completedAt: new Date().toISOString() });
    await saveReqItem(req, db.items[idx], db);
    return res.redirect('/desglosar');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('/desglosar');
    throw err;
  }
});

for (const d of DESTINATIONS.filter(x => x.key !== 'hacer' && x.key !== 'agendar' && x.key !== 'delegar' && x.key !== 'desglosar')) {
  app.get(`/${d.key}`, async (req, res) => {
    const items = (await loadReqItemsByList(req, d.key, { excludeDone: true }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return renderPage(res, 'destination', {
      title: d.label,
      section: d,
      items,
      needApiKey: Boolean(APP_API_KEY),
    });
  });
}

app.post('/items/:id/delete', requireApiKey, async (req, res) => {
  try {
    const id = sanitizeIdParam(req.params.id, sanitizeInput);
    if (isStoreSupabaseMode()) {
      await deleteReqItem(req, id);
    } else {
      const db = await loadReqDb(req);
      db.items = (db.items || []).filter(i => i.id !== id);
      await deleteReqItem(req, id, db);
    }
    return res.redirect('back');
  } catch (err) {
    if (err instanceof RequestValidationError) return res.redirect('back');
    throw err;
  }
});


app.get('/export', async (req, res) => {
  return renderPage(res, 'export', {
    title: 'Exportar/Importar Datos',
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.get('/export/json', exportLimiter, async (req, res) => {
  const db = await loadReqDb(req);
  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    items: db.items || [],
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="gtd_neto_export_${Date.now()}.json"`);
  return res.send(JSON.stringify(exportData, null, 2));
});

app.get('/export/csv', exportLimiter, async (req, res) => {
  const db = await loadReqDb(req);
  const items = db.items || [];

  // Header CSV
  const headers = ['id', 'title', 'list', 'status', 'urgency', 'importance', 'scheduledFor', 'delegatedTo', 'createdAt', 'completedAt'];
  let csv = headers.join(',') + '\n';

  // Rows
  items.forEach(item => {
    const row = headers.map(h => {
      const value = item[h] || '';
      // Escapar comas y quotes
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    csv += row.join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="gtd_neto_export_${Date.now()}.csv"`);
  return res.send(csv);
});

app.post('/import', requireApiKey, async (req, res) => {
  try {
    if (!req.is('application/json')) {
      return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
    }

    const normalizedItems = validateAndNormalizeImportPayload(req.body, sanitizeInput);

    const db = await loadReqDb(req);

    // Merge: agregar items nuevos, no sobrescribir existentes
    const existingIds = new Set((db.items || []).map(i => i.id));
    const newItems = normalizedItems.filter(i => !existingIds.has(i.id));

    db.items = [...(db.items || []), ...newItems];
    await saveReqDb(req, db);

    return res.json({ ok: true, imported: newItems.length });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    if (err instanceof ImportValidationError) {
      return res.status(err.status || 400).json({
        ok: false,
        error: err.message,
        details: err.details,
      });
    }
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
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
