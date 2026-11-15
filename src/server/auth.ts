import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db, rateLimit } from './db';
import { ensure, text } from './errors';
import type { UserView } from '@/features/arena/types';

const scrypt = promisify(scryptCallback);
export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface UserRow { id: string; handle: string; name: string; bio: string; password: string; created_at: number }
export const publicUser = (row: UserRow): UserView => ({ id: row.id, handle: row.handle, name: row.name, bio: row.bio, createdAt: row.created_at });
export function getUser(id: string): UserView | null {
  const row = db().prepare('SELECT * FROM users WHERE id=?').get(id) as unknown as UserRow | undefined;
  return row ? publicUser(row) : null;
}
export function sessionUser(request: Request): UserView | null {
  const token = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('dm_session='))?.slice(11);
  if (!token || token.length > 100) return null;
  const row = db().prepare('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(hash(token), Date.now()) as unknown as UserRow | undefined;
  return row ? publicUser(row) : null;
}
export function requireUser(request: Request): UserView {
  const user = sessionUser(request);
  ensure(user, 401, 'Войдите в аккаунт', 'unauthorized');
  return user;
}
export function sameOrigin(request: Request) {
  const allowed = new URL(process.env.APP_ORIGIN || request.url);
  let origin: URL | null = null;
  try { origin = new URL(request.headers.get('origin') || ''); } catch { /* Missing/opaque origins are rejected. */ }
  const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  // Next's internal URL can use localhost even when the browser used 127.0.0.1.
  // Only loopback aliases with the same scheme AND port are interchangeable.
  const valid = origin && origin.origin === request.headers.get('origin') && (origin.origin === allowed.origin
    || loopback(origin.hostname) && loopback(allowed.hostname) && origin.protocol === allowed.protocol && origin.port === allowed.port);
  ensure(valid, 403, 'Запрос с другого сайта запрещён', 'origin_rejected');
}
export async function authenticate(input: Record<string, unknown>, register: boolean): Promise<{ user: UserView; token: string }> {
  const handle = text(input.handle, 3, 30, 'Логин').toLowerCase();
  ensure(/^[a-z0-9_]+$/.test(handle), 400, 'Логин: латинские буквы, цифры и _');
  const password = input.password;
  ensure(typeof password === 'string' && password.length >= 10 && password.length <= 128, 400, 'Пароль: от 10 до 128 символов');
  rateLimit(`auth:${handle}`, 10, 15 * 60_000);
  let row = db().prepare('SELECT * FROM users WHERE handle=?').get(handle) as unknown as UserRow | undefined;
  if (register) {
    rateLimit('registrations', 40, 3600_000);
    ensure(!row, 409, 'Этот логин уже занят');
    const name = text(input.name, 1, 50, 'Имя');
    const salt = randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64) as Buffer;
    row = { id: randomUUID(), handle, name, bio: '', password: `${salt}:${derived.toString('hex')}`, created_at: Date.now() };
    try { db().prepare('INSERT INTO users(id,handle,name,bio,password,created_at) VALUES(?,?,?,?,?,?)').run(row.id, handle, name, '', row.password, row.created_at); }
    catch { ensure(false, 409, 'Этот логин уже занят'); }
  } else {
    // Run the same KDF even for an unknown handle.
    const [salt, expected] = (row?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
    const derived = await scrypt(password, salt, 64) as Buffer;
    ensure(row && timingSafeEqual(derived, Buffer.from(expected, 'hex')), 401, 'Неверный логин или пароль');
  }
  ensure(row, 401, 'Ошибка авторизации');
  const token = secret();
  db().prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
  db().prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(hash(token), row.id, Date.now() + 7 * 86400_000);
  return { user: publicUser(row), token };
}
