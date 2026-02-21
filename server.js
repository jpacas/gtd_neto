import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';

// Config
import {
    PORT,
    HOST,
    APP_API_KEY,
    USE_SUPABASE,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    IS_PRODUCTION,
    JSON_BODY_LIMIT,
    IMPORT_JSON_BODY_LIMIT,
    APP_URL,
    supabaseAuth,
    authCookieOptions,
    clearAuthCookieOptions,
    clearCsrfCookieOptions,
} from './src/config.js';

// Middleware
import { createObservabilityMiddleware } from './src/middleware/observability.js';
import {
    sanitizeInput,
    csrfProtection,
    attachCsrfToken,
    requireApiKey,
    generalLimiter,
    authLimiter,
    exportLimiter,
} from './src/middleware/security.js';
import {
    refreshTokenIfNeeded,
    attachAuth,
    requireAuth,
} from './src/middleware/auth.js';

// Helpers
import {
    ownerForReq,
    userFacingPersistError,
    loadReqDb,
    loadReqItemsByList,
    loadReqItemsByStatus,
    loadReqItemById,
    saveReqDb,
    saveReqItem,
    deleteReqItem,
    renderPage as renderPageHelper,
} from './src/helpers/data-access.js';

// Store
import {
    isStoreSupabaseMode,
    newItem,
    updateItem,
    findRecentDuplicate,
} from './lib/store.js';

// Services
import {
    DESTINATIONS,
    destinationByKey,
    evaluateActionability,
    withHacerMeta,
    randomId,
    withDesglosarMeta,
} from './src/services/gtd-service.js';

// Validators
import { ImportValidationError, validateAndNormalizeImportPayload } from './src/validators/import-payload.js';
import {
    RequestValidationError,
    sanitizeEnumField,
    sanitizeIdParam,
    sanitizeIntegerField,
    sanitizeTextField,
} from './src/validators/request-validators.js';

// Routes
import { createAuthRoutes } from './src/routes/auth.js';

const app = express();

// Observability
const {
    cspNonceMiddleware,
    requestIdMiddleware,
    recordOperation,
    metricsHandler,
    notFoundHandler,
    errorHandler,
} = createObservabilityMiddleware({ isProduction: IS_PRODUCTION });

// Warnings
if (!APP_API_KEY) {
    console.warn('[gtd_neto] WARNING: APP_API_KEY is empty. Set it in .env to protect POST endpoints.');
}

if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
    console.warn('[gtd_neto] WARNING: USE_SUPABASE=true but SUPABASE_URL/SUPABASE_ANON_KEY are missing. Login will fail.');
}

// Wrapper for data-access helpers that injects recordOperation
const loadReqDbWrapped = (req) => loadReqDb(req, recordOperation);
const loadReqItemsByListWrapped = (req, list, options = {}) => loadReqItemsByList(req, list, options, recordOperation);
const loadReqItemsByStatusWrapped = (req, status, options = {}) => loadReqItemsByStatus(req, status, options, recordOperation);
const loadReqItemByIdWrapped = (req, id) => loadReqItemById(req, id, recordOperation);
const saveReqDbWrapped = (req, db) => saveReqDb(req, db, recordOperation);
const saveReqItemWrapped = (req, item, dbWhenLocal = null) => saveReqItem(req, item, dbWhenLocal, recordOperation);
const deleteReqItemWrapped = (req, id, dbWhenLocal = null) => deleteReqItem(req, id, dbWhenLocal, recordOperation);

// Wrapper for renderPage that injects viewsPath
const viewsPath = new URL('./views', import.meta.url).pathname;
const renderPage = (res, view, data) => renderPageHelper(res, view, data, viewsPath);

// Security and performance middleware
if (IS_PRODUCTION) {
    app.set('trust proxy', 1);
}
app.disable('x-powered-by');
app.use(compression());
app.use(cspNonceMiddleware);
app.use(requestIdMiddleware);

// Helmet for security headers
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

// View engine and parsers
app.set('view engine', 'ejs');
app.set('views', viewsPath);
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

// Favicon handling
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

// Service Worker (PWA)
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(new URL('./public/sw.js', import.meta.url).pathname);
});

// Auth middleware
app.use(refreshTokenIfNeeded);
app.use(attachAuth);
app.use(attachCsrfToken);
app.use((req, res, next) => {
    res.locals.authUser = req.auth?.user || null;
    next();
});

// CSRF protection for POST requests
app.use(csrfProtection);

// Health check
app.get('/healthz', (req, res) => res.send('ok'));

// Metrics endpoint
app.get('/metrics', requireApiKey, metricsHandler);

// Auth routes
const authRoutes = createAuthRoutes({
    USE_SUPABASE,
    supabaseAuth,
    APP_URL,
    sanitizeInput,
    authCookieOptions,
    clearAuthCookieOptions,
    clearCsrfCookieOptions,
    authLimiter,
    renderPage,
});
app.use(authRoutes);

