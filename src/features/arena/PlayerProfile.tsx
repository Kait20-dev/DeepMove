'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Building2, MapPin, Globe, Camera, Bot, ArrowUpRight } from 'lucide-react';
import { api } from './client';
import type { BotView, TeamView, UserView } from './types';

export function Avatar({ user, size = 72 }: { user: UserView; size?: number }) {
  return <span className="player-avatar" style={{ width: size, height: size, fontSize: size / 2.8 }}>{user.avatar ? <Image src={user.avatar} alt={`Аватар ${user.name}`} width={size} height={size} unoptimized /> : user.name.trim().slice(0, 2).toUpperCase()}</span>;
}
export function PlayerCard({ user }: { user: UserView }) {
  return <section className="arena-panel player-card"><Avatar user={user} size={96} /><div className="arena-kicker">УЧАСТНИК DEEPMOVE</div><h2>{user.name}</h2><p className="profile-handle">@{user.handle}</p>{user.organization && <p><Building2 size={16} />{user.organization}</p>}{user.city && <p><MapPin size={16} />{user.city}</p>}{user.website && <a href={user.website} target="_blank" rel="noopener noreferrer"><Globe size={16} />{new URL(user.website).hostname}<ArrowUpRight size={14} /></a>}<p className="profile-bio">{user.bio || 'Здесь скоро появится история участника.'}</p><small className="arena-muted">На арене с {new Date(user.createdAt).toLocaleDateString('ru-RU')}</small></section>;
}
export function ProfileEditor({ user, onUpdate }: { user: UserView; onUpdate: () => Promise<void> }) {
  const [avatar, setAvatar] = useState(user.avatar || ''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [preparing, setPreparing] = useState(false);
  async function upload(file?: File) {
    if (!file) return;
    setPreparing(true); setMessage('');
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Выберите PNG, JPEG или WebP до 5 МБ');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d'); if (!context) { bitmap.close(); throw new Error('Браузер не поддерживает обработку изображения'); }
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 128, 128); bitmap.close();
      const result = canvas.toDataURL('image/webp', .8);
      if (result.length > 40000) throw new Error('Не удалось сжать аватар. Попробуйте другую картинку.');
      setAvatar(result);
    } catch (error) { setMessage((error as Error).message); } finally { setPreparing(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api('/profile', { ...Object.fromEntries(new FormData(event.currentTarget)), avatar }); await onUpdate(); setMessage('Профиль сохранён'); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="profile-detail-grid"><div><PlayerCard user={user} /><Link className="text-button profile-public-link" href={`/arena/players/${user.handle}`}>Открыть публичный профиль ↗</Link></div><section className="arena-panel"><h2>Профиль участника</h2><p className="arena-muted">Представь себя соперникам и будущей команде.</p><form onSubmit={submit}><div className="avatar-upload"><Avatar user={{ ...user, avatar }} /><div><label className="avatar-file"><Camera size={16} />{preparing ? 'Готовим…' : 'Загрузить аватар'}<input aria-label="Загрузить аватар" type="file" accept="image/png,image/jpeg,image/webp" disabled={preparing} onChange={event => void upload(event.target.files?.[0])} /></label>{avatar && <button type="button" className="text-button" onClick={() => setAvatar('')}>Убрать фото</button>}<span className="field-hint">PNG, JPEG, WebP · до 5 МБ</span></div></div><div className="form-row"><label>Имя<input name="name" defaultValue={user.name} maxLength={50} required /></label><label>Никнейм<input name="handle" defaultValue={user.handle} pattern="[a-zA-Z0-9_]{3,30}" minLength={3} maxLength={30} required /><span className="field-hint">Используется и для входа.</span></label></div><label>Организация<input name="organization" defaultValue={user.organization} maxLength={100} placeholder="Например, КАИТ №20" /></label><div className="form-row"><label>Город<input name="city" defaultValue={user.city} maxLength={80} placeholder="Москва" /></label><label>Сайт<input name="website" type="url" defaultValue={user.website} maxLength={200} placeholder="https://…" /></label></div><label>О себе<textarea name="bio" defaultValue={user.bio} maxLength={500} rows={4} placeholder="Какой движок ты создаёшь?" /></label><button className="button" disabled={busy || preparing}>{busy ? 'Сохраняем…' : 'Сохранить'}</button><p role="status" className="arena-muted">{message}</p></form></section></div>;
}
export function BotsPanel({ user, bots, teams, onUpdate }: { user: UserView; bots: BotView[]; teams: TeamView[]; onUpdate: () => Promise<void> }) {
  const [editing, setEditing] = useState<BotView | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [formKey, setFormKey] = useState(0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = Object.fromEntries(new FormData(event.currentTarget)); setBusy(true); setMessage('');
    try { await api(`/bots${editing ? `/${editing.id}` : ''}`, fields); await onUpdate(); setEditing(null); setFormKey(k => k + 1); setMessage('Бот сохранён'); }
    catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  }
  return <><p className="arena-muted">У каждого бота своя карточка и очки. Выбери команду, чтобы он выступал и в Кубке конструкторов.</p><div className="bots-layout"><section className="arena-panel"><h2>{editing ? 'Настройки бота' : 'Зарегистрировать бота'}</h2><form key={`${editing?.id || 'new'}:${formKey}`} onSubmit={submit}><label>Название бота<input name="name" minLength={2} maxLength={50} defaultValue={editing?.name} required placeholder="DeepMoveBot" /></label><label>Команда бота<select name="teamId" defaultValue={editing?.teamId || ''}><option value="">Личный зачёт · без команды</option>{teams.filter(t => t.members.some(member => member.id === user.id)).map(team => <option value={team.id} key={team.id}>{team.name}</option>)}</select></label><label>Описание бота<textarea name="description" maxLength={500} rows={4} defaultValue={editing?.description} placeholder="Язык, алгоритм и особенности движка" /></label><button className="button" disabled={busy}>{editing ? 'Сохранить бота' : 'Зарегистрировать'}</button>{editing && <button type="button" className="text-button" onClick={() => setEditing(null)}>Отмена</button>}</form><p role="status" className="arena-muted">{message}</p><p className="field-hint">Смена команды действует на будущие серии. Очки завершённых серий сохраняются за прежней командой.</p></section><div className="bot-cards">{bots.map(bot => <article className="arena-panel bot-card" key={bot.id}><div className="bot-card-icon"><Bot size={25} /></div><div><h3>{bot.name}</h3><span className="arena-outline-badge">{bot.teamName || 'Независимый бот'}</span><p className="arena-muted">{bot.description || 'Математика готовится к бою.'}</p><code className="bot-id">{bot.id}</code></div><button className="text-button" onClick={() => setEditing(bot)}>Изменить</button></article>)}{!bots.length && <div className="arena-empty"><Bot size={36} /><h3>Здесь начинается твой движок.</h3><p>Зарегистрируй бота, затем создай зачётную серию.</p></div>}</div></div></>;
}
export function PublicPlayer({ handle }: { handle: string }) {
  const [data, setData] = useState<{ user: UserView; bots: BotView[] } | null>(null), [error, setError] = useState('');
  useEffect(() => { let alive = true; api<{ user: UserView; bots: BotView[] }>(`/players/${encodeURIComponent(handle)}`).then(result => { if (alive) setData(result); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [handle]);
  return <div className="container public-profile"><Link href="/arena">← На арену</Link>{error && <p className="arena-error" role="alert">{error}</p>}{data ? <div className="profile-detail-grid"><PlayerCard user={data.user} /><section><div className="arena-kicker">ДВИЖКИ УЧАСТНИКА</div><h1>Код играет за меня.</h1>{data.bots.map(bot => <article className="arena-panel" key={bot.id}><h2>{bot.name}</h2><p className="arena-muted">{bot.teamName || 'Независимый бот'}</p><p>{bot.description}</p></article>)}{!data.bots.length && <p className="arena-muted">Боты ещё не зарегистрированы.</p>}</section></div> : !error && <p role="status">Загружаем профиль…</p>}</div>;
}
