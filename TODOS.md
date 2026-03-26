# TODOS

Items deferred from plan reviews. Each item has effort, priority, and context.

---

## P1 — Alta prioridad (post-launch inmediato)

### Emails transaccionales (trial ending + payment failed)

**What:** Enviar email 3 días antes de que expire el trial recordando al usuario suscribirse. Enviar email cuando el status pasa a `past_due` (pago fallido).

**Why:** Sin estos emails, los usuarios no saben que su trial está a punto de vencer. La conversión trial→pago mejora significativamente con un recordatorio a tiempo. El email de pago fallido reduce el churn involuntario.

**Pros:** Mejora conversión trial→pago. Reduce churn por pago fallido. Profesionaliza la experiencia.

**Cons:** Requiere integrar un servicio de email (Resend es la opción más simple para este stack). ~2-3 horas humanas / ~15 minutos con CC.

**Context:** Actualmente `requiresSubscription` redirige a `/pricing` cuando el trial expira, pero el usuario no recibe ningún aviso previo. El webhook `invoice.payment_failed` ya marca `status: 'past_due'` — el trigger para el email ya existe.

**Effort:** M (humano) → S (CC+gstack)
**Priority:** P1
**Depends on:** Cuenta en Resend o similar. Variables env `RESEND_API_KEY`.

---

## P2 — Media prioridad

### Dashboard de métricas de negocio interno (/admin)

**What:** Página protegida por `APP_API_KEY` que muestra: signups hoy/semana, trials activos, usuarios pagando, MRR estimado, tasa de conversión trial→pago.

**Why:** Hoy hay que ir a Supabase directamente para ver estas métricas. Con usuarios reales, quieres ver de un vistazo el estado del negocio sin abrir otra pestaña.

**Pros:** Visibilidad operacional desde el día 1. Facilita detectar problemas de conversión rápido.

**Cons:** Requiere nuevas queries a Supabase. No agrega valor al usuario final.

**Context:** Las tablas ya existen (`gtd_items`, `subscriptions`). Son ~5-8 queries simples. La página puede ser un EJS básico sin layout complejo.

**Effort:** M (humano) → S (CC+gstack)
**Priority:** P2
**Depends on:** Nada. Independiente.

---

## P3 — Baja prioridad (cuando la escala lo justifique)

### Cache en memoria de getUserSubscription()

**What:** Cache in-process con TTL de 60 segundos para `getUserSubscription()`. Cada request autenticado genera 1 query a Supabase; con muchos usuarios simultáneos, esto escala linealmente.

**Why:** A >500 usuarios activos simultáneos, las queries de subscription serán el primer bottleneck. Con cache, se reduce a 1 query por usuario por minuto.

**Pros:** Reduce carga en Supabase. Mejora latencia de requests autenticados.

**Cons:** Estado potencialmente desactualizado ~60s (ventana entre webhook que cambia status y cache que expira). Complejidad añadida. Riesgo: usuario pagó pero sigue viendo trial por hasta 60s. Mitigación: invalidar cache en webhook.

**Context:** `requiresSubscription` en `src/middleware/subscription.js` llama a `getUserSubscription()` en cada request. El webhook ya tiene acceso para invalidar el cache al recibir cambios de status.

**Effort:** M (humano) → S (CC+gstack)
**Priority:** P3
**Depends on:** Resolver primero si hay evidencia real de lentitud.
