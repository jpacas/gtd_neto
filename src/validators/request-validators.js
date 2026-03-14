export class RequestValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestValidationError';
    this.status = status;
  }
}

export function sanitizeIdParam(rawId, sanitizeInput) {
  const id = sanitizeInput(String(rawId || ''));
  if (!id) throw new RequestValidationError('Invalid id');
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(id)) throw new RequestValidationError('Invalid id format');
  return id;
}

export function sanitizeTextField(raw, sanitizeInput, { field = 'value', required = false, maxLen = 500 } = {}) {
  const value = sanitizeInput(String(raw || ''));
  if (required && !value) throw new RequestValidationError(`${field} is required`);
  if (value.length > maxLen) throw new RequestValidationError(`${field} exceeds max length ${maxLen}`);
  return value;
}

export function sanitizeEnumField(raw, allowed, sanitizeInput, field = 'value') {
  const value = sanitizeInput(String(raw || ''));
  if (!allowed.includes(value)) throw new RequestValidationError(`${field} is invalid`);
  return value;
}

export function sanitizeIntegerField(raw, { field = 'value', min = 1, max = 100, fallback = null } = {}) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new RequestValidationError(`${field} must be an integer`);
  if (n < min || n > max) throw new RequestValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

// Context field: @word format or empty
export function sanitizeContextField(raw, sanitizeInput) {
  const value = sanitizeInput(String(raw || '')).trim();
  if (!value) return null;
  // Must be @word format (1-30 chars after @, letters/digits/hyphens)
  if (!/^@[a-záéíóúñA-ZÁÉÍÓÚÑ0-9_-]{1,30}$/.test(value)) {
    throw new RequestValidationError('context must be in @palabra format');
  }
  return value.toLowerCase();
}

// Area field: simple word (no @ prefix), 1-30 chars
export function sanitizeAreaField(raw, sanitizeInput) {
  const value = sanitizeInput(String(raw || '')).trim();
  if (!value) return null;
  if (value.length > 30) throw new RequestValidationError('area exceeds max length 30');
  if (!/^[a-záéíóúñA-ZÁÉÍÓÚÑ0-9 _-]+$/.test(value)) {
    throw new RequestValidationError('area contains invalid characters');
  }
  return value.toLowerCase();
}
