import express from 'express';
import { isStoreSupabaseMode, newItem, updateItem } from '../../lib/store.js';
import { DESTINATIONS, SYSTEM_CONTEXTS, SYSTEM_AREAS, evaluateActionability, withHacerMeta, withDesglosarMeta, randomId } from '../services/gtd-service.js';
import { RequestValidationError, sanitizeIdParam, sanitizeTextField, sanitizeIntegerField } from '../validators/request-validators.js';
import { loadMetaByKind } from '../../lib/meta-store.js';
import { getLastReviewInfo, calculateStreak } from '../services/weekly-review-service.js';

export function createDestinationRoutes({ loadReqDb, loadReqItemsByList, loadReqItemsByStatus, loadReqItemById, saveReqDb, saveReqItem, deleteReqItem, requireApiKey, sanitizeInput, renderPage, APP_API_KEY, exportLimiter, validateAndNormalizeImportPayload, ImportValidationError }) {
  const router = express.Router();

  // Dashboard
  router.get('/', async (req, res) => {
    const db = await loadReqDb(req);
    const items = db.items || [];

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

    // Weekly review info for dashboard CTA
    try {
      const owner = req.auth?.user?.id || process.env.SUPABASE_OWNER || 'default';
      const allReviews = await loadMetaByKind('weekly_review', { owner });
      const { daysSinceLast } = getLastReviewInfo(allReviews);
      const streak = calculateStreak(allReviews.filter(r => r.completedAt));
      res.locals.daysSinceReview = daysSinceLast;
      res.locals.weeklyStreak = streak;
    } catch {}

    return renderPage(res, 'dashboard', {
      title: 'Dashboard',
      cards,
      needApiKey: Boolean(APP_API_KEY),
    });
  });

  // Collect view
  router.get('/collect', async (req, res) => {
    try {
      const items = (await loadReqItemsByList(req, 'collect', { excludeDone: true }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

      // Provide contexts and areas for the send form
      try {
        const owner = req.auth?.user?.id || process.env.SUPABASE_OWNER || 'default';
        const [customContexts, customAreas] = await Promise.all([
          loadMetaByKind('context', { owner }),
          loadMetaByKind('area', { owner }),
        ]);
        res.locals.allContexts = [
          ...SYSTEM_CONTEXTS,
          ...customContexts.map(c => c.value).filter(Boolean),
        ];
        res.locals.allAreas = [
          ...SYSTEM_AREAS,
          ...customAreas.map(a => a.value).filter(Boolean),
        ];
      } catch {
        res.locals.allContexts = SYSTEM_CONTEXTS;
        res.locals.allAreas = SYSTEM_AREAS;
      }

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

  // Collect: no direct add (redirect handled in items.js)
  router.post('/hacer/add', requireApiKey, async (req, res) => {
    return res.status(405).type('text').send('Method not allowed: agrega en Collect y luego envía a Hacer.');
  });

  // Hacer view
  router.get('/hacer', async (req, res) => {
    const context = String(req.query?.context || '');
    const area = String(req.query?.area || '');

    let items = (await loadReqItemsByList(req, 'hacer', { excludeDone: true }))
      .map(i => ({ ...i, ...withHacerMeta(i) }));

    if (context) items = items.filter(i => i.context === context);
    if (area) items = items.filter(i => i.area === area);

    items = items.sort((a, b) => {
      const byUrgency = Number(b.urgency || 0) - Number(a.urgency || 0);
      if (byUrgency !== 0) return byUrgency;
      return Number(b.importance || 0) - Number(a.importance || 0);
    });

    const totalEstimateMin = items.reduce((sum, i) => sum + Number(i.estimateMin || 0), 0);

    return renderPage(res, 'hacer', {
      title: 'Hacer',
      items,
      totalEstimateMin,
      needApiKey: Boolean(APP_API_KEY),
      activeContext: context,
      activeArea: area,
    });
  });

  // Hacer: update item
  router.post('/hacer/:id/update', requireApiKey, async (req, res) => {
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

  // Hacer: complete item
  router.post('/hacer/:id/complete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const comment = sanitizeInput(String(req.body?.comment || ''));

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'hacer') return res.redirect('/hacer');
        const next = updateItem(current, { status: 'done', completedAt: new Date().toISOString(), completionComment: comment || null });
        await saveReqItem(req, next);
        return res.redirect('/hacer');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'hacer');
      if (idx === -1) return res.redirect('/hacer');
      db.items[idx] = updateItem(db.items[idx], { status: 'done', completedAt: new Date().toISOString(), completionComment: comment || null });
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/hacer');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/hacer');
      throw err;
    }
  });

  // Terminado view
  router.get('/terminado', async (req, res) => {
    const items = (await loadReqItemsByStatus(req, 'done'))
      .sort((a, b) => String(b.completedAt || b.updatedAt || '').localeCompare(String(a.completedAt || a.updatedAt || '')));

    return renderPage(res, 'terminado', {
      title: 'Terminado',
      items,
      needApiKey: Boolean(APP_API_KEY),
    });
  });

  // Terminado: update comment
  router.post('/terminado/:id/comment', requireApiKey, async (req, res) => {
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

  // Agendar view
  router.get('/agendar', async (req, res) => {
    const context = String(req.query?.context || '');
    const area = String(req.query?.area || '');

    let items = (await loadReqItemsByList(req, 'agendar', { excludeDone: true }))
      .map(i => ({ ...i, ...evaluateActionability(i.title || i.input || '') }));

    if (context) items = items.filter(i => i.context === context);
    if (area) items = items.filter(i => i.area === area);

    items = items.sort((a, b) => {
      const ad = String(a.scheduledFor || '9999-12-31');
      const bd = String(b.scheduledFor || '9999-12-31');
      return ad.localeCompare(bd);
    });

    const totalEstimateMin = items.reduce((sum, i) => sum + Number(i.estimateMin || 0), 0);

    return renderPage(res, 'agendar', {
      title: 'Agendar',
      items,
      totalEstimateMin,
      needApiKey: Boolean(APP_API_KEY),
      activeContext: context,
      activeArea: area,
    });
  });

  // Agendar: update item
  router.post('/agendar/:id/update', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const scheduledFor = sanitizeInput(String(req.body?.scheduledFor || ''));

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'agendar') return res.redirect('/agendar');
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        await saveReqItem(req, updateItem(current, { title, scheduledFor: scheduledFor || null }));
        return res.redirect('/agendar');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
      if (idx === -1) return res.redirect('/agendar');
      const current = db.items[idx];
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      db.items[idx] = updateItem(current, { title, scheduledFor: scheduledFor || null });
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/agendar');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/agendar');
      throw err;
    }
  });

  // Agendar: complete item
  router.post('/agendar/:id/complete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'agendar') return res.redirect('/agendar');
        await saveReqItem(req, updateItem(current, { status: 'done', completedAt: new Date().toISOString(), completionComment: null }));
        return res.redirect('/agendar');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'agendar');
      if (idx === -1) return res.redirect('/agendar');
      db.items[idx] = updateItem(db.items[idx], { status: 'done', completedAt: new Date().toISOString(), completionComment: null });
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/agendar');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/agendar');
      throw err;
    }
  });

  // Delegar view
  router.get('/delegar', async (req, res) => {
    const groupBy = String(req.query?.groupBy || 'date') === 'owner' ? 'owner' : 'date';
    const ownerFilter = String(req.query?.owner || '').trim().toLowerCase();
    const error = String(req.query?.error || '');
    const context = String(req.query?.context || '');
    const area = String(req.query?.area || '');

    let baseItems = (await loadReqItemsByList(req, 'delegar', { excludeDone: true }))
      .map(i => ({
        ...i,
        delegatedTo: String(i.delegatedTo || '').trim(),
        delegatedFor: String(i.delegatedFor || '').trim(),
      }))
      .filter(i => !ownerFilter || i.delegatedTo.toLowerCase().includes(ownerFilter));

    if (context) baseItems = baseItems.filter(i => i.context === context);
    if (area) baseItems = baseItems.filter(i => i.area === area);

    const items = baseItems.sort((a, b) => {
      const ad = String(a.delegatedFor || '9999-12-31');
      const bd = String(b.delegatedFor || '9999-12-31');
      return ad.localeCompare(bd);
    });

    const groupsMap = new Map();
    for (const item of items) {
      const key = groupBy === 'owner' ? (item.delegatedTo || 'Sin responsable') : (item.delegatedFor || 'Sin fecha');
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(item);
    }
    const groups = Array.from(groupsMap.entries()).map(([label, rows]) => ({ label, rows }));

    const totalEstimateMin = items.reduce((sum, i) => sum + Number(i.estimateMin || 0), 0);

    return renderPage(res, 'delegar', {
      title: 'Delegar',
      items,
      groups,
      groupBy,
      ownerFilter: String(req.query?.owner || ''),
      error,
      totalEstimateMin,
      needApiKey: Boolean(APP_API_KEY),
      activeContext: context,
      activeArea: area,
    });
  });

  // Delegar: update item
  router.post('/delegar/:id/update', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const delegatedFor = sanitizeTextField(req.body?.delegatedFor, sanitizeInput, { field: 'delegatedFor', required: true, maxLen: 40 });
      const delegatedTo = sanitizeTextField(req.body?.delegatedTo, sanitizeInput, { field: 'delegatedTo', required: true, maxLen: 120 });

      if (!delegatedFor || !delegatedTo) return res.redirect('/delegar?error=missing_fields');

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'delegar') return res.redirect('/delegar?error=not_found');
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        await saveReqItem(req, updateItem(current, { title, delegatedFor, delegatedTo }));
        return res.redirect('/delegar');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'delegar');
      if (idx === -1) return res.redirect('/delegar?error=not_found');
      const current = db.items[idx];
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      db.items[idx] = updateItem(current, { title, delegatedFor, delegatedTo });
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/delegar');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/delegar?error=missing_fields');
      throw err;
    }
  });

  // Desglosar view
  router.get('/desglosar', async (req, res) => {
    const context = String(req.query?.context || '');
    const area = String(req.query?.area || '');

    let items = (await loadReqItemsByList(req, 'desglosar', { excludeDone: true }))
      .map(i => ({ ...i, ...withDesglosarMeta(i) }));

    if (context) items = items.filter(i => i.context === context);
    if (area) items = items.filter(i => i.area === area);

    items = items.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

    return renderPage(res, 'desglosar', {
      title: 'Desglosar',
      items,
      destinations: DESTINATIONS.filter(d => ['hacer', 'agendar', 'delegar'].includes(d.key)),
      needApiKey: Boolean(APP_API_KEY),
      activeContext: context,
      activeArea: area,
    });
  });

  // Desglosar: update item
  router.post('/desglosar/:id/update', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);

      if (isStoreSupabaseMode()) {
        const currentRaw = await loadReqItemById(req, id);
        if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
        const current = withDesglosarMeta(currentRaw);
        const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
        const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));
        const next = updateItem(currentRaw, withDesglosarMeta(currentRaw, { title, objective }));
        await saveReqItem(req, next);
        return res.redirect('/desglosar');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'desglosar');
      if (idx === -1) return res.redirect('/desglosar');
      const current = withDesglosarMeta(db.items[idx]);
      const title = sanitizeInput(String(req.body?.title || current.title || current.input || ''));
      const objective = sanitizeInput(String(req.body?.objective || current.objective || ''));
      db.items[idx] = updateItem(current, withDesglosarMeta(current, { title, objective }));
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/desglosar');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/desglosar');
      throw err;
    }
  });

  // Desglosar: add subtask
  router.post('/desglosar/:id/subtasks/add', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const text = sanitizeInput(String(req.body?.subtask || ''));
      if (!text) return res.redirect('/desglosar');

      if (isStoreSupabaseMode()) {
        const currentRaw = await loadReqItemById(req, id);
        if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
        const current = withDesglosarMeta(currentRaw);
        const subtasks = [...(current.subtasks || []), { id: randomId(), text, status: 'open' }];
        const next = updateItem(currentRaw, withDesglosarMeta(currentRaw, { subtasks }));
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

  // Desglosar: send subtask to destination
  router.post('/desglosar/:id/subtasks/:subId/send', requireApiKey, async (req, res) => {
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
        let newTask = updateItem(base, { title: text, kind: 'action', list: destination, status: 'processed', sourceProjectId: id, sourceSubtaskId: subId });
        if (destination === 'hacer') newTask = updateItem(newTask, withHacerMeta(newTask));
        subtasks[subIdx] = { ...subtask, status: 'sent', sentTo: destination, sentItemId: newTask.id };
        const updatedProject = updateItem(currentRaw, withDesglosarMeta(currentRaw, { subtasks }));
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
      let newTask = updateItem(base, { title: text, kind: 'action', list: destination, status: 'processed', sourceProjectId: id, sourceSubtaskId: subId });
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

  // Desglosar: complete subtask
  router.post('/desglosar/:id/subtasks/:subId/complete', requireApiKey, async (req, res) => {
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
        const next = updateItem(currentRaw, withDesglosarMeta(currentRaw, { subtasks }));
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

  // Desglosar: update subtask text
  router.post('/desglosar/:id/subtasks/:subId/update', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const subId = sanitizeIdParam(req.params.subId, sanitizeInput);
      const text = sanitizeInput(String(req.body?.subtaskText || '')).trim();
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
        const next = updateItem(currentRaw, withDesglosarMeta(currentRaw, { subtasks }));
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

  // Desglosar: delete subtask
  router.post('/desglosar/:id/subtasks/:subId/delete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const subId = sanitizeIdParam(req.params.subId, sanitizeInput);

      if (isStoreSupabaseMode()) {
        const currentRaw = await loadReqItemById(req, id);
        if (!currentRaw || currentRaw.list !== 'desglosar') return res.redirect('/desglosar');
        const current = withDesglosarMeta(currentRaw);
        const subtasks = (current.subtasks || []).filter(s => String(s.id) !== subId);
        const next = updateItem(currentRaw, withDesglosarMeta(currentRaw, { subtasks }));
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

  // Desglosar: complete project
  router.post('/desglosar/:id/complete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'desglosar') return res.redirect('/desglosar');
        await saveReqItem(req, updateItem(current, { status: 'done', completedAt: new Date().toISOString() }));
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

  // Someday/Maybe view
  router.get('/someday', async (req, res) => {
    const items = (await loadReqItemsByList(req, 'someday', { excludeDone: true }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return renderPage(res, 'destination', {
      title: 'Algún Día / Tal Vez',
      section: { key: 'someday', label: 'Algún Día / Tal Vez', hint: 'Ideas y proyectos para el futuro' },
      items,
      isSomeday: true,
      needApiKey: Boolean(APP_API_KEY),
    });
  });

  // Someday: rescue item back to Collect
  router.post('/someday/:id/rescue', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current || current.list !== 'someday') return res.redirect('/someday');
        await saveReqItem(req, updateItem(current, { list: 'collect', status: 'unprocessed' }));
        return res.redirect('/collect');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id && i.list === 'someday');
      if (idx === -1) return res.redirect('/someday');
      db.items[idx] = updateItem(db.items[idx], { list: 'collect', status: 'unprocessed' });
      await saveReqItem(req, db.items[idx], db);
      return res.redirect('/collect');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/someday');
      throw err;
    }
  });

  // Stats
  router.get('/stats', async (req, res) => {
    const db = await loadReqDb(req);
    const items = db.items || [];

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

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
        if (Object.prototype.hasOwnProperty.call(acc.byList, list)) acc.byList[list] += 1;
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

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(todayStart);
      date.setDate(date.getDate() - i);
      const dayKey = date.toISOString().slice(0, 10);
      last7Days.push({ date: date.toLocaleDateString('es', { weekday: 'short', day: 'numeric' }), count: result.completedPerDay.get(dayKey) || 0 });
    }

    return renderPage(res, 'stats', {
      title: 'Estadísticas',
      stats,
      byList: result.byList,
      last7Days,
      avgPerDay: (stats.completedWeek / 7).toFixed(1),
      maxCount: Math.max(...last7Days.map(d => d.count), 1),
    });
  });

  // Export page
  router.get('/export', async (req, res) => {
    return renderPage(res, 'export', { title: 'Exportar/Importar Datos', needApiKey: Boolean(APP_API_KEY) });
  });

  // Export JSON
  router.get('/export/json', exportLimiter, async (req, res) => {
    const db = await loadReqDb(req);
    const exportData = { version: 1, exportedAt: new Date().toISOString(), items: db.items || [] };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="gtd_neto_export_${Date.now()}.json"`);
    return res.send(JSON.stringify(exportData, null, 2));
  });

  // Export CSV
  router.get('/export/csv', exportLimiter, async (req, res) => {
    const db = await loadReqDb(req);
    const items = db.items || [];
    const headers = ['id', 'title', 'list', 'status', 'urgency', 'importance', 'scheduledFor', 'delegatedTo', 'createdAt', 'completedAt'];
    let csv = headers.join(',') + '\n';
    items.forEach(item => {
      const row = headers.map(h => `"${String(item[h] || '').replace(/"/g, '""')}"`);
      csv += row.join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gtd_neto_export_${Date.now()}.csv"`);
    return res.send(csv);
  });

  // Import JSON
  router.post('/import', requireApiKey, async (req, res) => {
    try {
      if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
      const normalizedItems = validateAndNormalizeImportPayload(req.body, sanitizeInput);
      const db = await loadReqDb(req);
      const existingIds = new Set((db.items || []).map(i => i.id));
      const newItems = normalizedItems.filter(i => !existingIds.has(i.id));
      db.items = [...(db.items || []), ...newItems];
      await saveReqDb(req, db);
      return res.json({ ok: true, imported: newItems.length });
    } catch (err) {
      if (err instanceof RequestValidationError) return res.status(err.status || 400).json({ ok: false, error: err.message });
      if (err instanceof ImportValidationError) return res.status(err.status || 400).json({ ok: false, error: err.message, details: err.details });
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // Generic destinations (no-hacer)
  for (const d of DESTINATIONS.filter(x => !['hacer', 'agendar', 'delegar', 'desglosar', 'someday'].includes(x.key))) {
    router.get(`/${d.key}`, async (req, res) => {
      const items = (await loadReqItemsByList(req, d.key, { excludeDone: true }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

      return renderPage(res, 'destination', {
        title: d.label,
        section: d,
        items,
        isSomeday: false,
        needApiKey: Boolean(APP_API_KEY),
      });
    });
  }

  return router;
}
