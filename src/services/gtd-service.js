export const DESTINATIONS = [
  { key: 'hacer', label: 'Hacer', hint: 'Acciones <10 min, claras y priorizadas' },
  { key: 'agendar', label: 'Agendar', hint: 'Acciones con fecha/agenda' },
  { key: 'delegar', label: 'Delegar', hint: 'Pendientes de terceros' },
  { key: 'desglosar', label: 'Desglosar', hint: 'Items para dividir en pasos' },
  { key: 'no-hacer', label: 'No hacer', hint: 'Descartar o archivar' },
];

export function destinationByKey(key) {
  return DESTINATIONS.find(d => d.key === key) || null;
}

export function evaluateActionability(text) {
  const t = String(text || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  const first = (words[0] || '').toLowerCase();
  const vague = ['hacer', 'ver', 'revisar tema', 'pendiente', 'trabajar', 'organizar'];

  const startsWithInfinitive = /[aá]r$|er$|ir$/.test(first);
  const hasEnoughWords = words.length >= 2;
  const tooLong = t.length > 140;
  const hasVaguePattern = vague.some(v => t.toLowerCase() === v || t.toLowerCase().startsWith(v + ' '));

  let score = 0;
  if (startsWithInfinitive) score += 40;
  if (hasEnoughWords) score += 30;
  if (!tooLong) score += 20;
  if (!hasVaguePattern) score += 10;

  const feedback = [];
  if (!startsWithInfinitive) feedback.push('Empieza con un verbo en infinitivo (Ej: Llamar, Enviar, Definir).');
  if (!hasEnoughWords) feedback.push('Hazla más específica (mínimo 2 palabras).');
  if (tooLong) feedback.push('Hazla más corta y concreta (ideal <= 140 caracteres).');
  if (hasVaguePattern) feedback.push('Evita frases vagas; especifica el resultado.');

  return {
    actionableScore: score,
    actionableOk: score >= 70,
    actionableFeedback: feedback.join(' '),
  };
}

export function withHacerMeta(item, patch = {}) {
  const urgency = Number(patch.urgency ?? item.urgency ?? 3);
  const importance = Number(patch.importance ?? item.importance ?? 3);
  const estimateMinRaw = Number(patch.estimateMin ?? item.estimateMin ?? 10);
  const estimateMin = Math.min(10, Math.max(1, estimateMinRaw));

  const title = String(patch.title ?? item.title ?? item.input ?? '').trim();
  const qa = evaluateActionability(title);
  const priorityScore = urgency * importance;

  let durationWarning = null;
  if (estimateMinRaw > 10) {
    durationWarning = `Esta tarea requiere más de 10 minutos (${estimateMinRaw} min). Considera moverla a Desglosar para dividirla en pasos más pequeños.`;
  }

  return {
    ...patch,
    title,
    urgency,
    importance,
    estimateMin,
    priorityScore,
    durationWarning,
    ...qa,
  };
}

export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Buffer.from(bytes).toString('hex');
}

export function withDesglosarMeta(item, patch = {}) {
  const objective = String(patch.objective ?? item.objective ?? '').trim();
  const subtasks = Array.isArray(patch.subtasks ?? item.subtasks)
    ? (patch.subtasks ?? item.subtasks)
    : [];

  return {
    ...patch,
    objective,
    subtasks,
  };
}
