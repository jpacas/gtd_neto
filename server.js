import 'dotenv/config';
import express from 'express';
import ejs from 'ejs';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import sanitizeHtml from 'sanitize-html';

import { loadDb, saveDb, newItem, updateItem } from './lib/store.js';

const app = express();

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const APP_API_KEY = process.env.APP_API_KEY || '';
const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!APP_API_KEY) {
  console.warn('[gtd_neto] WARNING: APP_API_KEY is empty. Set it in .env to protect POST endpoints.');
}

if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.warn('[gtd_neto] WARNING: USE_SUPABASE=true but SUPABASE_URL/SUPABASE_ANON_KEY are missing. Login will fail.');
}

const supabaseAuth = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

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
  const tokenFromSession = req.cookies?.csrf_token;

  if (!tokenFromBody || !tokenFromSession || tokenFromBody !== tokenFromSession) {
    return res.status(403).send('CSRF token inválido. Recarga la página e intenta de nuevo.');
  }

  next();
}

function attachCsrfToken(req, res, next) {
  // Generar token si no existe
  if (!req.cookies?.csrf_token) {
    const token = generateCsrfToken();
    const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
    res.cookie('csrf_token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecure,
      path: '/',
      maxAge: 24 * 60 * 60 * 1000, // 24 horas
    });
    res.locals.csrfToken = token;
  } else {
    res.locals.csrfToken = req.cookies.csrf_token;
  }
  next();
}

// Middlewares de seguridad y performance
app.use(compression()); // Comprimir respuestas

// Helmet para security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline necesario para scripts inline en templates
      styleSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline necesario para estilos inline
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
  max: 100, // Límite de 100 requests por ventana
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

app.use(generalLimiter);

app.set('view engine', 'ejs');
app.set('views', new URL('./views', import.meta.url).pathname);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' })); // Para requests JSON
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
  return req.get('x-api-key') || req.body?.apiKey || req.query?.apiKey || '';
}

function requireApiKey(req, res, next) {
  if (!APP_API_KEY) return next();
  const key = extractApiKey(req);
  if (key && key === APP_API_KEY) return next();
  return res.status(401).send('Unauthorized');
}

function ownerForReq(req) {
  return req.auth?.user?.id || process.env.SUPABASE_OWNER || 'default';
}

async function loadReqDb(req) {
  return loadDb({ owner: ownerForReq(req) });
}

async function saveReqDb(req, db) {
  return saveDb(db, { owner: ownerForReq(req) });
}

async function attachAuth(req, res, next) {
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
  const body = ejs.renderFile(`${viewsPath}/${view}.ejs`, { ...data, csrfToken });
  return Promise.resolve(body).then(html =>
    res.render('layout', {
      title,
      flash,
      body: html,
      useSupabase: USE_SUPABASE,
      authUser: data?.authUser || res.locals?.authUser || null,
      csrfToken,
    })
  );
}

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
    apiKey: '',
    message: String(req.query?.message || ''),
  });
});

app.get('/signup', async (req, res) => {
  if (!USE_SUPABASE) return res.redirect('/');
  if (req.auth?.user) return res.redirect('/');
  return renderPage(res, 'signup', { title: 'Registro', needApiKey: false, apiKey: '' });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());
  const password = String(req.body?.password || ''); // No sanitizar password

  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data?.session) {
    return renderPage(res, 'login', {
      title: 'Login',
      flash: { error: 'Credenciales inválidas.' },
      needApiKey: false,
      apiKey: '',
    });
  }

  const isSecure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  res.cookie('sb_access_token', data.session.access_token, { httpOnly: true, sameSite: 'lax', secure: isSecure, path: '/' });
  res.cookie('sb_refresh_token', data.session.refresh_token, { httpOnly: true, sameSite: 'lax', secure: isSecure, path: '/' });
  return res.redirect('/');
});

app.post('/auth/signup', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());
  const password = String(req.body?.password || ''); // No sanitizar password

  const { error } = await supabaseAuth.auth.signUp({ email, password });
  if (error) {
    return renderPage(res, 'signup', {
      title: 'Registro',
      flash: { error: error.message || 'No se pudo crear la cuenta.' },
      needApiKey: false,
      apiKey: '',
    });
  }

  return res.redirect('/login?message=Cuenta creada. Revisa tu correo para confirmación si aplica.');
});

