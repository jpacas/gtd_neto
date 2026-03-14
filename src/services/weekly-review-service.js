// Weekly Review Service
// Defines the 6-step wizard with checkFns and streak calculation

export const WEEKLY_REVIEW_SCHEMA_VERSION = 1;

export const REVIEW_STEPS = [
  {
    n: 1,
    icon: '📥',
    title: 'Limpiar bandeja',
    description: 'Procesa todos los elementos de tu Collect y asígnales un destino.',
    actionHref: '/collect',
    actionLabel: 'Ir a Collect',
    checkLabel: 'items pendientes en Collect',
  },
  {
    n: 2,
    icon: '🧩',
    title: 'Revisar proyectos',
    description: 'Revisa tus proyectos en Desglosar y asegúrate de que cada uno tiene un próximo paso claro.',
    actionHref: '/desglosar',
    actionLabel: 'Ir a Desglosar',
    checkLabel: 'proyectos activos en Desglosar',
  },
  {
    n: 3,
    icon: '🤝',
    title: 'Revisar delegados',
    description: 'Comprueba los elementos que delegaste y realiza seguimiento si es necesario.',
    actionHref: '/delegar',
    actionLabel: 'Ir a Delegar',
    checkLabel: 'elementos delegados activos',
  },
  {
    n: 4,
    icon: '🗓️',
    title: 'Próximos 7 días',
    description: 'Revisa tu agenda de la próxima semana en Agendar.',
    actionHref: '/agendar',
    actionLabel: 'Ir a Agendar',
    checkLabel: 'elementos agendados próximos 7 días',
  },
  {
    n: 5,
    icon: '🧠',
    title: 'Vaciado mental',
    description: '¿Qué más está en tu cabeza? Captura todo lo que no hayas procesado aún. También revisa tu lista Algún Día / Tal Vez.',
    actionHref: '/someday',
    actionLabel: 'Ver Algún Día',
    checkLabel: null, // no automatic check — always manual
    hasCapture: true, // inline capture form
  },
  {
    n: 6,
    icon: '🎯',
    title: 'Marcar revisión completa',
    description: '¡Excelente! Tu sistema está al día. Marca la revisión como completa para registrar tu racha.',
    actionHref: null,
    actionLabel: null,
    checkLabel: null,
    isFinal: true,
  },
];

// Check functions for each step — return { ok: boolean, count: number|null, message: string }
export async function runStepCheck(stepN, { loadItemsForList, owner }) {
  try {
    switch (stepN) {
      case 1: {
        const items = await loadItemsForList('collect', { owner, excludeDone: true });
        const count = items.length;
        return { ok: count === 0, count, message: count === 0 ? 'Bandeja vacía ✓' : `${count} item${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}` };
      }
      case 2: {
        const items = await loadItemsForList('desglosar', { owner, excludeDone: true });
        const count = items.length;
        return { ok: true, count, message: `${count} proyecto${count === 1 ? '' : 's'} activo${count === 1 ? '' : 's'}` };
      }
      case 3: {
        const items = await loadItemsForList('delegar', { owner, excludeDone: true });
        const count = items.length;
        return { ok: true, count, message: `${count} elemento${count === 1 ? '' : 's'} delegado${count === 1 ? '' : 's'}` };
      }
      case 4: {
        const now = new Date();
        const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const items = await loadItemsForList('agendar', { owner, excludeDone: true });
        const upcoming = items.filter(i => i.scheduledFor && i.scheduledFor <= in7Days);
        const count = upcoming.length;
        return { ok: true, count, message: `${count} elemento${count === 1 ? '' : 's'} próximos 7 días` };
      }
      case 5:
      case 6:
        return { ok: true, count: null, message: null };
      default:
        return { ok: true, count: null, message: null };
    }
  } catch {
    return { ok: true, count: null, message: null };
  }
}

// Calculate streak: number of consecutive weeks with completed reviews
// A week is considered consecutive if the review was completed within 2 weeks of the previous one
export function calculateStreak(completedReviews) {
  if (!Array.isArray(completedReviews) || completedReviews.length === 0) return 0;

  // Sort by completedAt descending
  const sorted = completedReviews
    .filter(r => r.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  if (sorted.length === 0) return 0;

  // Check if the most recent review is within the last 2 weeks
  const mostRecent = new Date(sorted[0].completedAt);
  const now = new Date();
  const daysSinceLast = (now - mostRecent) / (1000 * 60 * 60 * 24);
  if (daysSinceLast > 14) return 0;

  // Count consecutive weekly reviews (gap <= 14 days between each)
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].completedAt);
    const curr = new Date(sorted[i].completedAt);
    const gap = (prev - curr) / (1000 * 60 * 60 * 24);
    if (gap <= 14) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

// Get last completed review and days since last
export function getLastReviewInfo(allReviews) {
  const completed = (allReviews || [])
    .filter(r => r.completedAt)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  if (completed.length === 0) return { lastReview: null, daysSinceLast: null };

  const lastReview = completed[0];
  const daysSinceLast = Math.floor((Date.now() - new Date(lastReview.completedAt)) / (1000 * 60 * 60 * 24));

  return { lastReview, daysSinceLast };
}

// Create a new review session
export function createReviewSession(id, owner) {
  const now = new Date().toISOString();
  return {
    id,
    owner,
    startedAt: now,
    completedAt: null,
    currentStep: 1,
    steps: {},
    notes: '',
    schemaVersion: WEEKLY_REVIEW_SCHEMA_VERSION,
  };
}
