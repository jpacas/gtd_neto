# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GTD Neto is a Spanish-language GTD (Getting Things Done) task management web app. Built with Node.js/Express, EJS templates, TailwindCSS, and Supabase (PostgreSQL) or local JSON for persistence. UI language is Spanish; code/comments are in English.

## Commands

```bash
# Development
npm run dev:all        # Start server with auto-reload + watch CSS (primary dev command)
npm run dev            # Server only (nodemon)
npm run watch:css      # CSS only (Tailwind watch)

# Quality (run before committing)
npm run check          # lint + format:check + test (full CI suite)
npm run lint           # Syntax check all JS/MJS files
npm run format:check   # Check formatting
npm run test           # Run all tests

# Run a single test file
node --test test/gtd-service.test.js

# Production build
npm run build          # Compile and minify CSS
npm start              # Start production server
```

CI runs `npm run check` then `npm run build` on push to master.

## Architecture

### Persistence Layer (`lib/store.js`)

Dual persistence via a `USE_SUPABASE` env flag:
- **Local:** reads/writes a single JSON file at `DB_PATH`
- **Supabase:** single `gtd_items` table where the entire item object lives in a `payload JSONB` column (see `supabase/schema.sql`)

The server uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). All data is filtered by an `owner` field (Supabase user ID or `'default'`).

### Application (`server.js`)

A single 1500-line Express file containing all routes, middleware, and helpers. Key patterns:
- `loadReqDb()` / `loadReqItemsByList()` / `saveReqItem()` / `deleteReqItem()` — wrapper functions that load/save data and record timing metrics
- `renderPage(res, view, locals)` — renders EJS with CSP nonce and CSRF token injected
- `refreshTokenIfNeeded()` middleware — auto-refreshes expired Supabase auth tokens from cookies

### GTD Domain (`src/services/gtd-service.js`)

Five destinations: `hacer`, `agendar`, `delegar`, `desglosar`, `no-hacer`.

- `evaluateActionability(text)` — scores action clarity 0–100 (checks for infinitive verb, word count, vagueness)
- `withHacerMeta(item, patch)` — enriches "Hacer" items; caps `estimateMin` at 10, computes `priorityScore = urgency × importance`
- `randomId()` — generates a 16-char hex ID

### Request Validation (`src/validators/`)

All user input goes through `sanitizeIdParam`, `sanitizeTextField`, `sanitizeEnumField`, `sanitizeIntegerField` before use. No raw HTML is ever stored — `sanitize-html` strips all tags.

### Observability (`src/middleware/observability.js`)

Structured JSON logs with request IDs. Metrics (request counts, latency, 5xx rate per route/operation) exposed at `/metricsz`. Health check at `/healthz`.

### Frontend

EJS templates in `views/` with no JS build step. Client JS is in `public/js/` (vanilla, no framework). CSS is compiled from `src/styles.css` via Tailwind. PWA support via `public/sw.js`.

### Vercel Deployment

`api/index.js` is the serverless entry point that imports `server.js`. Routing is defined in `vercel.json`. Requires `USE_SUPABASE=true` in production (no file persistence on Vercel).

## Environment Variables

See `.env.example`. Key variables:
- `USE_SUPABASE` — set to `true` to use Supabase instead of local JSON
- `APP_URL` — required in production for SSRF-safe password reset links
- `APP_API_KEY` — required for non-Supabase production deployments
- `SUPABASE_OWNER` — owner value to scope data (defaults to `'default'`)

## Testing

Tests use Node.js native `node:test` (no external framework). Test files live in `test/`. Run a single file with `node --test test/<file>.test.js`.
