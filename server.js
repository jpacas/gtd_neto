import 'dotenv/config';
import express from 'express';
import ejs from 'ejs';

import { loadDb, saveDb, newItem, updateItem } from './lib/store.js';
import { runOpenClaw, buildGtdExtractPrompt, buildBreakdownPrompt, safeParseJsonFromText } from './lib/openclaw.js';

const app = express();

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const APP_API_KEY = process.env.APP_API_KEY || '';

// OpenClaw
const OPENCLAW_AGENT_SESSION = process.env.OPENCLAW_AGENT_SESSION || 'gtd_neto';
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || '';
const OPENCLAW_TIMEOUT_SECONDS = Number(process.env.OPENCLAW_TIMEOUT_SECONDS || 180);
const OPENCLAW_THINKING = process.env.OPENCLAW_THINKING || 'low';

if (!APP_API_KEY) {
  console.warn('[gtd_neto] WARNING: APP_API_KEY is empty. Set it in .env to protect POST endpoints.');
}

app.set('view engine', 'ejs');
app.set('views', new URL('./views', import.meta.url).pathname);

app.use(express.urlencoded({ extended: false, limit: '64kb' }));

function extractApiKey(req) {
  return req.get('x-api-key') || req.body?.apiKey || req.query?.apiKey || '';
}

function requireApiKey(req, res, next) {
  if (!APP_API_KEY) return next();
  const key = extractApiKey(req);
  if (key && key === APP_API_KEY) return next();
  return res.status(401).send('Unauthorized');
}

function renderPage(res, view, data) {
  const viewsPath = app.get('views');
  const title = data?.title || 'GTD_Neto';
  const flash = data?.flash || null;
  const body = ejs.renderFile(`${viewsPath}/${view}.ejs`, data);

  // ejs.renderFile returns a promise if no callback
  return Promise.resolve(body).then(html =>
    res.render('layout', {
      title,
      flash,
      body: html,
    })
  );
}

function listOptions() {
  return ['inbox', 'next', 'projects', 'waiting', 'someday', 'calendar', 'reference'];
}

function sortByCreatedDesc(a, b) {
  return String(b.createdAt).localeCompare(String(a.createdAt));
}

