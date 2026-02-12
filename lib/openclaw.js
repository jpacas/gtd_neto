import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runOpenClaw({ prompt, sessionId, agentId, timeoutSeconds, thinking }) {
  const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';

  const args = ['agent', '--session-id', sessionId, '--message', prompt, '--json', '--timeout', String(timeoutSeconds)];
  if (agentId) args.splice(1, 0, '--agent', agentId);
  if (thinking) args.push('--thinking', thinking);

  const { stdout } = await execFileAsync(OPENCLAW_BIN, args, {
    timeout: (timeoutSeconds + 15) * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const data = JSON.parse(stdout);
  const payloads = data?.result?.payloads;
  const text =
    Array.isArray(payloads) && payloads.length
      ? (payloads.map(p => p?.text).filter(Boolean).join('\n\n') || '')
      : '';

  return { data, text };
}

export function buildGtdExtractPrompt({ input }) {
  return `Eres un asistente GTD. Convierte la siguiente captura de inbox en un objeto JSON *válido* (solo JSON, sin markdown).

Reglas:
- Si no hay suficiente info, asume lo mínimo.
- "kind": "action" | "project" | "reference"
- "list": "next" | "projects" | "waiting" | "someday" | "calendar" | "reference"
- "context": string o null (ej: "@casa", "@pc")
- "title": string corto
- "nextAction": string o null (si kind=project, sugiere una primera next action)
- "notes": string o null

Devuelve EXACTAMENTE este shape:
{
  "title": string,
  "kind": string,
  "list": string,
  "context": string | null,
  "nextAction": string | null,
  "notes": string | null
}

Captura:
${JSON.stringify(input)}
`;
}

export function buildBreakdownPrompt({ input, destination }) {
  return `Eres un asistente GTD experto en simplificar tareas.

Objetivo:
- Recibir una captura en texto.
- Si parece proyecto, desglosarlo en micro-acciones ejecutables de <= 10 minutos.
- Proponer a qué lista GTD debería ir.

Reglas:
- Máximo 8 micro-acciones.
- Cada micro-acción debe empezar con verbo en infinitivo ("Definir", "Llamar", "Enviar", etc.).
- Evitar pasos vagos como "trabajar en...".
- Si la captura es una acción simple, devolver 1 micro-acción.
- "recommendedList": "inbox" | "next" | "projects" | "waiting" | "someday" | "calendar" | "reference"

Devuelve SOLO JSON válido con este shape:
{
  "title": string,
  "kind": "action" | "project" | "reference",
  "recommendedList": string,
  "context": string | null,
  "steps": string[]
}

Preferencia del usuario para destino: ${JSON.stringify(destination)}
Captura:
${JSON.stringify(input)}
`;
}

export function safeParseJsonFromText(text) {
  // best-effort: find first {...} block
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found in response');
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}
