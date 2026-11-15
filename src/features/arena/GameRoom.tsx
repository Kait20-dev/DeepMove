'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Eye, RotateCw, Link2 } from 'lucide-react';
import { api, statusLabel, reasonLabel } from './client';
import { ChessBoard } from './ChessBoard';
import { MaterialPanel, ReviewPanel } from './ReviewPanel';
import { AuthPanel } from './AuthPanel';
import { CopyPgn } from './CopyPgn';
import { boardPosition } from './board-position';
import type { GameView, Side, UserView } from './types';

export function GameRoom({ id }: { id: string }) {
  const [game, setGame] = useState<GameView | null>(null), [user, setUser] = useState<UserView | null>(null);
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0), [sync, setSync] = useState({ server: 0, local: 0 });
  const [ply, setPly] = useState<number | null>(null), [flipped, setFlipped] = useState(false);
  const [livePly, setLivePly] = useState<number | null>(null);
  const lastAdvance = useRef(0);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const receive = useCallback((incoming: GameView) => {
    setGame(previous => !previous || incoming.id !== previous.id || incoming.serverNow >= previous.serverNow && incoming.version >= previous.version ? incoming : previous);
    setLivePly(previous => previous ?? incoming.moves.length);
    setSync(previous => incoming.serverNow >= previous.server ? { server: incoming.serverNow, local: performance.now() } : previous);
  }, []);
  useEffect(() => {
    let alive = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const incoming = await api<GameView>(`/games/${id}`, undefined, controller.signal); if (alive) { receive(incoming); setConnectionError(''); } }
      catch (error) { if (alive) setConnectionError((error as Error).message); }
      finally { if (alive) timer = setTimeout(poll, 1000); }
    };
    void poll();
    api<{ user: UserView | null }>('/me', undefined, controller.signal).then(data => { if (alive) setUser(data.user); }).catch(() => {});
    const invite = sessionStorage.getItem(`invite:${id}`);
    if (invite) { queueMicrotask(() => { if (alive) setSecret({ label: 'Код приглашения соперника', value: invite }); }); sessionStorage.removeItem(`invite:${id}`); }
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [id, receive]);
  useEffect(() => { const interval = setInterval(() => setNow(sync.server + performance.now() - sync.local), 100); return () => clearInterval(interval); }, [sync]);
  useEffect(() => {
    if (!game || ply !== null || livePly === null || livePly >= game.moves.length) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wait = reduced ? 0 : Math.max(0, lastAdvance.current + 480 - performance.now());
    const target = game.moves.length;
    const timer = setTimeout(() => {
      lastAdvance.current = performance.now();
      setLivePly(current => reduced ? target : Math.min((current ?? target) + 1, target));
    }, wait);
    return () => clearTimeout(timer);
  }, [game, livePly, ply]);
  const side: Side | null = game && user ? game.seats.w.userId === user.id ? 'w' : game.seats.b.userId === user.id ? 'b' : null : null;
  const index = game ? Math.min(ply ?? livePly ?? game.moves.length, game.moves.length) : 0;
  const { chess, pieces } = useMemo(() => boardPosition(game?.moves || [], index), [game, index]);
  async function action(name: string, input: object = {}) {
    setBusy(true); setError('');
    try {
      if (name === 'key' || name === 'invite') {
        const result = await api<{ token?: string; joinCode?: string }>(`/games/${id}/${name}`, input);
        setSecret({ label: name === 'key' ? 'Ключ бота — сохраните сейчас' : 'Код приглашения соперника', value: result.token || result.joinCode || '' });
      } else receive(await api<GameView>(`/games/${id}/${name}`, input));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function copyLink() { try { await navigator.clipboard.writeText(window.location.href); setCopyMessage('Ссылка скопирована'); } catch { setCopyMessage('Скопируй адрес страницы из браузера'); } }
  if (!game) return <div className="container arena-loading"><Link href="/arena">← На арену</Link><p role={connectionError ? 'alert' : 'status'}>{connectionError || 'Открываем партию…'}</p></div>;
  const orientation: Side = flipped ? side === 'b' ? 'w' : 'b' : side || 'w';
  const ownSeat = side ? game.seats[side] : null;
  const stale = !sync.server || now - sync.server > 3500;
  const canMove = !!side && ownSeat?.kind === 'human' && game.status === 'playing' && game.turn === side && index === game.moves.length && !stale && !connectionError;
  const starting = game.status === 'waiting' && game.startsAt !== null;
  const startSeconds = starting ? Math.max(0, Math.ceil((game.startsAt! - (now || game.serverNow)) / 1000)) : 0;
  const vacancy = !game.seats.w.userId || !game.seats.b.userId;
  function join(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void action('join', Object.fromEntries(new FormData(event.currentTarget))); }
  return <div className="container game-room"><div className="room-top"><Link href="/arena"><ArrowLeft size={15} /> На арену</Link><span className={`game-status ${game.status}`}>{statusLabel[game.status]}</span><span className="arena-muted">{game.format.name}</span><button className="text-button spectator-link" onClick={copyLink}><Link2 size={16} />Пригласить зрителей</button></div>
    {copyMessage && <p role="status" className="field-hint">{copyMessage}</p>}{connectionError && <p role="alert" className="arena-error">Связь потеряна: {connectionError}. Часы на сервере продолжают идти.</p>}{error && <p role="alert" className="arena-error">{error}</p>}
    <div className="room-layout"><div className="board-column"><PlayerBar game={game} side={orientation === 'w' ? 'b' : 'w'} now={now} /><div className="countdown-board"><ChessBoard fen={chess.fen()} pieces={pieces} orientation={orientation} legalMoves={canMove ? game.legalMoves : []} onMove={canMove ? move => action('move', { move, expectedPly: game.moves.length }) : undefined} busy={busy} lastMove={game.moves[index - 1]?.uci} />{starting && <div className="start-countdown" role="timer" aria-label={`До старта ${startSeconds} секунд`}><span>ОБА ИГРОКА ГОТОВЫ</span><strong>{startSeconds || 'Старт'}</strong><p>Приготовьтесь к первому ходу.<br />Часы ещё не идут.</p></div>}</div><PlayerBar game={game} side={orientation} now={now} />
      <div className="last-move-caption" aria-live="polite">{index ? <><span>Последний показанный ход</span><strong>{Math.ceil(index / 2)}{index % 2 ? '.' : '...'} {game.moves[index - 1].san}</strong></> : <span>{starting ? 'Старт после обратного отсчёта' : 'Ожидаем первый ход'}</span>}</div>
      <div className="board-toolbar"><span><Eye size={15} />{side ? ownSeat?.kind === 'bot' ? 'Ты управляешь ботом' : canMove ? 'Твой ход' : 'Ты участник' : 'Ты зритель'}</span><button className="text-button" onClick={() => setFlipped(!flipped)}><RotateCw size={15} />Перевернуть</button><CopyPgn pgn={game.pgn} /><a className="text-button" href={`/api/arena/games/${id}/pgn`}><Download size={15} />Скачать PGN</a></div>
      {game.status === 'finished' && <div className="replay-controls"><div><button aria-label="В начало партии" onClick={() => setPly(0)} disabled={!index}><ChevronsLeft /></button><button aria-label="Предыдущий ход" onClick={() => setPly(Math.max(0, index - 1))} disabled={!index}><ChevronLeft /></button><span>{index} / {game.moves.length}</span><button aria-label="Следующий ход" onClick={() => setPly(Math.min(game.moves.length, index + 1))} disabled={index === game.moves.length}><ChevronRight /></button><button aria-label="В конец партии" onClick={() => setPly(null)} disabled={index === game.moves.length}><ChevronsRight /></button></div><input type="range" aria-label="Полуход партии" min={0} max={game.moves.length} value={index} onChange={event => setPly(Number(event.target.value))} /></div>}
      <MaterialPanel chess={chess} />
    </div><aside className="room-sidebar"><section className="arena-panel game-state"><div className="arena-kicker">{game.status === 'finished' ? 'РЕЗУЛЬТАТ' : 'ПАРТИЯ'}</div><h1>{game.status === 'finished' ? game.result : starting ? `Старт через ${startSeconds} с` : game.status === 'waiting' ? 'Готовим доску.' : game.turn === 'w' ? 'Ход белых.' : 'Ход чёрных.'}</h1><p className="arena-muted">{game.status === 'finished' ? reasonLabel[game.reason || ''] || game.reason : starting ? 'Можно открыть зрительскую ссылку. До конца отсчёта ходы заблокированы, время не расходуется.' : game.status === 'waiting' ? `После готовности обоих игроков будет ${game.startDelayMs / 1000} секунд на подготовку к старту.` : 'Время и ходы подтверждает сервер.'}</p>{game.format.botMoveMs !== null && <p className="field-hint">{game.format.humanMoveMs === game.format.botMoveMs ? 'Лимит каждого хода' : 'Лимит одного хода бота'}: {game.format.botMoveMs / 1000} с. Это ограничение, не добавление времени.</p>}
      {game.status === 'playing' && game.deadline && <p className="deadline-info">До ограничения текущего хода: {Math.max(0, (game.deadline - now) / 1000).toFixed(1)} с</p>}
      {side && game.status !== 'finished' && <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(game.status === 'waiting' ? 'Отменить эту партию?' : 'Сдаться в этой партии?')) void action('resign'); }}>{game.status === 'waiting' ? 'Отменить партию' : 'Сдаться'}</button>}
    </section>
    {game.status === 'waiting' && vacancy && !side && !user && <AuthPanel onAuth={setUser} />}
    {game.status === 'waiting' && vacancy && !side && user && <section className="arena-panel"><h2>Занять свободное место</h2><form onSubmit={join}><label>Код от создателя партии<input name="joinCode" required minLength={20} maxLength={100} autoComplete="off" /></label><label>Имя игрока / движка<input name="engineName" maxLength={50} placeholder={user.name} /></label><button className="button" disabled={busy}>Присоединиться</button></form></section>}
    {game.status === 'waiting' && vacancy && game.createdBy === user?.id && <button className="button button-outline" disabled={busy} onClick={() => action('invite')}>Новый код для соперника</button>}
    {ownSeat?.kind === 'bot' && game.status !== 'finished' && <section className="arena-panel"><h2>Подключение движка</h2><p className="arena-muted">Ключ управляет только твоим ботом в этой партии. Вызови ready из клиента перед стартом.</p><button className="button button-outline" disabled={busy} onClick={() => action('key')}>Выпустить ключ бота</button><p className="field-hint">Предыдущий ключ перестанет работать.</p><Link className="text-button" href="/arena/docs">Открыть документацию ↗</Link></section>}
    {secret && <section className="secret-box"><strong>{secret.label}</strong><code>{secret.value}</code><p>Не публикуй вместе со ссылкой зрителей.</p><button className="text-button" onClick={() => setSecret(null)}>Скрыть</button></section>}
    <section className="arena-panel move-panel"><h2>Запись партии <span>SAN</span></h2><div className="move-table">{Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, row) => <div key={row}><span>{row + 1}.</span>{[row * 2, row * 2 + 1].map(plyIndex => game.moves[plyIndex] ? <button key={plyIndex} disabled={game.status !== 'finished'} className={index === plyIndex + 1 ? 'active' : ''} onClick={() => setPly(plyIndex + 1)}>{game.moves[plyIndex].san}<small>{(game.moves[plyIndex].elapsedMs / 1000).toFixed(1)}с</small></button> : <span key={plyIndex} />)}</div>)}{!game.moves.length && <p className="arena-muted">Ходов пока нет.</p>}</div></section>
    {game.status === 'finished' && <ReviewPanel game={game} ply={index} onPly={setPly} authenticated={!!user} onAnalysis={analysis => setGame(previous => previous ? { ...previous, analysis } : previous)} />}
    </aside></div>
  </div>;
}
function PlayerBar({ game, side, now }: { game: GameView; side: Side; now: number }) {
  const player = game.seats[side];
  const running = game.status === 'playing' && game.turn === side;
  const remaining = Math.max(0, game.clocks[side] - (running && game.turnStartedAt ? Math.max(0, now - game.turnStartedAt) : 0));
  const totalSeconds = Math.ceil(remaining / 1000);
  const clock = game.format.initialMs <= 60000 && remaining < 10000 ? `0:${(Math.ceil(remaining / 100) / 10).toFixed(1).padStart(4, '0')}` : `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
  return <div className={`player-bar ${running ? 'running' : ''}`}><span className={`side-dot ${side === 'w' ? 'white' : 'black'}`} /><div><strong>{player.name}</strong><span>{player.kind === 'bot' ? 'BOT' : 'ЧЕЛОВЕК'}{game.status === 'waiting' && ` · ${player.ready ? 'Готов' : 'Не готов'}`}</span></div><time className={remaining < 10000 ? 'low-time' : ''}>{clock}</time></div>;
}
