export class ImportValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ImportValidationError';
    this.details = details;
    this.status = 400;
  }
}

const MAX_IMPORT_ITEMS = 10000;
const MAX_IMPORT_ERROR_DETAILS = 10;
const IMPORT_ALLOWED_LISTS = new Set([
  'collect', 'hacer', 'agendar', 'delegar', 'desglosar', 'no-hacer',
  'inbox', 'next', 'projects', 'waiting', 'someday', 'calendar', 'reference',
]);
const IMPORT_ALLOWED_KINDS = new Set(['action', 'project', 'reference']);
const IMPORT_ALLOWED_STATUS = new Set(['unprocessed', 'processed', 'done']);
const IMPORT_ALLOWED_ITEM_KEYS = new Set([
  'id', 'input', 'title', 'kind', 'list', 'context', 'nextAction', 'notes', 'status',
  'createdAt', 'updatedAt', 'urgency', 'importance', 'estimateMin', 'priorityScore',
  'durationWarning', 'actionableScore', 'actionableOk', 'actionableFeedback',
  'completedAt', 'completionComment', 'scheduledFor', 'delegatedTo', 'delegatedFor',
  'objective', 'subtasks', 'sourceProjectId', 'sourceSubtaskId', 'tags',
]);
const IMPORT_ALLOWED_SUBTASK_KEYS = new Set(['id', 'text', 'status', 'sentTo', 'sentItemId', 'completedAt']);

function toSanitizedString(value, maxLen, sanitizeInput, { nullable = true } = {}) {
  if (value == null) return nullable ? null : '';
  if (typeof value !== 'string') throw new Error('must be a string');
  const clean = sanitizeInput(value);
  if (clean.length > maxLen) throw new Error(`must be <= ${maxLen} chars`);
  if (!clean && !nullable) throw new Error('cannot be empty');
  return clean || (nullable ? null : '');
}

function toBoundedInt(value, { min, max, nullable = true }) {
  if (value == null || value === '') return nullable ? null : min;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error('must be an integer');
  if (n < min || n > max) throw new Error(`must be between ${min} and ${max}`);
  return n;
}

function toBoundedNumber(value, { min, max, nullable = true }) {
  if (value == null || value === '') return nullable ? null : min;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('must be a number');
  if (n < min || n > max) throw new Error(`must be between ${min} and ${max}`);
  return n;
}

function toIsoDate(value, { nullable = true } = {}) {
  if (value == null || value === '') return nullable ? null : new Date().toISOString();
  if (typeof value !== 'string') throw new Error('must be a string date');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('must be a valid date');
  return d.toISOString();
}

function normalizeImportedSubtasks(rawSubtasks, sanitizeInput) {
  if (rawSubtasks == null) return [];
  if (!Array.isArray(rawSubtasks)) throw new Error('subtasks must be an array');
  if (rawSubtasks.length > 200) throw new Error('subtasks max is 200');

  return rawSubtasks.map((subtask, idx) => {
    if (!subtask || typeof subtask !== 'object' || Array.isArray(subtask)) {
      throw new Error(`subtasks[${idx}] must be an object`);
    }
    const unknownSubtaskKeys = Object.keys(subtask).filter(k => !IMPORT_ALLOWED_SUBTASK_KEYS.has(k));
    if (unknownSubtaskKeys.length) {
      throw new Error(`subtasks[${idx}] has unsupported keys: ${unknownSubtaskKeys.join(', ')}`);
    }

    const id = toSanitizedString(subtask.id, 64, sanitizeInput, { nullable: false });
    const text = toSanitizedString(subtask.text, 280, sanitizeInput, { nullable: false });
    const status = toSanitizedString(subtask.status, 16, sanitizeInput, { nullable: false });
    if (!['open', 'sent', 'done'].includes(status)) throw new Error(`subtasks[${idx}].status must be open|sent|done`);

    const sentTo = toSanitizedString(subtask.sentTo, 32, sanitizeInput);
    const sentItemId = toSanitizedString(subtask.sentItemId, 64, sanitizeInput);
    const completedAt = toIsoDate(subtask.completedAt);
    return { id, text, status, sentTo, sentItemId, completedAt };
  });
}

function normalizeImportedTags(rawTags, sanitizeInput) {
  if (rawTags == null) return [];
  if (!Array.isArray(rawTags)) throw new Error('tags must be an array');
  if (rawTags.length > 20) throw new Error('tags max is 20');

  const tags = rawTags.map((tag, idx) => {
    if (typeof tag !== 'string') throw new Error(`tags[${idx}] must be a string`);
    const clean = sanitizeInput(tag).toLowerCase();
    if (!clean) throw new Error(`tags[${idx}] cannot be empty`);
    if (clean.length > 20) throw new Error(`tags[${idx}] must be <= 20 chars`);
    return clean;
  });
  return Array.from(new Set(tags));
}

