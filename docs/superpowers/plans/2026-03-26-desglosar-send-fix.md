# Desglosar Send Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Bad destination" 400 error when sending a subtask to Hacer/Agendar/Delegar, and improve the UX of subtask actions in the Desglosar view.

**Architecture:** Two-file change — backend guard hardening in `src/routes/destinations.js` (1 line), and EJS template improvements in `views/desglosar.ejs` (replace multi-button send form with `<select>` + button, add sent-item link, enlarge action buttons).

**Tech Stack:** Express route handler, EJS template, TailwindCSS utility classes.

---

## Files

| File | Change |
|------|--------|
| `src/routes/destinations.js` | Line 479: change `status(400).send(...)` → `redirect('/desglosar')` |
| `views/desglosar.ejs` | Lines 93–94, 98–107, 110–122: replace send form, add link, enlarge buttons |

---

## Task 1: Backend — degrade gracefully on bad destination

**Files:**
- Modify: `src/routes/destinations.js:479`

- [ ] **Step 1: Open the file and locate line 479**

The current line reads:
```javascript
if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.status(400).send('Bad destination');
```

- [ ] **Step 2: Change `status(400).send(...)` to `redirect('/desglosar')`**

```javascript
if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.redirect('/desglosar');
```

No other changes in this file.

- [ ] **Step 3: Run lint to confirm no syntax errors**

```bash
npm run lint
```
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/destinations.js
git commit -m "fix: redirect on bad destination instead of 400 in desglosar send route"
```

---

## Task 2: Frontend — replace multi-button send form with select+button

**Files:**
- Modify: `views/desglosar.ejs:102–107`

This is the most important change. It eliminates the root cause of the bug: a form with multiple `<button name="destination">` can submit without a destination value (e.g., Enter key press in an adjacent input). Replacing it with a `<select>` that has a `disabled` default option ensures `destination` is always a valid value.

- [ ] **Step 1: Locate the send form block (lines ~102–107)**

Current code:
```html
<form method="POST" action="/desglosar/<%= it.id %>/subtasks/<%= s.id %>/send" class="inline flex gap-1 items-center flex-wrap">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
  <% for (const d of destinations) { %>
    <button type="submit" name="destination" value="<%= d.key %>" class="text-[11px] px-2 py-1 rounded border bg-white hover:bg-slate-50 transition-colors"><%= destIcons[d.key] || '' %> <%= d.label %></button>
  <% } %>
</form>
```

- [ ] **Step 2: Replace with select+button form**

```html
<form method="POST" action="/desglosar/<%= it.id %>/subtasks/<%= s.id %>/send" class="flex gap-1 items-center">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
  <select name="destination" class="text-xs border rounded-lg px-2 py-1.5 bg-white text-slate-700 border-blue-200 cursor-pointer">
    <option value="" disabled selected>Enviar a…</option>
    <% for (const d of destinations) { %>
      <option value="<%= d.key %>"><%= destIcons[d.key] || '' %> <%= d.label %></option>
    <% } %>
  </select>
  <button type="submit" class="text-xs px-2.5 py-1.5 rounded-lg border bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 transition-colors whitespace-nowrap">↗ Enviar</button>
</form>
```

Key differences:
- `class` removes `inline` (was conflicting with `flex`)
- `<select>` with `disabled selected` default → `destination` is never empty on submit
- Single submit button with clear label

- [ ] **Step 3: Run lint**

```bash
npm run lint
```
Expected: exits 0.

- [ ] **Step 4: Start dev server and visually verify in browser**

```bash
npm run dev:all
```

Open `http://localhost:3000/desglosar`. For a project with open subtasks:
- Confirm the "Enviar a…" select appears with options Hacer / Agendar / Delegar.
- Select "✅ Hacer" and click "↗ Enviar" — subtask should change to `sent` state (green background, "Enviado a hacer ✓").
- Confirm the page does NOT show "Bad destination".

- [ ] **Step 5: Commit**

```bash
git add views/desglosar.ejs
git commit -m "fix: replace multi-button send form with select+button in desglosar"
```

---

## Task 3: Frontend — add link to sent item + enlarge action buttons

**Files:**
- Modify: `views/desglosar.ejs:93–94` (sent label)
- Modify: `views/desglosar.ejs:100` (✓ Hecho button)
- Modify: `views/desglosar.ejs:110–114` (✏️ edit button)
- Modify: `views/desglosar.ejs:118–122` (× delete button)

- [ ] **Step 1: Add link to sent item (lines ~93–94)**

Current:
```html
<span class="text-xs text-green-700">Enviado a <%= s.sentTo %> ✓</span>
```

Replace with:
```html
<span class="text-xs text-green-700 flex items-center gap-1.5">
  <%= destIcons[s.sentTo] || '' %> <%= s.sentTo %>
  <a href="/<%= s.sentTo %>" class="text-blue-600 underline hover:text-blue-800 transition-colors">→ ver</a>
</span>
```

- [ ] **Step 2: Enlarge ✓ Hecho button (~line 100)**

Current classes: `text-[11px] px-2 py-1`
Replace with: `text-xs px-2.5 py-1.5`

Full button after change:
```html
<button class="text-xs px-2.5 py-1.5 rounded border bg-white hover:bg-green-50 text-green-700 border-green-300 transition-colors">✓ Hecho</button>
```

- [ ] **Step 3: Enlarge ✏️ edit button (~lines 110–114)**

Current classes: `text-[11px] px-2 py-1`
Replace with: `text-xs px-2.5 py-1.5`

Full button after change:
```html
<button
  type="button"
  onclick="toggleSubtaskEdit('<%= it.id %>', '<%= s.id %>')"
  class="text-xs px-2.5 py-1.5 rounded border bg-white hover:bg-slate-50 transition-colors"
  title="Editar">✏️</button>
```

- [ ] **Step 4: Enlarge × delete button (~lines 118–122)**

Current classes: `text-[11px] px-2 py-1`
Replace with: `text-xs px-2.5 py-1.5`

Full button after change:
```html
<button
  type="button"
  onclick="confirmSubtaskDelete('<%= s.id %>')"
  class="text-xs px-2.5 py-1.5 rounded border bg-white hover:bg-red-50 text-red-600 border-red-200 transition-colors"
  title="Eliminar">×</button>
```

- [ ] **Step 5: Visually verify**

With dev server running, open `/desglosar`:
- A sent subtask should show "✅ hacer → ver" with a blue underlined link.
- Click "→ ver" — should navigate to `/hacer`.
- All action buttons (✓ Hecho, ✏️, ×) should be noticeably larger than before.

- [ ] **Step 6: Run full check**

```bash
npm run check
```
Expected: lint + format + tests all pass, exits 0.

- [ ] **Step 7: Commit**

```bash
git add views/desglosar.ejs
git commit -m "feat: add sent-item link and enlarge action buttons in desglosar"
```

---

## Verification Summary

After all tasks complete:

1. `/desglosar` loads with `<select>` send form — no multi-buttons.
2. Select a destination + click "↗ Enviar" → no "Bad destination" error.
3. Sent subtask shows "✅ hacer → ver" link navigating to `/hacer`.
4. `npm run check` passes cleanly.
