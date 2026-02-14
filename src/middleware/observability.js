function generateRandomHex(bytesLen) {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLen));
  return Buffer.from(bytes).toString('hex');
}

function generateRandomBase64(bytesLen) {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLen));
  return Buffer.from(bytes).toString('base64');
}

export function createObservabilityMiddleware({ isProduction }) {
  const metrics = {
    startedAt: new Date().toISOString(),
    requestsTotal: 0,
    requests5xx: 0,
    durationMsTotal: 0,
    byStatus: {},
    byRoute: {},
    storeOps: {},
  };

  function ensureMetricBucket(container, key) {
    if (!container[key]) {
      container[key] = {
        count: 0,
        errors: 0,
        durationMsTotal: 0,
        avgDurationMs: 0,
        maxDurationMs: 0,
      };
    }
    return container[key];
  }

  function recordOperation(opName, { ok = true, durationMs = 0 } = {}) {
    const key = String(opName || 'unknown');
    const bucket = ensureMetricBucket(metrics.storeOps, key);
    bucket.count += 1;
    if (!ok) bucket.errors += 1;
    bucket.durationMsTotal += durationMs;
    bucket.avgDurationMs = Number((bucket.durationMsTotal / bucket.count).toFixed(2));
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
  }

  function logStructured(level, event, extra = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...extra,
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  function cspNonceMiddleware(req, res, next) {
    res.locals.cspNonce = generateRandomBase64(16);
    next();
  }

  function requestIdMiddleware(req, res, next) {
    const requestId = generateRandomHex(8);
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);

    const startedAt = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      metrics.requestsTotal += 1;
      metrics.durationMsTotal += durationMs;
      if (res.statusCode >= 500) metrics.requests5xx += 1;
      metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] || 0) + 1;
      const routeKey = `${req.method} ${req.path || req.url || ''}`;
      const routeBucket = ensureMetricBucket(metrics.byRoute, routeKey);
      routeBucket.count += 1;
      if (res.statusCode >= 500) routeBucket.errors += 1;
      routeBucket.durationMsTotal += durationMs;
      routeBucket.avgDurationMs = Number((routeBucket.durationMsTotal / routeBucket.count).toFixed(2));
      routeBucket.maxDurationMs = Math.max(routeBucket.maxDurationMs, durationMs);

      logStructured('info', 'http_request', {
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
      });
    });
    next();
  }

  function metricsHandler(req, res) {
    const avgDurationMs = metrics.requestsTotal
      ? Number((metrics.durationMsTotal / metrics.requestsTotal).toFixed(2))
      : 0;
    return res.json({
      ok: true,
      metrics: {
        ...metrics,
        avgDurationMs,
      },
    });
  }

  function notFoundHandler(req, res) {
    const payload = { ok: false, error: 'Not Found', requestId: req.requestId };
    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(404).json(payload);
    }
    return res.status(404).type('text').send('Not Found');
  }

  function errorHandler(err, req, res, next) {
    logStructured('error', 'request_error', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: Number(err?.status || 500),
      message: String(err?.message || 'unknown_error'),
      stack: isProduction ? undefined : String(err?.stack || ''),
    });

    if (res.headersSent) return next(err);

    const status = Number(err?.status || 500);
    const isServerError = status >= 500;
    const safeMessage = isServerError && isProduction
      ? 'Internal server error'
      : String(err?.message || 'Request error');

    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(status).json({
        ok: false,
        error: safeMessage,
        requestId: req.requestId,
      });
    }

    return res.status(status).type('text').send(safeMessage);
  }

  return {
    cspNonceMiddleware,
    requestIdMiddleware,
    recordOperation,
    metricsHandler,
    notFoundHandler,
    errorHandler,
  };
}
