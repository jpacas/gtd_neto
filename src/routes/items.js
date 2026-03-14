import express from 'express';
import { isStoreSupabaseMode, newItem, updateItem, findRecentDuplicate } from '../../lib/store.js';
import { DESTINATIONS, withHacerMeta, withDesglosarMeta, randomId } from '../services/gtd-service.js';
import { RequestValidationError, sanitizeIdParam, sanitizeTextField, sanitizeEnumField, sanitizeIntegerField } from '../validators/request-validators.js';

export function createItemRoutes({ loadReqDb, loadReqItemsByList, loadReqItemsByStatus, loadReqItemById, saveReqDb, saveReqItem, deleteReqItem, requireApiKey, sanitizeInput, userFacingPersistError, renderPage, APP_API_KEY, ownerForReq }) {
  const router = express.Router();

  // Collect: add item
  router.post('/collect/add', requireApiKey, async (req, res) => {
    const wantsJson = String(req.get('accept') || '').includes('application/json');
    try {
      const input = sanitizeTextField(req.body?.input, sanitizeInput, { field: 'input', required: true, maxLen: 500 });
      if (!input) {
        if (wantsJson) return res.status(400).json({ ok: false, error: 'empty_input' });
        return res.redirect('/collect');
      }

      const recentDuplicate = await findRecentDuplicate(input, { owner: ownerForReq(req) });
      if (recentDuplicate) {
        if (wantsJson) return res.json({ ok: true, item: recentDuplicate, deduped: true });
        return res.redirect('/collect');
      }

      const item = updateItem(newItem({ input }), {
        title: input,
        kind: 'action',
        list: 'collect',
        status: 'unprocessed',
      });

      if (isStoreSupabaseMode()) {
        await saveReqItem(req, item);
      } else {
        const db = await loadReqDb(req);
        db.items = [item, ...(db.items || [])];
        await saveReqDb(req, db);
      }

      if (wantsJson) return res.json({ ok: true, item, deduped: false });
      return res.redirect('/collect');
    } catch (err) {
      if (err instanceof RequestValidationError) {
        if (wantsJson) return res.status(err.status || 400).json({ ok: false, error: err.message });
        return res.redirect('/collect');
      }
      const userMessage = userFacingPersistError(err);
      if (wantsJson) return res.status(500).json({ ok: false, error: 'persist_failed', message: userMessage });
      return res.redirect(`/collect?error=${encodeURIComponent(userMessage)}`);
    }
  });

  // Collect: update item
  router.post('/collect/:id/update', requireApiKey, async (req, res) => {
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

  // Collect: send item to destination
  router.post('/collect/:id/send', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const validLists = DESTINATIONS.map(d => d.key);
      const destination = sanitizeEnumField(req.body?.destination, validLists, sanitizeInput, 'destination');
      if (!DESTINATIONS.find(d => d.key === destination)) return res.status(400).send('Bad destination');

      const context = sanitizeInput(String(req.body?.context || '')) || null;
      const area = sanitizeInput(String(req.body?.area || '')) || null;

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current) return res.redirect('/collect');

        const basePatch = { list: destination, status: 'processed' };
        if (context) basePatch.context = context;
        if (area) basePatch.area = area;

        let patch = basePatch;
        if (destination === 'hacer') patch = withHacerMeta(current, basePatch);
        if (destination === 'desglosar') patch = withDesglosarMeta(current, basePatch);

        const next = updateItem(current, patch);
        await saveReqItem(req, next);
        return res.redirect('/collect');
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id);
      if (idx === -1) return res.redirect('/collect');

      const basePatch = { list: destination, status: 'processed' };
      if (context) basePatch.context = context;
      if (area) basePatch.area = area;

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

  // Items: update tags
  router.post('/items/:id/tags', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      const tagsInput = sanitizeTextField(req.body?.tags, sanitizeInput, { field: 'tags', required: false, maxLen: 400 });

      const tags = tagsInput
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(t => t.length > 0 && t.length <= 20)
        .slice(0, 5);

      if (isStoreSupabaseMode()) {
        const current = await loadReqItemById(req, id);
        if (!current) return res.status(404).json({ ok: false, error: 'Item not found' });
        await saveReqItem(req, updateItem(current, { tags }));
        return res.json({ ok: true, tags });
      }

      const db = await loadReqDb(req);
      const idx = (db.items || []).findIndex(i => i.id === id);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Item not found' });
      db.items[idx] = updateItem(db.items[idx], { tags });
      await saveReqItem(req, db.items[idx], db);
      return res.json({ ok: true, tags });
    } catch (err) {
      if (err instanceof RequestValidationError) return res.status(err.status || 400).json({ ok: false, error: err.message });
      throw err;
    }
  });

  // Items: delete
  router.post('/items/:id/delete', requireApiKey, async (req, res) => {
    const wantsJson = String(req.get('accept') || '').includes('application/json');
    try {
      const id = sanitizeIdParam(req.params.id, sanitizeInput);
      if (isStoreSupabaseMode()) {
        await deleteReqItem(req, id);
      } else {
        const db = await loadReqDb(req);
        db.items = (db.items || []).filter(i => i.id !== id);
        await deleteReqItem(req, id, db);
      }
      if (wantsJson) return res.json({ ok: true });
      return res.redirect('back');
    } catch (err) {
      if (err instanceof RequestValidationError) {
        if (wantsJson) return res.status(400).json({ ok: false, error: err.message });
        return res.redirect('back');
      }
      throw err;
    }
  });

  return router;
}
