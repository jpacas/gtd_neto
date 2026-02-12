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
  { key: 'hacer', label: 'Hacer', hint: 'Acciones para ejecutar' },
  { key: 'agendar', label: 'Agendar', hint: 'Acciones con fecha/agenda' },
  { key: 'delegar', label: 'Delegar', hint: 'Pendientes de terceros' },
  { key: 'desglosar', label: 'Desglosar', hint: 'Items para dividir en pasos' },
  { key: 'no-hacer', label: 'No hacer', hint: 'Descartar o archivar' },
];

function destinationByKey(key) {
  return DESTINATIONS.find(d => d.key === key) || null;
}

app.get('/', async (req, res) => {
  const db = await loadDb();
  const items = db.items || [];

  const collectCount = items.filter(i => i.list === 'collect' && i.status !== 'done').length;
  const cards = [
    { label: 'Collect', count: collectCount, href: '/collect', hint: 'Captura rápida' },
    ...DESTINATIONS.map(d => ({
      label: d.label,
      count: items.filter(i => i.list === d.key && i.status !== 'done').length,
      href: `/${d.key}`,
      hint: d.hint,
    })),
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
  const item = updateItem(newItem({ input }), {
    title: input,
    kind: 'action',
    list: 'collect',
    status: 'unprocessed',
  });
  db.items = [item, ...(db.items || [])];
  await saveDb(db);

  if (String(req.get('accept') || '').includes('application/json')) {
    return res.json({ ok: true, item });
  }

  return res.redirect('/collect');
});

app.post('/collect/:id/send', requireApiKey, async (req, res) => {
  const id = String(req.params.id);
  const destination = String(req.body?.destination || '');
  if (!destinationByKey(destination)) return res.status(400).send('Bad destination');

  const db = await loadDb();
  const idx = (db.items || []).findIndex(i => i.id === id);
  if (idx === -1) return res.redirect('/collect');

  db.items[idx] = updateItem(db.items[idx], {
    list: destination,
    status: 'processed',
  });
  await saveDb(db);
  return res.redirect('/collect');
});

for (const d of DESTINATIONS) {
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

app.listen(PORT, HOST, () => {
  console.log(`[gtd_neto] listening on http://${HOST}:${PORT}`);
});