app.post('/auth/forgot', authLimiter, async (req, res) => {
  if (!USE_SUPABASE || !supabaseAuth) return res.redirect('/');

  const email = sanitizeInput(String(req.body?.email || '').trim());
  if (!email) return res.redirect('/login?message=Ingresa tu correo para recuperar contraseña.');

  const redirectTo = `${req.protocol}://${req.get('host')}/login?message=Contraseña actualizada. Ya puedes iniciar sesión.`;
  await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
  return res.redirect('/login?message=Si el correo existe, enviamos enlace de recuperación.');
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('sb_access_token', { path: '/' });
  res.clearCookie('sb_refresh_token', { path: '/' });
  return res.redirect('/login');
});

app.use((req, res, next) => {
  const publicPaths = ['/login', '/signup', '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout', '/healthz', '/favicon.ico', '/favicon.png'];
  if (publicPaths.includes(req.path) || req.path.startsWith('/docs/')) return next();
  return requireAuth(req, res, next);
});

const DESTINATIONS = [
  { key: 'hacer', label: 'Hacer', hint: 'Acciones <10 min, claras y priorizadas' },
  { key: 'agendar', label: 'Agendar', hint: 'Acciones con fecha/agenda' },
  { key: 'delegar', label: 'Delegar', hint: 'Pendientes de terceros' },
  { key: 'desglosar', label: 'Desglosar', hint: 'Items para dividir en pasos' },
  { key: 'no-hacer', label: 'No hacer', hint: 'Descartar o archivar' },
];

function destinationByKey(key) {
  return DESTINATIONS.find(d => d.key === key) || null;
}

function evaluateActionability(text) {
  const t = String(text || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  const first = (words[0] || '').toLowerCase();
  const vague = ['hacer', 'ver', 'revisar tema', 'pendiente', 'trabajar', 'organizar'];

  const startsWithInfinitive = /[aá]r$|er$|ir$/.test(first);
  const hasEnoughWords = words.length >= 2;
  const tooLong = t.length > 140;
  const hasVaguePattern = vague.some(v => t.toLowerCase() === v || t.toLowerCase().startsWith(v + ' '));

  let score = 0;
  if (startsWithInfinitive) score += 40;
  if (hasEnoughWords) score += 30;
  if (!tooLong) score += 20;
  if (!hasVaguePattern) score += 10;

  const feedback = [];
  if (!startsWithInfinitive) feedback.push('Empieza con un verbo en infinitivo (Ej: Llamar, Enviar, Definir).');
  if (!hasEnoughWords) feedback.push('Hazla más específica (mínimo 2 palabras).');
  if (tooLong) feedback.push('Hazla más corta y concreta (ideal <= 140 caracteres).');
  if (hasVaguePattern) feedback.push('Evita frases vagas; especifica el resultado.');

  return {
    actionableScore: score,
    actionableOk: score >= 70,
    actionableFeedback: feedback.join(' '),
  };
}

function withHacerMeta(item, patch = {}) {
  const urgency = Number(patch.urgency ?? item.urgency ?? 3);
  const importance = Number(patch.importance ?? item.importance ?? 3);
  const estimateMinRaw = Number(patch.estimateMin ?? item.estimateMin ?? 10);
  const estimateMin = Math.min(10, Math.max(1, estimateMinRaw));

  const title = String(patch.title ?? item.title ?? item.input ?? '').trim();
  const qa = evaluateActionability(title);
  const priorityScore = urgency * importance;

  // Validar si la tarea debería ir a Desglosar por duración
  let durationWarning = null;
  if (estimateMinRaw > 10) {
    durationWarning = `Esta tarea requiere más de 10 minutos (${estimateMinRaw} min). Considera moverla a Desglosar para dividirla en pasos más pequeños.`;
  }

  return {
    ...patch,
    title,
    urgency,
    importance,
    estimateMin,
    priorityScore,
    durationWarning,
    ...qa,
  };
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Buffer.from(bytes).toString('hex');
}

function withDesglosarMeta(item, patch = {}) {
  const objective = String(patch.objective ?? item.objective ?? '').trim();
  const subtasks = Array.isArray(patch.subtasks ?? item.subtasks)
    ? (patch.subtasks ?? item.subtasks)
    : [];

  return {
    ...patch,
    objective,
    subtasks,
  };
}

app.get('/', async (req, res) => {
  const db = await loadReqDb(req);
  const items = db.items || [];

  const collectCount = items.filter(i => i.list === 'collect' && i.status !== 'done').length;
  const doneCount = items.filter(i => i.status === 'done').length;
  const cards = [
    { label: 'Collect', count: collectCount, href: '/collect', hint: 'Captura rápida' },
    ...DESTINATIONS.map(d => ({
      label: d.label,
      count: items.filter(i => i.list === d.key && i.status !== 'done').length,
      href: `/${d.key}`,
      hint: d.hint,
    })),
    { label: 'Terminado', count: doneCount, href: '/terminado', hint: 'Historial de completadas' },
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

  const completedItems = items.filter(i => i.status === 'done' && i.completedAt);

  // Stats básicas
  const stats = {
    total: items.length,
    active: items.filter(i => i.status !== 'done').length,
    completed: completedItems.length,
    completedToday: completedItems.filter(i => new Date(i.completedAt) >= todayStart).length,
    completedWeek: completedItems.filter(i => new Date(i.completedAt) >= weekStart).length,
    completedMonth: completedItems.filter(i => new Date(i.completedAt) >= monthStart).length,
  };

  // Items por lista
  const byList = {};
  DESTINATIONS.forEach(d => {
    byList[d.key] = items.filter(i => i.list === d.key && i.status !== 'done').length;
  });
  byList.collect = items.filter(i => i.list === 'collect' && i.status !== 'done').length;

  // Últimos 7 días de actividad
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - i);
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);

    const count = completedItems.filter(item => {
      const completedDate = new Date(item.completedAt);
      return completedDate >= date && completedDate < nextDate;
    }).length;

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
    byList,
    last7Days,
    avgPerDay: avgPerDay.toFixed(1),
    maxCount: Math.max(...last7Days.map(d => d.count), 1),
  });
});

