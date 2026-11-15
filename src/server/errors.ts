export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'invalid_request') { super(message); }
}
export function ensure(condition: unknown, status: number, message: string, code?: string): asserts condition {
  if (!condition) throw new ApiError(status, message, code);
}
export function text(value: unknown, min: number, max: number, label: string): string {
  ensure(typeof value === 'string' && value.trim().length >= min && value.trim().length <= max, 400, `${label}: от ${min} до ${max} символов`);
  return value.trim();
}