// Auth guard for all other routes
app.use((req, res, next) => {
    const publicPaths = ['/login', '/signup', '/auth/login', '/auth/signup', '/auth/forgot', '/auth/logout', '/healthz', '/favicon.ico', '/favicon.png'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/public') || req.path.startsWith('/docs') || req.path === '/sw.js' || req.path === '/metrics') {
        return next();
    }
    return requireAuth(req, res, next);
});

// ============================================================================
// APPLICATION ROUTES
// ============================================================================
// TODO: Extract these into separate route modules

// Dashboard
app.get('/', async (req, res) => {
    const db = await loadReqDbWrapped(req);
    const items = db.items || [];

    const counts = {
        collect: items.filter(i => i.list === 'collect' && i.status !== 'done').length,
        hacer: items.filter(i => i.list === 'hacer' && i.status !== 'done').length,
        agendar: items.filter(i => i.list === 'agendar' && i.status !== 'done').length,
        delegar: items.filter(i => i.list === 'delegar' && i.status !== 'done').length,
        desglosar: items.filter(i => i.list === 'desglosar' && i.status !== 'done').length,
        'no-hacer': items.filter(i => i.list === 'no-hacer' && i.status !== 'done').length,
        done: items.filter(i => i.status === 'done').length,
    };

    const cards = [
        { label: 'Collect', count: counts.collect, href: '/collect', hint: 'Bandeja de entrada' },
        ...DESTINATIONS.map(d => ({
            label: d.label,
            count: counts[d.key] || 0,
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

// Stats
app.get('/stats', async (req, res) => {
    const db = await loadReqDbWrapped(req);
    const items = db.items || [];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const result = items.reduce((acc, item) => {
        if (item.status === 'done') {
            acc.completedCount += 1;
            const completedAt = new Date(item.completedAt || item.updatedAt || 0);
            if (completedAt >= todayStart) acc.completedToday += 1;
            if (completedAt >= weekStart) acc.completedWeek += 1;
            if (completedAt >= monthStart) acc.completedMonth += 1;

            const dayKey = completedAt.toISOString().split('T')[0];
            acc.completedPerDay.set(dayKey, (acc.completedPerDay.get(dayKey) || 0) + 1);
        } else {
            acc.activeCount += 1;
        }

        const list = String(item.list || 'collect');
        acc.byList[list] = (acc.byList[list] || 0) + 1;
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

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStart);
        d.setDate(d.getDate() - i);
        const dayKey = d.toISOString().split('T')[0];
        last7Days.push({ date: dayKey, count: result.completedPerDay.get(dayKey) || 0 });
    }

    const avgPerDay = result.completedWeek / 7;

    return renderPage(res, 'stats', {
        title: 'Estadísticas',
        stats,
        byList: result.byList,
        last7Days,
        avgPerDay: avgPerDay.toFixed(1),
        maxCount: Math.max(...last7Days.map(d => d.count), 1),
    });
});

// Collect routes
app.get('/collect', async (req, res) => {
    try {
        const items = (await loadReqItemsByListWrapped(req, 'collect', { excludeDone: true }))
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

        if (isStoreSupabaseMode()) {
            await saveReqItemWrapped(req, item);
        } else {
            const db = await loadReqDbWrapped(req);
            db.items = [item, ...(db.items || [])];
            await saveReqDbWrapped(req, db);
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'collect') return res.redirect('/collect');
            const next = updateItem(current, { input, title: input });
            await saveReqItemWrapped(req, next);
            return res.redirect('/collect');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'collect');
        if (idx === -1) return res.redirect('/collect');

        db.items[idx] = updateItem(db.items[idx], { input, title: input });
        await saveReqItemWrapped(req, db.items[idx], db);
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current) return res.redirect('/collect');

            const basePatch = {
                list: destination,
                status: 'processed',
            };
            let patch = basePatch;
            if (destination === 'hacer') patch = withHacerMeta(current, basePatch);
            if (destination === 'desglosar') patch = withDesglosarMeta(current, basePatch);

            const next = updateItem(current, patch);
            await saveReqItemWrapped(req, next);
            return res.redirect('/collect');
        }

        const db = await loadReqDbWrapped(req);
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
        await saveReqItemWrapped(req, db.items[idx], db);
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

        const tags = tagsInput
            .split(',')
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length > 0 && t.length <= 20)
            .slice(0, 5);

        if (isStoreSupabaseMode()) {
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current) return res.status(404).json({ ok: false, error: 'Item not found' });
            await saveReqItemWrapped(req, updateItem(current, { tags }));
            return res.json({ ok: true, tags });
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id);
        if (idx === -1) {
            return res.status(404).json({ ok: false, error: 'Item not found' });
        }

        db.items[idx] = updateItem(db.items[idx], { tags });
        await saveReqItemWrapped(req, db.items[idx], db);

        return res.json({ ok: true, tags });
    } catch (err) {
        if (err instanceof RequestValidationError) {
            return res.status(err.status || 400).json({ ok: false, error: err.message });
        }
        throw err;
    }
});

// ============================================================================
// HACER ROUTES
// ============================================================================
// TODO: Extract to src/routes/hacer.js

app.get('/hacer', async (req, res) => {
    const items = (await loadReqItemsByListWrapped(req, 'hacer', { excludeDone: true }))
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'hacer') return res.redirect('/hacer');
            const patch = {
                title: sanitizeTextField(req.body?.title || current.title || current.input || '', sanitizeInput, { field: 'title', required: true, maxLen: 280 }),
                urgency: sanitizeIntegerField(req.body?.urgency ?? current.urgency ?? 3, { field: 'urgency', min: 1, max: 5, fallback: 3 }),
                importance: sanitizeIntegerField(req.body?.importance ?? current.importance ?? 3, { field: 'importance', min: 1, max: 5, fallback: 3 }),
                estimateMin: sanitizeIntegerField(req.body?.estimateMin ?? current.estimateMin ?? 10, { field: 'estimateMin', min: 1, max: 600, fallback: 10 }),
            };
            const next = updateItem(current, withHacerMeta(current, patch));
            await saveReqItemWrapped(req, next);
            return res.redirect('/hacer');
        }

        const db = await loadReqDbWrapped(req);
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
        await saveReqItemWrapped(req, db.items[idx], db);
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'hacer') return res.redirect('/hacer');
            const next = updateItem(current, {
                status: 'done',
                completedAt: new Date().toISOString(),
                completionComment: comment || null,
            });
            await saveReqItemWrapped(req, next);
            return res.redirect('/hacer');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
        if (idx === -1) return res.redirect('/hacer');

        db.items[idx] = updateItem(db.items[idx], {
            status: 'done',
            completedAt: new Date().toISOString(),
            completionComment: comment || null,
        });
        await saveReqItemWrapped(req, db.items[idx], db);
        return res.redirect('/hacer');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('/hacer');
        throw err;
    }
});

