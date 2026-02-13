# Operación GTD_Neto

## Requisitos
- Node.js 22+
- Variables de entorno definidas (`.env`)
- Si `NODE_ENV=production`:
  - `USE_SUPABASE=true` o `APP_API_KEY` no vacío

## Comandos diarios
- Desarrollo: `npm run dev:all`
- Checks: `npm run check`
- Build CSS: `npm run build`
- Producción local: `npm start`

## Monitoreo mínimo
- Healthcheck: `GET /healthz`
- Métricas: `GET /metricsz`
  - `requestsTotal`
  - `requests5xx`
  - `avgDurationMs`

## Runbook de incidente
1. Confirmar salud:
   - `curl -i http://<host>/healthz`
   - `curl -s http://<host>/metricsz`
2. Revisar logs estructurados (`event=http_request`, `event=request_error`).
3. Si hay errores de configuración:
   - Verificar `APP_API_KEY`, `USE_SUPABASE`, `SUPABASE_*`.
4. Si hay degradación:
   - Revisar tasas `5xx` y latencia promedio.
5. Ejecutar rollback al commit estable más reciente.

## Checklist de release
1. `npm ci`
2. `npm run check`
3. `npm run build`
4. Probar rutas críticas:
   - `/collect`
   - `/hacer`
   - `/import` (con CSRF + JSON)
   - `/healthz` y `/metricsz`
5. Verificar cookies de auth/CSRF en entorno objetivo.
6. Verificar CSP en headers (`script-src` con nonce).

## Rollback
1. Identificar último tag/commit estable.
2. Desplegar commit estable.
3. Validar `/healthz` y flujo básico de login/collect.
