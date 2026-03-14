import express from 'express';
import { loadMetaByKind, saveMetaRecord } from '../../lib/meta-store.js';
import { loadItemsForList } from '../../lib/store.js';
import {
  REVIEW_STEPS,
  createReviewSession,
  runStepCheck,
  calculateStreak,
  getLastReviewInfo,
} from '../services/weekly-review-service.js';

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Buffer.from(bytes).toString('hex');
}

export function createWeeklyReviewRoutes({ renderPage, requireApiKey, sanitizeInput, ownerForReq, saveReqItem, loadReqItemsByList, loadReqDb }) {
  const router = express.Router();

  // Landing page
  router.get('/weekly-review', async (req, res) => {
    const owner = ownerForReq(req);
    let allReviews = [];
    try {
      allReviews = await loadMetaByKind('weekly_review', { owner });
    } catch {}

    const { lastReview, daysSinceLast } = getLastReviewInfo(allReviews);
    const streak = calculateStreak(allReviews);

    // Check for in-progress review
    const inProgress = allReviews.find(r => !r.completedAt && !r.abandonedAt);

    return renderPage(res, 'weekly-review/index', {
      title: 'Revisión Semanal',
      lastReview,
      daysSinceLast,
      streak,
      inProgress,
    });
  });

  // Start new review (or resume in-progress)
  router.post('/weekly-review/start', requireApiKey, async (req, res) => {
    const owner = ownerForReq(req);

    let allReviews = [];
    try { allReviews = await loadMetaByKind('weekly_review', { owner }); } catch {}

    // Check for existing in-progress review
    const inProgress = allReviews.find(r => !r.completedAt && !r.abandonedAt);
    if (inProgress) return res.redirect(`/weekly-review/${inProgress.id}/step/1`);

    const id = randomId();
    const session = createReviewSession(id, owner);
    await saveMetaRecord(session, 'weekly_review', { owner });

    return res.redirect(`/weekly-review/${id}/step/1`);
  });

  // View a step
  router.get('/weekly-review/:id/step/:n', async (req, res) => {
    const owner = ownerForReq(req);
    const id = sanitizeInput(String(req.params.id || ''));
    const n = parseInt(req.params.n, 10);

    if (!id || isNaN(n) || n < 1 || n > REVIEW_STEPS.length) {
      return res.redirect('/weekly-review');
    }

    let review;
    try {
      const records = await loadMetaByKind('weekly_review', { owner });
      review = records.find(r => r.id === id);
    } catch {
      return res.redirect('/weekly-review');
    }

    // IDOR check — owner validation
    if (!review || review.owner !== owner) return res.redirect('/weekly-review');
    if (review.completedAt) return res.redirect(`/weekly-review/${id}/complete`);

    const step = REVIEW_STEPS.find(s => s.n === n);
    if (!step) return res.redirect('/weekly-review');

    // Run check function for this step
    let checkResult = { ok: true, count: null, message: null };
    try {
      checkResult = await runStepCheck(n, {
        loadItemsForList,
        owner,
      });
    } catch {}

    const stepStatus = (review.steps || {})[String(n)];

    return renderPage(res, 'weekly-review/step', {
      title: `Revisión Semanal — Paso ${n}`,
      review,
      step,
      stepN: n,
      totalSteps: REVIEW_STEPS.length,
      steps: REVIEW_STEPS,
      checkResult,
      stepStatus,
      reviewId: id,
    });
  });

  // Complete a step
  router.post('/weekly-review/:id/step/:n/complete', requireApiKey, async (req, res) => {
    const owner = ownerForReq(req);
    const id = sanitizeInput(String(req.params.id || ''));
    const n = parseInt(req.params.n, 10);

    if (!id || isNaN(n) || n < 1 || n > REVIEW_STEPS.length) {
      return res.redirect('/weekly-review');
    }

    let review;
    let allReviews;
    try {
      allReviews = await loadMetaByKind('weekly_review', { owner });
      review = allReviews.find(r => r.id === id);
    } catch {
      return res.redirect('/weekly-review');
    }

    // IDOR check
    if (!review || review.owner !== owner) return res.redirect('/weekly-review');
    if (review.completedAt) return res.redirect(`/weekly-review/${id}/complete`);

    // Idempotency: if step already done, just advance
    const existingStep = (review.steps || {})[String(n)];
    if (existingStep?.status === 'done') {
      const nextN = n + 1;
      if (nextN > REVIEW_STEPS.length) return res.redirect(`/weekly-review/${id}/complete`);
      return res.redirect(`/weekly-review/${id}/step/${nextN}`);
    }

    // Handle step 5 capture (brain dump)
    if (n === 5 && req.body?.capture) {
      const captureText = sanitizeInput(String(req.body.capture || '')).trim();
      if (captureText) {
        // Save to collect — import store helpers
        try {
          const { newItem, updateItem } = await import('../../lib/store.js');
          const { isStoreSupabaseMode, saveItem, loadDb, saveDb } = await import('../../lib/store.js');

          const item = updateItem(newItem({ input: captureText }), {
            title: captureText,
            kind: 'action',
            list: 'collect',
            status: 'unprocessed',
          });

          if (isStoreSupabaseMode()) {
            await saveItem(item, { owner });
          } else {
            const db = await loadDb({ owner });
            db.items = [item, ...(db.items || [])];
            await saveDb(db, { owner });
          }
        } catch {}
      }
    }

    const now = new Date().toISOString();
    const updatedReview = {
      ...review,
      currentStep: Math.min(n + 1, REVIEW_STEPS.length + 1),
      steps: {
        ...(review.steps || {}),
        [String(n)]: { status: 'done', completedAt: now },
      },
    };

    // If this was the last step, mark as completed
    if (n === REVIEW_STEPS.length) {
      updatedReview.completedAt = now;
    }

    await saveMetaRecord(updatedReview, 'weekly_review', { owner });

    if (n === REVIEW_STEPS.length) {
      return res.redirect(`/weekly-review/${id}/complete`);
    }

    return res.redirect(`/weekly-review/${id}/step/${n + 1}`);
  });

  // Abandon review
  router.post('/weekly-review/:id/abandon', requireApiKey, async (req, res) => {
    const owner = ownerForReq(req);
    const id = sanitizeInput(String(req.params.id || ''));

    let review;
    try {
      const records = await loadMetaByKind('weekly_review', { owner });
      review = records.find(r => r.id === id);
    } catch {
      return res.redirect('/weekly-review');
    }

    // IDOR check
    if (!review || review.owner !== owner) return res.redirect('/weekly-review');

    const updatedReview = { ...review, abandonedAt: new Date().toISOString() };
    await saveMetaRecord(updatedReview, 'weekly_review', { owner });

    return res.redirect('/weekly-review');
  });

  // Completion page
  router.get('/weekly-review/:id/complete', async (req, res) => {
    const owner = ownerForReq(req);
    const id = sanitizeInput(String(req.params.id || ''));

    let review;
    let allReviews = [];
    try {
      allReviews = await loadMetaByKind('weekly_review', { owner });
      review = allReviews.find(r => r.id === id);
    } catch {
      return res.redirect('/weekly-review');
    }

    // IDOR check
    if (!review || review.owner !== owner) return res.redirect('/weekly-review');

    const streak = calculateStreak(allReviews.filter(r => r.completedAt));

    return renderPage(res, 'weekly-review/complete', {
      title: 'Revisión Completada 🎉',
      review,
      streak,
    });
  });

  return router;
}