app.get('/collect', async (req, res) => {
  const db = await loadReqDb(req);
  const items = (db.items || [])
    .filter(i => i.list === 'collect' && i.status !== 'done')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return renderPage(res, 'collect', {
    title: 'Collect',
    items,
    destinations: DESTINATIONS,
    needApiKey: Boolean(APP_API_KEY),
    apiKey: '',
  });
});

app.post('/collect/add', requireApiKey, async (req, res) => {
  const input = sanitizeInput(String(req.body?.input || ''));
  if (!input) {
    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(400).json({ ok: false, error: 'empty_input' });
    }
    return res.redirect('/collect');
  }

  const db = await loadReqDb(req);

  // Guard anti-duplicados: evita doble inserción si llega el mismo texto casi al mismo tiempo
  const now = Date.now();
  const recentDuplicate = (db.items || []).find(i =>
    i.list === 'collect' &&
    i.status !== 'done' &&
    String(i.input || '').trim().toLowerCase() === input.toLowerCase() &&
    Math.abs(now - new Date(i.createdAt || 0).getTime()) < 3000
  );

  if (recentDuplicate) {
    if (String(req.get('accept') || '').includes('application/json')) {
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
  db.items = [item, ...(db.items || [])];
  await saveReqDb(req, db);

  if (String(req.get('accept') || '').includes('application/json')) {
    return res.json({ ok: true, item, deduped: false });
  }

  return res.redirect('/collect');
});

app.post('/collect/:id/update', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const input = sanitizeInput(String(req.body?.input || ''));
  if (!input) return res.redirect('/collect');

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'collect');
  if (idx === -1) return res.redirect('/collect');

  db.items[idx] = updateItem(db.items[idx], {
    input,
    title: input,
  });
  await saveReqDb(req, db);
  return res.redirect('/collect');
});

app.post('/collect/:id/send', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const destination = sanitizeInput(String(req.body?.destination || ''));
  if (!destinationByKey(destination)) return res.status(400).send('Bad destination');

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
  await saveReqDb(req, db);
  return res.redirect('/collect');
});

app.post('/items/:id/tags', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const tagsInput = sanitizeInput(String(req.body?.tags || ''));

  // Parse tags: split por comas, trim, filtrar vacíos, lowercase
  const tags = tagsInput
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0 && t.length <= 20)
    .slice(0, 5); // Máximo 5 tags

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) {
    return res.status(404).json({ ok: false, error: 'Item not found' });
  }

  db.items[idx] = updateItem(db.items[idx], { tags });
  await saveReqDb(req, db);

  return res.json({ ok: true, tags });
});

