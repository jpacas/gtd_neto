# Desglosar — Fix envío a destino + mejoras UX

**Fecha:** 2026-03-26
**Estado:** Aprobado

---

## Contexto

La sección Desglosar permite desglosar proyectos grandes en subtareas y enviarlas a Hacer, Agendar o Delegar. El flujo de envío presenta un bug activo: al hacer clic en los botones de destino, el servidor responde `400 Bad destination`. La causa raíz es que el formulario usa múltiples `<button type="submit" name="destination" value="...">` en un mismo `<form>`, y en ciertos escenarios de escritorio (Enter en un input adyacente, comportamiento browser) el campo `destination` llega vacío al servidor. Adicionalmente, la clase CSS `inline flex` en el `<form>` genera un conflicto en Tailwind.

---

## Objetivo

1. Corregir el bug "Bad destination" de forma definitiva.
2. Mejorar el UX de las acciones por subtarea: botones más grandes, jerarquía visual más clara, link al item enviado.

---

## Diseño

### 1. Formulario de envío — reemplazar multi-button por select+button

**Archivo:** `views/desglosar.ejs` (~líneas 102–107)

**Antes:**
```html
<form method="POST" action="/desglosar/<%= it.id %>/subtasks/<%= s.id %>/send"
      class="inline flex gap-1 items-center flex-wrap">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
  <% for (const d of destinations) { %>
    <button type="submit" name="destination" value="<%= d.key %>"
            class="text-[11px] px-2 py-1 ..."><%= d.label %></button>
  <% } %>
</form>
```

**Después:**
```html
<form method="POST" action="/desglosar/<%= it.id %>/subtasks/<%= s.id %>/send"
      class="flex gap-1 items-center">
  <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
  <select name="destination"
          class="text-xs border rounded-lg px-2 py-1.5 bg-white text-slate-700 border-blue-200">
    <option value="" disabled selected>Enviar a…</option>
    <% for (const d of destinations) { %>
      <option value="<%= d.key %>"><%= destIcons[d.key] || '' %> <%= d.label %></option>
    <% } %>
  </select>
  <button type="submit"
          class="text-xs px-2.5 py-1.5 rounded-lg border bg-blue-50 text-blue-600 border-blue-200 hover:bg-blue-100 transition-colors">
    ↗ Enviar
  </button>
</form>
```

**Por qué corrige el bug:** La opción default es `disabled`, por lo que el `<select>` siempre tiene un valor real cuando el usuario hace submit. Elimina la posibilidad de enviar `destination` vacío. También resuelve el conflicto `inline`/`flex`.

### 2. Backend hardening — degradar con gracia

**Archivo:** `src/routes/destinations.js` (línea 479)

**Antes:**
```javascript
if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.status(400).send('Bad destination');
```

**Después:**
```javascript
if (!['hacer', 'agendar', 'delegar'].includes(destination)) return res.redirect('/desglosar');
```

El frontend con `<select>` hace esto redundante, pero como defensa en profundidad, cualquier valor inválido redirige en vez de mostrar una página de error en blanco.

### 3. Link al item enviado

**Archivo:** `views/desglosar.ejs` (~línea 93–94)

**Antes:**
```html
<span class="text-xs text-green-700">Enviado a <%= s.sentTo %> ✓</span>
```

**Después:**
```html
<span class="text-xs text-green-700">
  <%= destIcons[s.sentTo] || '' %> <%= s.sentTo %>
  <a href="/<%= s.sentTo %>"
     class="ml-1 text-blue-600 underline hover:text-blue-800">→ ver</a>
</span>
```

### 4. Botones más grandes en toda la fila de acciones

**Archivo:** `views/desglosar.ejs` (líneas 100, 110–114, 118–122)

Todos los botones de acción de subtarea (`✓ Hecho`, `✏️`, `×`) pasan de `text-[11px] px-2 py-1` a `text-xs px-2.5 py-1.5`.

---

## Archivos afectados

| Archivo | Cambio |
|---------|--------|
| `views/desglosar.ejs` | Formulario de envío, link post-envío, tamaño de botones |
| `src/routes/destinations.js` | Línea 479: `status(400)` → `redirect('/desglosar')` |

---

## Verificación

1. Cargar `/desglosar` con al menos un proyecto que tenga subtareas `open`.
2. Seleccionar "✅ Hacer" en el `<select>` y hacer clic en "↗ Enviar" — la subtarea debe cambiar a estado `sent` y mostrar "✅ hacer → ver".
3. Hacer clic en "→ ver" — debe navegar a `/hacer` y la tarea debe estar visible.
4. Intentar submit del form sin seleccionar destino (via JS o herramienta de dev) — debe redirigir a `/desglosar` sin error 400.
5. Confirmar que los botones `✓ Hecho`, `✏️` y `×` son visualmente más grandes.
6. Verificar en `npm run check` que lint + tests pasan.
