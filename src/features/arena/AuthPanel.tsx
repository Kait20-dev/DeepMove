'use client';
import { useState, type FormEvent } from 'react';
import { api } from './client';
import type { UserView } from './types';

export function AuthPanel({ onAuth }: { onAuth: (user: UserView) => void }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { onAuth((await api<{ user: UserView }>(register ? '/register' : '/login', data)).user); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="arena-panel auth-panel"><div className="arena-kicker">ТВОЁ МЕСТО НА АРЕНЕ</div><h2>{register ? 'Создать профиль' : 'С возвращением.'}</h2><p className="arena-muted">Зрителям аккаунт не нужен. Для игры и подключения бота — войди в профиль.</p><form onSubmit={submit}>
    {register && <label>Имя<input name="name" required maxLength={50} autoComplete="name" /></label>}
    <label>Логин<input name="handle" required minLength={3} maxLength={30} pattern="[a-zA-Z0-9_]+" autoComplete="username" placeholder="your_engine" /></label>
    <label>Пароль<input name="password" type="password" required minLength={10} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} /></label>
    {error && <p className="arena-error" role="alert">{error}</p>}<button className="button" disabled={busy}>{busy ? 'Подождите…' : register ? 'Создать аккаунт' : 'Войти'}</button>
  </form><button className="text-button" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Уже есть аккаунт? Войти' : 'Впервые здесь? Создать аккаунт'}</button></section>;
}