function normalizeImportedItem(rawItem, sanitizeInput) {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error('item must be an object');
  }

  const unknownKeys = Object.keys(rawItem).filter(k => !IMPORT_ALLOWED_ITEM_KEYS.has(k));
  if (unknownKeys.length) {
    throw new Error(`unsupported keys: ${unknownKeys.join(', ')}`);
  }

  const id = toSanitizedString(rawItem.id, 64, sanitizeInput, { nullable: false });
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) throw new Error('id must match [a-zA-Z0-9_-]{6,64}');

  const inputRaw = toSanitizedString(rawItem.input, 500, sanitizeInput, { nullable: true });
  const titleRaw = toSanitizedString(rawItem.title, 280, sanitizeInput, { nullable: true });
  const input = inputRaw || titleRaw;
  if (!input) throw new Error('input or title is required');
  const title = titleRaw || input;

  const kind = toSanitizedString(rawItem.kind, 32, sanitizeInput);
  if (kind && !IMPORT_ALLOWED_KINDS.has(kind)) throw new Error('kind must be action|project|reference');

  const list = toSanitizedString(rawItem.list, 32, sanitizeInput, { nullable: false });
  if (!IMPORT_ALLOWED_LISTS.has(list)) throw new Error('list is not supported');

  const status = toSanitizedString(rawItem.status, 32, sanitizeInput, { nullable: false });
  if (!IMPORT_ALLOWED_STATUS.has(status)) throw new Error('status must be unprocessed|processed|done');

  const createdAt = toIsoDate(rawItem.createdAt, { nullable: false });
  const updatedAt = toIsoDate(rawItem.updatedAt, { nullable: false });
  const completedAt = toIsoDate(rawItem.completedAt);

  const urgency = toBoundedInt(rawItem.urgency, { min: 1, max: 5 });
  const importance = toBoundedInt(rawItem.importance, { min: 1, max: 5 });
  const estimateMin = toBoundedInt(rawItem.estimateMin, { min: 1, max: 600 });
  const priorityScore = toBoundedNumber(rawItem.priorityScore, { min: 1, max: 1000 });
  const actionableScore = toBoundedNumber(rawItem.actionableScore, { min: 0, max: 100 });
  const actionableOk = rawItem.actionableOk == null ? null : Boolean(rawItem.actionableOk);

  const subtasks = normalizeImportedSubtasks(rawItem.subtasks, sanitizeInput);
  const tags = normalizeImportedTags(rawItem.tags, sanitizeInput);

  return {
    id,
    input,
    title,
    kind,
    list,
    context: toSanitizedString(rawItem.context, 64, sanitizeInput),
    nextAction: toSanitizedString(rawItem.nextAction, 280, sanitizeInput),
    notes: toSanitizedString(rawItem.notes, 2000, sanitizeInput),
    status,
    createdAt,
    updatedAt,
    urgency,
    importance,
    estimateMin,
    priorityScore,
    durationWarning: toSanitizedString(rawItem.durationWarning, 280, sanitizeInput),
    actionableScore,
    actionableOk,
    actionableFeedback: toSanitizedString(rawItem.actionableFeedback, 280, sanitizeInput),
    completedAt,
    completionComment: toSanitizedString(rawItem.completionComment, 1000, sanitizeInput),
    scheduledFor: toIsoDate(rawItem.scheduledFor),
    delegatedTo: toSanitizedString(rawItem.delegatedTo, 120, sanitizeInput),
    delegatedFor: toIsoDate(rawItem.delegatedFor),
    objective: toSanitizedString(rawItem.objective, 1000, sanitizeInput),
    subtasks,
    sourceProjectId: toSanitizedString(rawItem.sourceProjectId, 64, sanitizeInput),
    sourceSubtaskId: toSanitizedString(rawItem.sourceSubtaskId, 64, sanitizeInput),
    tags,
  };
}

export function validateAndNormalizeImportPayload(importData, sanitizeInput) {
  if (!importData || !Array.isArray(importData.items)) {
    throw new ImportValidationError('Invalid import data format');
  }
  if (importData.items.length > MAX_IMPORT_ITEMS) {
    throw new ImportValidationError(`Import exceeds ${MAX_IMPORT_ITEMS} items`);
  }

  const importErrors = [];
  const seenImportIds = new Set();
  const normalizedItems = [];

  importData.items.forEach((rawItem, idx) => {
    if (importErrors.length >= MAX_IMPORT_ERROR_DETAILS) return;
    try {
      const item = normalizeImportedItem(rawItem, sanitizeInput);
      if (seenImportIds.has(item.id)) {
        throw new Error('duplicate id inside import payload');
      }
      seenImportIds.add(item.id);
      normalizedItems.push(item);
    } catch (err) {
      importErrors.push(`items[${idx}]: ${err.message}`);
    }
  });

  if (importErrors.length) {
    throw new ImportValidationError('Invalid import data', importErrors);
  }

  return normalizedItems;
}
