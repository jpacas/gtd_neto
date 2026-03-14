import express from 'express';
import { loadMetaByKind, saveMetaRecord, deleteMetaRecord } from '../../lib/meta-store.js';
import { SYSTEM_CONTEXTS, SYSTEM_AREAS } from '../services/gtd-service.js';
import { sanitizeTextField } from '../validators/request-validators.js';
import { sanitizeContextField, sanitizeAreaField, RequestValidationError } from '../validators/request-validators.js';

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Buffer.from(bytes).toString('hex');
}

export function createSettingsRoutes({ renderPage, requireApiKey, sanitizeInput, ownerForReq }) {
  const router = express.Router();

  // Settings index
  router.get('/settings', async (req, res) => {
    return renderPage(res, 'settings/index', { title: 'Configuración' });
  });

  // Contexts settings
  router.get('/settings/contexts', async (req, res) => {
    let customContexts = [];
    try {
      customContexts = await loadMetaByKind('context', { owner: ownerForReq(req) });
    } catch {}

    return renderPage(res, 'settings/contexts', {
      title: 'Contextos',
      systemContexts: SYSTEM_CONTEXTS,
      customContexts,
      flash: req.query?.success ? { success: 'Cambios guardados.' } : null,
    });
  });

  // Add custom context
  router.post('/settings/contexts/add', requireApiKey, async (req, res) => {
    try {
      const raw = sanitizeContextField(req.body?.context, sanitizeInput);
      if (!raw) return res.redirect('/settings/contexts');

      // Check if already exists in system contexts
      if (SYSTEM_CONTEXTS.includes(raw)) return res.redirect('/settings/contexts?error=exists');

      const existing = await loadMetaByKind('context', { owner: ownerForReq(req) });
      if (existing.some(c => c.value === raw)) return res.redirect('/settings/contexts?error=exists');

      await saveMetaRecord({ id: randomId(), value: raw, createdAt: new Date().toISOString() }, 'context', { owner: ownerForReq(req) });
      return res.redirect('/settings/contexts?success=1');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/settings/contexts?error=' + encodeURIComponent(err.message));
      throw err;
    }
  });

  // Delete custom context
  router.post('/settings/contexts/:id/delete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeInput(String(req.params.id || ''));
      await deleteMetaRecord(id, { owner: ownerForReq(req) });
      return res.redirect('/settings/contexts?success=1');
    } catch {
      return res.redirect('/settings/contexts');
    }
  });

  // Areas settings
  router.get('/settings/areas', async (req, res) => {
    let customAreas = [];
    try {
      customAreas = await loadMetaByKind('area', { owner: ownerForReq(req) });
    } catch {}

    return renderPage(res, 'settings/areas', {
      title: 'Áreas de Vida',
      systemAreas: SYSTEM_AREAS,
      customAreas,
      flash: req.query?.success ? { success: 'Cambios guardados.' } : null,
    });
  });

  // Add custom area
  router.post('/settings/areas/add', requireApiKey, async (req, res) => {
    try {
      const raw = sanitizeAreaField(req.body?.area, sanitizeInput);
      if (!raw) return res.redirect('/settings/areas');

      if (SYSTEM_AREAS.includes(raw)) return res.redirect('/settings/areas?error=exists');

      const existing = await loadMetaByKind('area', { owner: ownerForReq(req) });
      if (existing.some(a => a.value === raw)) return res.redirect('/settings/areas?error=exists');

      await saveMetaRecord({ id: randomId(), value: raw, createdAt: new Date().toISOString() }, 'area', { owner: ownerForReq(req) });
      return res.redirect('/settings/areas?success=1');
    } catch (err) {
      if (err instanceof RequestValidationError) return res.redirect('/settings/areas?error=' + encodeURIComponent(err.message));
      throw err;
    }
  });

  // Delete custom area
  router.post('/settings/areas/:id/delete', requireApiKey, async (req, res) => {
    try {
      const id = sanitizeInput(String(req.params.id || ''));
      await deleteMetaRecord(id, { owner: ownerForReq(req) });
      return res.redirect('/settings/areas?success=1');
    } catch {
      return res.redirect('/settings/areas');
    }
  });

  return router;
}