app.get('/hacer', async (req, res) => {
  const db = await loadReqDb(req);
  const items = (db.items || [])
    .filter(i => i.list === 'hacer' && i.status !== 'done')
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
    apiKey: '',
  });
});

app.post('/hacer/add', requireApiKey, async (req, res) => {
  // Regla: Hacer solo recibe items desde Collect
  return res.status(405).type('text').send('Method not allowed: agrega en Collect y luego envía a Hacer.');
});

app.post('/hacer/:id/update', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
  if (idx === -1) return res.redirect('/hacer');

  const current = db.items[idx];
  const patch = {
    title: sanitizeInput(String(req.body?.title || current.title || current.input || '')),
    urgency: Number(req.body?.urgency || current.urgency || 3),
    importance: Number(req.body?.importance || current.importance || 3),
    estimateMin: Number(req.body?.estimateMin || current.estimateMin || 10),
  };

  db.items[idx] = updateItem(current, withHacerMeta(current, patch));
  await saveReqDb(req, db);
  return res.redirect('/hacer');
});

app.post('/hacer/:id/complete', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const comment = sanitizeInput(String(req.body?.comment || ''));

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
  if (idx === -1) return res.redirect('/hacer');

  db.items[idx] = updateItem(db.items[idx], {
    status: 'done',
    completedAt: new Date().toISOString(),
    completionComment: comment || null,
  });
  await saveReqDb(req, db);
  return res.redirect('/hacer');
});

app.get('/terminado', async (req, res) => {
  const db = await loadReqDb(req);
  const items = (db.items || [])
    .filter(i => i.status === 'done')
    .sort((a, b) => String(b.completedAt || b.updatedAt || '').localeCompare(String(a.completedAt || a.updatedAt || '')));

  return renderPage(res, 'terminado', {
    title: 'Terminado',
    items,
    needApiKey: Boolean(APP_API_KEY),
    apiKey: '',
  });
});

app.post('/terminado/:id/comment', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const comment = sanitizeInput(String(req.body?.completionComment || ''));

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.status === 'done');
  if (idx === -1) return res.redirect('/terminado');

  db.items[idx] = updateItem(db.items[idx], { completionComment: comment || null });
  await saveReqDb(req, db);
  return res.redirect('/terminado');
});

app.get('/agendar', async (req, res) => {
  const db = await loadReqDb(req);
  const items = (db.items || [])
    .filter(i => i.list === 'agendar' && i.status !== 'done')
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
    apiKey: '',
  });
});

app.post('/agendar/:id/update', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const scheduledFor = sanitizeInput(String(req.body?.scheduledFor || ''));

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
  if (idx === -1) return res.redirect('/agendar');

  const current = db.items[idx];
  const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
  db.items[idx] = updateItem(current, {
    title,
    scheduledFor: scheduledFor || null,
  });

  await saveReqDb(req, db);
  return res.redirect('/agendar');
});

app.post('/agendar/:id/complete', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
  if (idx === -1) return res.redirect('/agendar');

  db.items[idx] = updateItem(db.items[idx], {
    status: 'done',
    completedAt: new Date().toISOString(),
    completionComment: null,
  });
  await saveReqDb(req, db);
  return res.redirect('/agendar');
});

app.get('/delegar', async (req, res) => {
  const db = await loadReqDb(req);
  const groupBy = String(req.query?.groupBy || 'date') === 'owner' ? 'owner' : 'date';
  const ownerFilter = String(req.query?.owner || '').trim().toLowerCase();
  const error = String(req.query?.error || '');

  const baseItems = (db.items || [])
    .filter(i => i.list === 'delegar' && i.status !== 'done')
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
    apiKey: '',
  });
});

app.post('/delegar/:id/update', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const delegatedFor = sanitizeInput(String(req.body?.delegatedFor || ''));
  const delegatedTo = sanitizeInput(String(req.body?.delegatedTo || ''));

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'delegar');
  if (idx === -1) return res.redirect('/delegar?error=not_found');

  if (!delegatedFor || !delegatedTo) {
    return res.redirect('/delegar?error=missing_fields');
  }

  const current = db.items[idx];
  const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
  db.items[idx] = updateItem(current, {
    title,
    delegatedFor,
    delegatedTo,
  });

  await saveReqDb(req, db);
  return res.redirect('/delegar');
});