// ============================================================================
// TERMINADO ROUTES
// ============================================================================
// TODO: Extract to src/routes/terminado.js

app.get('/terminado', async (req, res) => {
    const items = (await loadReqItemsByStatusWrapped(req, 'done'))
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.status !== 'done') return res.redirect('/terminado');
            await saveReqItemWrapped(req, updateItem(current, { completionComment: comment || null }));
            return res.redirect('/terminado');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.status === 'done');
        if (idx === -1) return res.redirect('/terminado');

        db.items[idx] = updateItem(db.items[idx], { completionComment: comment || null });
        await saveReqItemWrapped(req, db.items[idx], db);
        return res.redirect('/terminado');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('/terminado');
        throw err;
    }
});

// ============================================================================
// AGENDAR ROUTES
// ============================================================================
// TODO: Extract to src/routes/agendar.js

app.get('/agendar', async (req, res) => {
    const items = (await loadReqItemsByListWrapped(req, 'agendar', { excludeDone: true }))
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'agendar') return res.redirect('/agendar');
            const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
            const next = updateItem(current, {
                title,
                scheduledFor: scheduledFor || null,
            });
            await saveReqItemWrapped(req, next);
            return res.redirect('/agendar');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
        if (idx === -1) return res.redirect('/agendar');

        const current = db.items[idx];
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        db.items[idx] = updateItem(current, {
            title,
            scheduledFor: scheduledFor || null,
        });

        await saveReqItemWrapped(req, db.items[idx], db);
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'agendar') return res.redirect('/agendar');
            const next = updateItem(current, {
                status: 'done',
                completedAt: new Date().toISOString(),
                completionComment: null,
            });
            await saveReqItemWrapped(req, next);
            return res.redirect('/agendar');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
        if (idx === -1) return res.redirect('/agendar');

        db.items[idx] = updateItem(db.items[idx], {
            status: 'done',
            completedAt: new Date().toISOString(),
            completionComment: null,
        });
        await saveReqItemWrapped(req, db.items[idx], db);
        return res.redirect('/agendar');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('/agendar');
        throw err;
    }
});

// ============================================================================
// DELEGAR ROUTES
// ============================================================================
// TODO: Extract to src/routes/delegar.js

