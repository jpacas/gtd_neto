import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

function parseSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function cookieHeaderFromSetCookie(setCookies = []) {
  return setCookies.map((c) => c.split(';')[0]).join('; ');
}

async function startServer(port) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    USE_SUPABASE: 'false',
    APP_API_KEY: 'testkey',
    HOST: '127.0.0.1',
    PORT: String(port),
  };
  const proc = spawn('node', ['server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timeout')), 5000);
    proc.stdout.on('data', (buf) => {
      if (String(buf).includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', (buf) => {
      const text = String(buf);
      if (text.includes('Error:')) {
        clearTimeout(timeout);
        reject(new Error(text));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`server exited with code ${code}`));
    });
  });

  return proc;
}

test('healthz and csrf-protected collect/import flows', async (t) => {
  const port = 3477;
  const base = `http://127.0.0.1:${port}`;
  const proc = await startServer(port);
  t.after(() => {
    proc.kill('SIGTERM');
  });

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  const collectGet = await fetch(`${base}/collect`);
  assert.equal(collectGet.status, 200);
  const body = await collectGet.text();
  const csrfMatch = body.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(csrfMatch?.[1]);
  const csrf = csrfMatch[1];
  const cookie = cookieHeaderFromSetCookie(parseSetCookies(collectGet.headers));
  assert.ok(cookie.includes('csrf_token='));

  const addResp = await fetch(`${base}/collect/add`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-api-key': 'testkey',
      cookie,
    },
    body: new URLSearchParams({ _csrf: csrf, input: 'Prueba integración' }),
    redirect: 'manual',
  });
  assert.equal(addResp.status, 302);

  const importResp = await fetch(`${base}/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'testkey',
      'x-csrf-token': csrf,
      cookie,
    },
    body: JSON.stringify({
      items: [{
        id: 'intg1234',
        input: 'Import integración',
        list: 'collect',
        status: 'unprocessed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }],
    }),
  });
  assert.equal(importResp.status, 200);
  const importJson = await importResp.json();
  assert.equal(importJson.ok, true);
});
