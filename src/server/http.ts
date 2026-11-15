import { ApiError, ensure } from './errors';
export async function body(request: Request): Promise<Record<string, unknown>> {
  ensure(request.headers.get('content-type')?.split(';')[0] === 'application/json', 415, 'Нужен Content-Type: application/json');
  const reader = request.body?.getReader();
  ensure(reader, 400, 'Пустое тело запроса');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new ApiError(413, 'Запрос больше 64 КиБ'); }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    ensure(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'Нужен JSON-объект');
    return parsed as Record<string, unknown>;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'Некорректный JSON'); }
}
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export function failure(error: unknown) {
  if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status, error.status === 429 ? { 'Retry-After': '60' } : {});
  console.error('Arena request failed:', error instanceof Error ? error.message : 'unknown error');
  return json({ error: 'Внутренняя ошибка сервера', code: 'internal_error' }, 500);
}