app.get('/delegar', async (req, res) => {
    const groupBy = String(req.query?.groupBy || 'date') === 'owner' ? 'owner' : 'date';
    const ownerFilter = String(req.query?.owner || '').trim().toLowerCase();
    const error = String(req.query?.error || '');

    const baseItems = (await loadReqItemsByListWrapped(req, 'delegar', { excludeDone: true }))
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
            const current = await loadReqItemByIdWrapped(req, id);
            if (!current || current.list !== 'delegar') return res.redirect('/delegar?error=not_found');
            const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
            await saveReqItemWrapped(req, updateItem(current, {
                title,
                delegatedFor,
                delegatedTo,
            }));
            return res.redirect('/delegar');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'delegar');
        if (idx === -1) return res.redirect('/delegar?error=not_found');

        const current = db.items[idx];
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        db.items[idx] = updateItem(current, {
            title,
            delegatedFor,
            delegatedTo,
        });

        await saveReqItemWrapped(req, db.items[idx], db);
        return res.redirect('/delegar');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('/delegar?error=missing_fields');
        throw err;
    }
});

// ============================================================================
// DESGLOSAR ROUTES
// ============================================================================
// TODO: Extract to src/routes/desglosar.js

app.get('/desglosar', async (req, res) => {
    const items = (await loadReqItemsByListWrapped(req, 'desglosar', { excludeDone: true }))
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
            const currentRaw = await loadReqItemByIdWrapped(req, id);
            if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
            const current = withDesglosarMeta(currentRaw);
            const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
            const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));
            const next = updateItem(current, withDesglosarMeta(current, { title, objective }));
            await saveReqItemWrapped(req, next);
            return res.redirect('/desglosar');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
        if (idx === -1) return res.redirect('/desglosar');

        const current = withDesglosarMeta(db.items[idx]);
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));

        db.items[idx] = updateItem(current, withDesglosarMeta(current, {
            title,
            objective,
        }));
        await saveReqItemWrapped(req, db.items[idx], db);
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
            const currentRaw = await loadReqItemByIdWrapped(req, id);
            if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
            const current = withDesglosarMeta(currentRaw);
            const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
            const next = updateItem(current, withDesglosarMeta(current, { subtasks }));
            await saveReqItemWrapped(req, next);
            return res.redirect('/desglosar');
        }

        const db = await loadReqDbWrapped(req);
        const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
        if (idx === -1) return res.redirect('/desglosar');

        const current = withDesglosarMeta(db.items[idx]);
        const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
        db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
        await saveReqItemWrapped(req, db.items[idx], db);
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
            const currentRaw = await loadReqItemByIdWrapped(req, id);
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
            await saveReqItemWrapped(req, updatedProject);
            await saveReqItemWrapped(req, newTask);
            return res.redirect('/desglosar');
        }

        const db = await loadReqDbWrapped(req);
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
        await saveReqDbWrapped(req, db);
        return res.redirect('/desglosar');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('/desglosar');
        throw err;
    }
});

// ============================================================================
// GENERIC DESTINATION ROUTES
// ============================================================================

for (const d of DESTINATIONS.filter(x => x.key !== 'hacer' && x.key !== 'agendar' && x.key !== 'delegar' && x.key !== 'desglosar')) {
    app.get(`/${d.key}`, async (req, res) => {
        const items = (await loadReqItemsByListWrapped(req, d.key, { excludeDone: true }))
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

        return renderPage(res, 'destination', {
            title: d.label,
            section: d,
            items,
            needApiKey: Boolean(APP_API_KEY),
        });
    });
}

// ============================================================================
// DELETE ROUTE
// ============================================================================

app.post('/items/:id/delete', requireApiKey, async (req, res) => {
    try {
        const id = sanitizeIdParam(req.params.id, sanitizeInput);
        if (isStoreSupabaseMode()) {
            await deleteReqItemWrapped(req, id);
        } else {
            const db = await loadReqDbWrapped(req);
            db.items = (db.items || []).filter(i => i.id !== id);
            await deleteReqItemWrapped(req, id, db);
        }
        return res.redirect('back');
    } catch (err) {
        if (err instanceof RequestValidationError) return res.redirect('back');
        throw err;
    }
});

// ============================================================================
// EXPORT/IMPORT ROUTES
// ============================================================================
// TODO: Extract to src/routes/general.js

app.get('/export', async (req, res) => {
    return renderPage(res, 'export', {
        title: 'Exportar/Importar Datos',
        needApiKey: Boolean(APP_API_KEY),
    });
});

app.get('/export/json', exportLimiter, async (req, res) => {
    const db = await loadReqDbWrapped(req);
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
    const db = await loadReqDbWrapped(req);
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

        const db = await loadReqDbWrapped(req);

        // Merge: agregar items nuevos, no sobrescribir existentes
        const existingIds = new Set((db.items || []).map(i => i.id));
        const newItems = normalizedItems.filter(i => !existingIds.has(i.id));

        db.items = [...(db.items || []), ...newItems];
        await saveReqDbWrapped(req, db);

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

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
if (!process.env.VERCEL) {
    app.listen(PORT, HOST, () => {
        console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
    });
}

export default app;
