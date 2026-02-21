import ejs from 'ejs';
import { loadDb, loadItemsForList, loadItemsByStatus, loadItemById, saveDb, saveItem, deleteItemById, isStoreSupabaseMode } from '../../lib/store.js';
import { USE_SUPABASE } from '../config.js';

// Helper to get owner for request
export function ownerForReq(req) {
    return req.auth?.user?.id || process.env.SUPABASE_OWNER || 'default';
}

// Helper to generate user-facing error messages for persist errors
export function userFacingPersistError(err) {
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

// Data access helpers with metrics recording
export async function loadReqDb(req, recordOperation) {
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

export async function loadReqItemsByList(req, list, options, recordOperation) {
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

export async function loadReqItemsByStatus(req, status, options, recordOperation) {
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

export async function loadReqItemById(req, id, recordOperation) {
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

export async function saveReqDb(req, db, recordOperation) {
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

export async function saveReqItem(req, item, dbWhenLocal, recordOperation) {
    const startedAt = Date.now();
    try {
        if (isStoreSupabaseMode()) {
            const result = await saveItem(item, { owner: ownerForReq(req) });
            recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
            return result;
        }
        if (dbWhenLocal) {
            const result = await saveReqDb(req, dbWhenLocal, recordOperation);
            recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
            return result;
        }
        const db = await loadReqDb(req, recordOperation);
        const idx = (db.items || []).findIndex(i => i.id === item.id);
        if (idx === -1) db.items = [item, ...(db.items || [])];
        else db.items[idx] = item;
        const result = await saveReqDb(req, db, recordOperation);
        recordOperation('saveReqItem', { ok: true, durationMs: Date.now() - startedAt });
        return result;
    } catch (err) {
        recordOperation('saveReqItem', { ok: false, durationMs: Date.now() - startedAt });
        throw err;
    }
}

export async function deleteReqItem(req, id, dbWhenLocal, recordOperation) {
    const startedAt = Date.now();
    try {
        if (isStoreSupabaseMode()) {
            const result = await deleteItemById(id, { owner: ownerForReq(req) });
            recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
            return result;
        }
        if (dbWhenLocal) {
            const result = await saveReqDb(req, dbWhenLocal, recordOperation);
            recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
            return result;
        }
        const db = await loadReqDb(req, recordOperation);
        db.items = (db.items || []).filter(i => i.id !== id);
        const result = await saveReqDb(req, db, recordOperation);
        recordOperation('deleteReqItem', { ok: true, durationMs: Date.now() - startedAt });
        return result;
    } catch (err) {
        recordOperation('deleteReqItem', { ok: false, durationMs: Date.now() - startedAt });
        throw err;
    }
}

// Helper to render pages with layout
export function renderPage(res, view, data, viewsPath) {
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