app.get('/desglosar', async (req, res) => {
  const db = await loadReqDb(req);
  const items = (db.items || [])
    .filter(i => i.list === 'desglosar' && i.status !== 'done')
    .map(i => withDesglosarMeta(i))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

  return renderPage(res, 'desglosar', {
    title: 'Desglosar',
    items,
    destinations: DESTINATIONS.filter(d => ['hacer', 'agendar', 'delegar'].includes(d.key)),
    needApiKey: Boolean(APP_API_KEY),
    apiKey: '',
  });
});

app.post('/desglosar/:id/update', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
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
  await saveReqDb(req, db);
  return res.redirect('/desglosar');
});

app.post('/desglosar/:id/subtasks/add', requireApiKey, async (req, res) => {
  const id = sanitizeInput(String(req.params.id));
  const text = sanitizeInput(String(req.body?.subtask || ''));
  if (!text) return res.redirect('/desglosar');

  const db = await loadReqDb(req);
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
  if (idx === -1) return res.redirect('/desglosar');

  const current = withDesglosarMeta(db.items[idx]);
  const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
  db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
  await saveReqDb(req, db);
  return res.redirect('/desglosar');
});

app.post('/desglosar/:id/subtasks/:subId/send', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const subId = String(req.params.subId);
  const destination = String(req.body?.destination || '');
  if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.status(400).send('Bad destination');

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
});

for (const d of DESTINATIONS.filter(x => x.key !== 'hacer' && x.key !== 'agendar' && x.key !== 'delegar' && x.key !== 'desglosar')) {
  app.get(`/${d.key}`, async (req, res) => {
    const db = await loadReqDb(req);
    const items = (db.items || [])
      .filter(i => i.list === d.key && i.status !== 'done')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return renderPage(res, 'destination', {
      title: d.label,
      section: d,
      items,
      needApiKey: Boolean(APP_API_KEY),
      apiKey: '',
    });
  });
}

app.post('/items/:id/delete', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadReqDb(req);
  db.items = (db.items || []).filter(i => i.id !== id);
  await saveReqDb(req, db);
  return res.redirect('back');
});

app.get('/api/tags', async (req, res) => {
  const db = await loadReqDb(req);
  const allTags = new Set();

  (db.items || []).forEach(item => {
    if (Array.isArray(item.tags)) {
      item.tags.forEach(tag => allTags.add(tag));
    }
  });

  return res.json({ tags: Array.from(allTags).sort() });
});

app.get('/search', async (req, res) => {
  const query = sanitizeInput(String(req.query?.q || '').trim().toLowerCase());

  if (!query) {
    return renderPage(res, 'dashboard', {
      title: 'Búsqueda',
      cards: [],
      needApiKey: Boolean(APP_API_KEY),
    });
  }

  const db = await loadReqDb(req);
  const allItems = db.items || [];

  // Buscar en títulos, inputs y comentarios
  const results = allItems.filter(item => {
    const searchText = [
      item.title,
      item.input,
      item.completionComment,
      item.objective,
      item.delegatedTo,
    ].filter(Boolean).join(' ').toLowerCase();

    return searchText.includes(query);
  });

  // Agrupar por lista
  const grouped = {};
  results.forEach(item => {
    const list = item.list || 'collect';
    if (!grouped[list]) grouped[list] = [];
    grouped[list].push(item);
  });

  return renderPage(res, 'search-results', {
    title: `Búsqueda: ${query}`,
    query,
    results,
    grouped,
    resultCount: results.length,
  });
});

app.get('/export', async (req, res) => {
  return renderPage(res, 'export', {
    title: 'Exportar/Importar Datos',
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.get('/export/json', async (req, res) => {
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

app.get('/export/csv', async (req, res) => {
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

app.post('/import', requireApiKey, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const importData = req.body;

    if (!importData || !Array.isArray(importData.items)) {
      return res.status(400).json({ ok: false, error: 'Invalid import data format' });
    }

    const db = await loadReqDb(req);

    // Merge: agregar items nuevos, no sobrescribir existentes
    const existingIds = new Set((db.items || []).map(i => i.id));
    const newItems = importData.items.filter(i => !existingIds.has(i.id));

    db.items = [...(db.items || []), ...newItems];
    await saveReqDb(req, db);

    return res.json({ ok: true, imported: newItems.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
  });
}

export default app;
