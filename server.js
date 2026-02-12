import 'dotenv/config';
import express from 'express';
import ejs from 'ejs';

import { loadDb, saveDb, newItem, updateItem } from './lib/store.js';

const app = express();

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const APP_API_KEY = process.env.APP_API_KEY || '';

if (!APP_API_KEY) {
  console.warn('[gtd_neto] WARNING: APP_API_KEY is empty. Set it in .env to protect POST endpoints.');
}

app.set('view engine', 'ejs');
app.set('views', new URL('./views', import.meta.url).pathname);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use('/docs', express.static(new URL('./docs', import.meta.url).pathname));

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
  return Promise.resolve(body).then(html =>
    res.render('layout', {
      title,
      flash,
      body: html,
    })
  );
}

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
  const priorityScore = (urgency * importance) + (estimateMin <= 10 ? 2 : 0);

  return {
    ...patch,
    title,
    urgency,
    importance,
    estimateMin,
    priorityScore,
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
  const db = await loadDb();
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

app.get('/collect', async (req, res) => {
  const db = await loadDb();
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
  const input = String(req.body?.input || '').trim();
  if (!input) {
    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(400).json({ ok: false, error: 'empty_input' });
    }
    return res.redirect('/collect');
  }

  const db = await loadDb();

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
  await saveDb(db);

  if (String(req.get('accept') || '').includes('application/json')) {
    return res.json({ ok: true, item, deduped: false });
  }

  return res.redirect('/collect');
});

app.post('/collect/:id/update', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const input = String(req.body?.input || '').trim();
  if (!input) return res.redirect('/collect');

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'collect');
  if (idx === -1) return res.redirect('/collect');

  db.items[idx] = updateItem(db.items[idx], {
    input,
    title: input,
  });
  await saveDb(db);
  return res.redirect('/collect');
});

app.post('/collect/:id/send', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const destination = String(req.body?.destination || '');
  if (!destinationByKey(destination)) return res.status(400).send('Bad destination');

  const db = await loadDb();
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
  await saveDb(db);
  return res.redirect('/collect');
});

app.get('/hacer', async (req, res) => {
  const db = await loadDb();
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
  const id = String(req.params.id);
  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
  if (idx === -1) return res.redirect('/hacer');

  const current = db.items[idx];
  const patch = {
    title: String(req.body?.title || current.title || current.input || '').trim(),
    urgency: Number(req.body?.urgency || current.urgency || 3),
    importance: Number(req.body?.importance || current.importance || 3),
    estimateMin: Number(req.body?.estimateMin || current.estimateMin || 10),
  };

  db.items[idx] = updateItem(current, withHacerMeta(current, patch));
  await saveDb(db);
  return res.redirect('/hacer');
});

app.post('/hacer/:id/complete', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const comment = String(req.body?.comment || '').trim();

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
  if (idx === -1) return res.redirect('/hacer');

  db.items[idx] = updateItem(db.items[idx], {
    status: 'done',
    completedAt: new Date().toISOString(),
    completionComment: comment || null,
  });
  await saveDb(db);
  return res.redirect('/hacer');
});

app.get('/terminado', async (req, res) => {
  const db = await loadDb();
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
  const id = String(req.params.id);
  const comment = String(req.body?.completionComment || '').trim();

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.status === 'done');
  if (idx === -1) return res.redirect('/terminado');

  db.items[idx] = updateItem(db.items[idx], { completionComment: comment || null });
  await saveDb(db);
  return res.redirect('/terminado');
});

app.get('/agendar', async (req, res) => {
  const db = await loadDb();
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
  const id = String(req.params.id);
  const scheduledFor = String(req.body?.scheduledFor || '').trim();

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
  if (idx === -1) return res.redirect('/agendar');

  const current = db.items[idx];
  const title = String(req.body?.title || current.title || current.input || '').trim();
  db.items[idx] = updateItem(current, {
    title,
    scheduledFor: scheduledFor || null,
  });

  await saveDb(db);
  return res.redirect('/agendar');
});

app.post('/agendar/:id/complete', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
  if (idx === -1) return res.redirect('/agendar');

  db.items[idx] = updateItem(db.items[idx], {
    status: 'done',
    completedAt: new Date().toISOString(),
    completionComment: null,
  });
  await saveDb(db);
  return res.redirect('/agendar');
});

app.get('/delegar', async (req, res) => {
  const db = await loadDb();
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
  const id = String(req.params.id);
  const delegatedFor = String(req.body?.delegatedFor || '').trim();
  const delegatedTo = String(req.body?.delegatedTo || '').trim();

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'delegar');
  if (idx === -1) return res.redirect('/delegar?error=not_found');

  if (!delegatedFor || !delegatedTo) {
    return res.redirect('/delegar?error=missing_fields');
  }

  const current = db.items[idx];
  const title = String(req.body?.title || current.title || current.input || '').trim();
  db.items[idx] = updateItem(current, {
    title,
    delegatedFor,
    delegatedTo,
  });

  await saveDb(db);
  return res.redirect('/delegar');
});

app.get('/desglosar', async (req, res) => {
  const db = await loadDb();
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
  const id = String(req.params.id);
  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
  if (idx === -1) return res.redirect('/desglosar');

  const current = withDesglosarMeta(db.items[idx]);
  const title = String(req.body?.title || current.title || current.input || '').trim();
  const objective = String(req.body?.objective || current.objective || '').trim();

  db.items[idx] = updateItem(current, withDesglosarMeta(current, {
    title,
    objective,
  }));
  await saveDb(db);
  return res.redirect('/desglosar');
});

app.post('/desglosar/:id/subtasks/add', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const text = String(req.body?.subtask || '').trim();
  if (!text) return res.redirect('/desglosar');

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
  if (idx === -1) return res.redirect('/desglosar');

  const current = withDesglosarMeta(db.items[idx]);
  const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
  db.items[idx] = updateItem(current, withDesglosarMeta(current, { subtasks }));
  await saveDb(db);
  return res.redirect('/desglosar');
});

app.post('/desglosar/:id/subtasks/:subId/send', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const subId = String(req.params.subId);
  const destination = String(req.body?.destination || '');
  if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.status(400).send('Bad destination');

  const db = await loadDb();
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

  await saveDb(db);
  return res.redirect('/desglosar');
});

for (const d of DESTINATIONS.filter(x => x.key !== 'hacer' && x.key !== 'agendar' && x.key !== 'delegar' && x.key !== 'desglosar')) {
  app.get(`/${d.key}`, async (req, res) => {
    const db = await loadDb();
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
  const db = await loadDb();
  db.items = (db.items || []).filter(i => i.id !== id);
  await saveDb(db);
  return res.redirect('back');
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
  });
}

export default app;
