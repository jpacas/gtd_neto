import test from 'node:test';
import assert from 'node:assert/strict';

// Set ENFORCE=true before importing so requireFlag enforcement is active
process.env.ENFORCE_FEATURE_FLAGS = 'true';

const { loadFlagsMiddleware, requireFlag } = await import('../src/middleware/feature-flags.js');

// Mock Express res/req/next helpers
function makeRes(flags = {}) {
  const rendered = {};
  return {
    locals: { featureFlags: flags },
    status(code) { rendered.statusCode = code; return this; },
    render(view, locals) { rendered.view = view; rendered.locals = locals; },
    send(msg) { rendered.body = msg; },
    _rendered: rendered,
  };
}

function makeReq(user = null) {
  return { auth: user ? { user } : undefined };
}

function makeNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.wasCalled = () => called;
  return fn;
}

// --- requireFlag (ENFORCE=true) ---

test('requireFlag blocks and renders upgrade view when flag is false', async () => {
  const guard = requireFlag('weekly_review');
  const req = makeReq({ id: 'u1' });
  const res = makeRes({ weekly_review: false });
  const next = makeNext();

  guard(req, res, next);

  assert.equal(next.wasCalled(), false, 'next() should NOT be called when flag is false');
  assert.equal(res._rendered.statusCode, 403);
});

test('requireFlag calls next() when flag is true', () => {
  const guard = requireFlag('weekly_review');
  const req = makeReq({ id: 'u1' });
  const res = makeRes({ weekly_review: true });
  const next = makeNext();

  guard(req, res, next);

  assert.equal(next.wasCalled(), true, 'next() should be called when flag is true');
});

test('requireFlag falls back to DEFAULT_FLAGS when res.locals.featureFlags is missing', () => {
  const guard = requireFlag('weekly_review');
  const req = makeReq({ id: 'u1' });
  // weekly_review is in DEFAULT_FLAGS as true
  const res = makeRes({});
  res.locals.featureFlags = undefined; // no flags set — should use defaults
  const next = makeNext();

  guard(req, res, next);

  // DEFAULT_FLAGS has weekly_review: true → next() should be called
  assert.equal(next.wasCalled(), true);
});

// --- loadFlagsMiddleware ---

test('loadFlagsMiddleware does not throw when loadFeatureFlags rejects — falls back to defaults', async () => {
  // Inject a req with an auth user to trigger the DB-load path,
  // but the DB call will fail (no Supabase configured in test env).
  // The middleware must not throw and must set featureFlags to defaults.
  const req = makeReq({ id: 'u-test-fallback' });
  const res = { locals: {} };
  const next = makeNext();

  // Should not reject
  await assert.doesNotReject(() => loadFlagsMiddleware(req, res, next));

  // next() must have been called
  assert.equal(next.wasCalled(), true);

  // featureFlags must be set to defaults (all true)
  assert.equal(res.locals.featureFlags?.weekly_review, true);
  assert.equal(res.locals.featureFlags?.command_palette, true);
});

test('loadFlagsMiddleware sets default flags for unauthenticated requests', async () => {
  const req = makeReq(null); // no auth user
  const res = { locals: {} };
  const next = makeNext();

  await loadFlagsMiddleware(req, res, next);

  assert.equal(next.wasCalled(), true);
  assert.equal(res.locals.featureFlags?.weekly_review, true);
});
