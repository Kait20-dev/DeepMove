import sharp from 'sharp';
import { db } from './db';
import { getUser, publicUser, type UserRow } from './auth';
import { ensure, text } from './errors';
import type { UserView } from '@/features/arena/types';

export async function updateProfile(user: UserView, input: Record<string, unknown>) {
  const name = text(input.name, 1, 50, 'Имя');
  const handle = text(input.handle ?? user.handle, 3, 30, 'Никнейм').toLowerCase();
  ensure(/^[a-z0-9_]+$/.test(handle), 400, 'Никнейм: латинские буквы, цифры и _');
  const field = (key: string, max: number) => text(input[key] ?? user[key as keyof UserView] ?? '', 0, max, key);
  const bio = field('bio', 500), organization = field('organization', 100), city = field('city', 80), website = field('website', 200);
  if (website) {
    let url: URL | undefined;
    try { url = new URL(website); } catch {}
    ensure(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 400, 'Сайт: укажите адрес http:// или https://');
  }
  let avatar = user.avatar || '';
  if (input.avatar === null || input.avatar === '') avatar = '';
  else if (input.avatar !== undefined) {
    ensure(typeof input.avatar === 'string' && input.avatar.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.avatar), 400, 'Аватар: PNG, JPEG или WebP, до 30 КБ после сжатия');
    try {
      const source = Buffer.from(input.avatar.split(',')[1], 'base64');
      const image = sharp(source, { limitInputPixels: 16_000_000, animated: false });
      const metadata = await image.metadata();
      ensure(['png', 'jpeg', 'webp'].includes(metadata.format || '') && (metadata.pages ?? 1) === 1, 400, 'Нужна статичная картинка');
      avatar = `data:image/webp;base64,${(await image.rotate().resize(128, 128, { fit: 'cover' }).webp({ quality: 80 }).toBuffer()).toString('base64')}`;
    } catch { ensure(false, 400, 'Не удалось прочитать аватар. Выберите PNG, JPEG или WebP.'); }
  }
  ensure(!db().prepare('SELECT id FROM users WHERE handle=? AND id<>?').get(handle, user.id), 409, 'Этот никнейм уже занят');
  db().prepare('UPDATE users SET name=?,handle=?,bio=?,organization=?,city=?,website=?,avatar=? WHERE id=?').run(name, handle, bio, organization, city, website, avatar, user.id);
  return { user: getUser(user.id)! };
}

export function publicProfile(handle: string) {
  const row = db().prepare('SELECT * FROM users WHERE handle=?').get(handle.toLowerCase()) as unknown as UserRow | undefined;
  ensure(row, 404, 'Участник не найден');
  return { user: publicUser(row) };
}