function applyListFilters(items, query) {
  const q = String(query?.q || '').trim().toLowerCase();
  const ctx = String(query?.ctx || '').trim().toLowerCase();

  let out = items;
  if (q) {
    out = out.filter(i => {
      const hay = [i.title, i.input, i.notes, i.nextAction, i.context].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (ctx) {
    out = out.filter(i => String(i.context || '').toLowerCase().includes(ctx));
  }
  return { out, q, ctx };
}

app.get('/', async (req, res) => {
  const db = await loadDb();
  const items = db.items || [];
  const counts = {
    inbox: items.filter(i => i.list === 'inbox' && i.status !== 'done').length,
    next: items.filter(i => i.list === 'next' && i.status !== 'done').length,
    projects: items.filter(i => i.list === 'projects' && i.status !== 'done').length,
    waiting: items.filter(i => i.list === 'waiting' && i.status !== 'done').length,
    someday: items.filter(i => i.list === 'someday' && i.status !== 'done').length,
    calendar: items.filter(i => i.list === 'calendar' && i.status !== 'done').length,
    reference: items.filter(i => i.list === 'reference' && i.status !== 'done').length,
  };

  const cards = [
    { label: 'Collect', count: counts.inbox, href: '/collect' },
    { label: 'Schedule', count: counts.calendar, href: '/schedule' },
    { label: 'Do', count: counts.next, href: '/do' },
    { label: 'Waiting', count: counts.waiting, href: '/waiting' },
    { label: 'Someday', count: counts.someday, href: '/someday' },
    { label: 'Projects', count: counts.projects, href: '/projects' },
  ];

  return renderPage(res, 'dashboard', {
    title: 'Dashboard',
    cards,
    needApiKey: Boolean(APP_API_KEY),
  });
});

app.post('/inbox/add', requireApiKey, async (req, res) => {
  const input = String(req.body?.input || '').trim();
  const destination = String(req.body?.destination || 'inbox').trim();
  const aiBreakdown = String(req.body?.aiBreakdown || '') === 'on';

  if (!input) return res.redirect('/');
  if (!listOptions().includes(destination)) return res.status(400).send('Bad destination');

  const db = await loadDb();

  if (aiBreakdown) {
    try {
      const prompt = buildBreakdownPrompt({ input, destination });
      const { text } = await runOpenClaw({
        prompt,
        sessionId: OPENCLAW_AGENT_SESSION,
        agentId: OPENCLAW_AGENT_ID,
        timeoutSeconds: OPENCLAW_TIMEOUT_SECONDS,
        thinking: OPENCLAW_THINKING,
      });

      const parsed = safeParseJsonFromText(text);
      const steps = Array.isArray(parsed?.steps) ? parsed.steps.filter(Boolean).slice(0, 8) : [];
      const preferredList = listOptions().includes(String(parsed?.recommendedList || ''))
        ? String(parsed.recommendedList)
        : destination;

      const created = [];

      // Si parece proyecto, guardamos también el padre
      if (String(parsed?.kind || '') === 'project') {
        const parent = updateItem(newItem({ input }), {
          title: parsed?.title || input,
          kind: 'project',
          list: preferredList === 'inbox' ? 'projects' : preferredList,
          context: parsed?.context ?? null,
          status: 'processed',
          notes: 'Proyecto desglosado por IA en micro-acciones (<10 min).',
        });
        created.push(parent);
      }

      const targetListForSteps = destination === 'projects' ? 'next' : (preferredList === 'inbox' ? 'next' : preferredList);
      const finalSteps = steps.length ? steps : [parsed?.title || input];

      for (const step of finalSteps) {
        const it = updateItem(newItem({ input: String(step) }), {
          title: String(step),
          kind: 'action',
          list: targetListForSteps,
          context: parsed?.context ?? null,
          nextAction: null,
          notes: `Origen: ${input}`,
          status: 'processed',
        });
        created.push(it);
      }

      db.items = [...created, ...(db.items || [])];
      await saveDb(db);
      return res.redirect(targetListForSteps === 'inbox' ? '/inbox' : `/${targetListForSteps}`);
    } catch (e) {
      // fallback silencioso a captura normal
    }
  }

  // Captura normal (sin IA)
  let item = newItem({ input });
  if (destination !== 'inbox') {
    item = updateItem(item, {
      title: input,
      kind: destination === 'projects' ? 'project' : 'action',
      list: destination,
      status: 'processed',
    });
  }

  db.items = [item, ...(db.items || [])];
  await saveDb(db);
  return res.redirect(destination === 'inbox' ? '/inbox' : `/${destination}`);
});

app.get(['/inbox', '/collect'], async (req, res) => {
  const db = await loadDb();
  const base = (db.items || []).filter(i => i.list === 'inbox' && i.status !== 'done').sort(sortByCreatedDesc);
  const { out: items, q, ctx } = applyListFilters(base, req.query);

  return renderPage(res, 'list', {
    title: 'Collect',
    heading: 'Collect (Inbox)',
    sectionGuide: 'Captura todo aquí. No decidas demasiado en este paso; luego procesa y organiza.',
    items,
    lists: listOptions(),
    showCapture: true,
    needApiKey: Boolean(APP_API_KEY),
    apiKey: '',
    q,
    ctx,
    basePath: '/collect',
  });
});

app.post('/inbox/:id/process', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) return res.redirect('/inbox');

  const it = db.items[idx];

  try {
    const gtdPrompt = buildGtdExtractPrompt({ input: it.input });
    const { text } = await runOpenClaw({
      prompt: gtdPrompt,
      sessionId: OPENCLAW_AGENT_SESSION,
      agentId: OPENCLAW_AGENT_ID,
      timeoutSeconds: OPENCLAW_TIMEOUT_SECONDS,
      thinking: OPENCLAW_THINKING,
    });

    const obj = safeParseJsonFromText(text);

    const patched = updateItem(it, {
      title: obj.title || it.title,
      kind: obj.kind || it.kind,
      list: obj.list || it.list,
      context: obj.context ?? it.context,
      nextAction: obj.nextAction ?? it.nextAction,
      notes: obj.notes ?? it.notes,
      status: 'processed',
    });

    db.items[idx] = patched;
    await saveDb(db);

    return res.redirect(`/${patched.list === 'inbox' ? 'inbox' : patched.list}`);
  } catch (e) {
    return renderPage(res, 'list', {
      title: 'Inbox',
      heading: 'Inbox',
      items: (db.items || []).filter(i => i.list === 'inbox' && i.status !== 'done').sort(sortByCreatedDesc),
      lists: listOptions(),
      showCapture: true,
      needApiKey: Boolean(APP_API_KEY),
      apiKey: '',
      flash: { error: `No pude procesar con OpenClaw: ${e?.message || e}` },
    });
  }
});

function makeListRoute(listName, heading, guide, aliases = []) {
  app.get([`/${listName}`, ...aliases], async (req, res) => {
    const db = await loadDb();
    const base = (db.items || []).filter(i => i.list === listName && i.status !== 'done').sort(sortByCreatedDesc);
    const { out: items, q, ctx } = applyListFilters(base, req.query);
    return renderPage(res, 'list', {
      title: heading,
      heading,
      sectionGuide: guide,
      items,
      lists: listOptions(),
      showCapture: true,
      needApiKey: Boolean(APP_API_KEY),
      apiKey: '',
      q,
      ctx,
      basePath: aliases[0] || `/${listName}`,
    });
  });
}

app.get('/today', async (req, res) => {
  const db = await loadDb();
  const base = (db.items || [])
    .filter(i => i.status !== 'done' && (i.list === 'next' || i.list === 'calendar'))
    .sort(sortByCreatedDesc);
  const { out: items, q, ctx } = applyListFilters(base, req.query);

  return renderPage(res, 'list', {
    title: 'Hoy',
    heading: 'Hoy (Next + Calendar)',
    items,
    lists: listOptions(),
    showCapture: false,
    needApiKey: Boolean(APP_API_KEY),
    apiKey: '',
    q,
    ctx,
    basePath: '/today',
  });
});

makeListRoute('next', 'Do (Next Actions)', 'Solo acciones concretas y físicas. Filtra por contexto para elegir qué hacer ahora.', ['/do']);
makeListRoute('projects', 'Projects', 'Resultados que requieren más de una acción. Cada proyecto debería tener una próxima acción.');
makeListRoute('waiting', 'Waiting For', 'Seguimientos de terceros. Revisa esta lista para hacer ping y destrabar pendientes.');
makeListRoute('someday', 'Someday / Maybe', 'Ideas sin compromiso actual. Revísalas semanalmente para activar o descartar.');
makeListRoute('calendar', 'Schedule (Calendar)', 'Aquí solo van compromisos con fecha/hora real (hard landscape).', ['/schedule']);
makeListRoute('reference', 'Reference', 'Material de consulta, no acciones.');

app.post('/items/:id/move', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const list = String(req.body?.list || '').trim();
  if (!listOptions().includes(list)) return res.status(400).send('Bad list');

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) return res.redirect('back');

  const it = db.items[idx];
  db.items[idx] = updateItem(it, { list });
  await saveDb(db);
  return res.redirect(`/${list}`);
});

app.post('/items/:id/done', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) return res.redirect('back');

  db.items[idx] = updateItem(db.items[idx], { status: 'done' });
  await saveDb(db);
  return res.redirect('back');
});

app.post('/items/:id/delete', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadDb();
  db.items = (db.items || []).filter(i => i.id !== id);
  await saveDb(db);
  return res.redirect('back');
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.listen(PORT, HOST, () => {
  console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
});
