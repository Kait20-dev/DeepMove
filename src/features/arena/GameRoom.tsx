'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Eye, RotateCw, Link2, Zap, ListOrdered, Settings2 } from 'lucide-react';
import { api, statusLabel, reasonLabel } from './client';
import { ChessBoard } from './ChessBoard';
import { MaterialPanel, ReviewPanel } from './ReviewPanel';
import { AuthPanel } from './AuthPanel';
import { CopyPgn } from './CopyPgn';
import { boardPosition } from './board-position';
import { useBoardAnimations } from './board-motion';
import { material } from './rules';
import { CapturedPieces } from './CapturedPieces';
import { EvaluationBar } from './EvaluationBar';
import { MoveQualityBadge } from './MoveQualityBadge';
import { qualityNames } from './review-presentation';
import { clocksAtPly, clockText, moveTiming, timeoutFor, timeoutTitle, timeoutDescription, timeoutArrivalText } from './timing';
import type { GameView, MaterialSummary, Side, UserView } from './types';

export function GameRoom({ id }: { id: string }) {
  const [game, setGame] = useState<GameView | null>(null), [user, setUser] = useState<UserView | null>(null);
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0), [sync, setSync] = useState({ server: 0, local: 0 });
  const [ply, setPly] = useState<number | null>(null), [flipped, setFlipped] = useState(false);
  const [livePly, setLivePly] = useState<number | null>(null);
  const { animate, reduced, setEnabled } = useBoardAnimations();
  const lastAdvance = useRef(0);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [roomTab, setRoomTab] = useState<'review' | 'game' | null>(null);
  const moveList = useRef<HTMLDivElement>(null);
  const receive = useCallback((incoming: GameView) => {
    setGame(previous => !previous || incoming.id !== previous.id || incoming.serverNow >= previous.serverNow && incoming.version >= previous.version ? incoming : previous);
    setLivePly(previous => animate ? previous ?? incoming.moves.length : incoming.moves.length);
    setSync(previous => incoming.serverNow >= previous.server ? { server: incoming.serverNow, local: performance.now() } : previous);
  }, [animate]);
  useEffect(() => {
    let alive = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const incoming = await api<GameView>(`/games/${id}`, undefined, controller.signal); if (alive) { receive(incoming); setConnectionError(''); } }
      catch (error) { if (alive) setConnectionError((error as Error).message); }
      finally { if (alive) timer = setTimeout(poll, animate ? 1000 : 200); }
    };
    void poll();
    api<{ user: UserView | null }>('/me', undefined, controller.signal).then(data => { if (alive) setUser(data.user); }).catch(() => {});
    const invite = sessionStorage.getItem(`invite:${id}`);
    if (invite) { queueMicrotask(() => { if (alive) setSecret({ label: 'Код приглашения соперника', value: invite }); }); sessionStorage.removeItem(`invite:${id}`); }
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [id, receive, animate]);
  useEffect(() => { const interval = setInterval(() => setNow(sync.server + performance.now() - sync.local), 100); return () => clearInterval(interval); }, [sync]);
  useEffect(() => {
    if (!animate || !game || ply !== null || livePly === null || livePly >= game.moves.length) return;
    const wait = Math.max(0, lastAdvance.current + 480 - performance.now());
    const target = game.moves.length;
    const timer = setTimeout(() => {
      lastAdvance.current = performance.now();
      setLivePly(current => Math.min((current ?? target) + 1, target));
    }, wait);
    return () => clearTimeout(timer);
  }, [game, livePly, ply, animate]);
  const side: Side | null = game && user ? game.seats.w.userId === user.id ? 'w' : game.seats.b.userId === user.id ? 'b' : null : null;
  const index = game ? Math.min(ply ?? (animate ? livePly ?? game.moves.length : game.moves.length), game.moves.length) : 0;
  const { chess, pieces } = useMemo(() => boardPosition(game?.moves || [], index), [game, index]);
  const positionClocks = useMemo(() => game ? clocksAtPly(game, index) : { w: 0, b: 0 }, [game, index]);
  const shownMaterial = useMemo(() => material(chess), [chess]);
  const selectedTab = roomTab ?? (game?.status === 'waiting' && !game.startsAt ? 'game' : 'review');
  useEffect(() => {
    const list = moveList.current, active = list?.querySelector<HTMLElement>('.active');
    if (!list || !active || selectedTab !== 'review') return;
    const row = active.getBoundingClientRect(), frame = list.getBoundingClientRect();
    if (row.top < frame.top) list.scrollTop += row.top - frame.top;
    else if (row.bottom > frame.bottom) list.scrollTop += row.bottom - frame.bottom;
  }, [index, selectedTab, game?.moves.length]);
  useEffect(() => {
    if (game?.status !== 'finished') return;
    function navigate(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.altKey || event.ctrlKey || event.metaKey || target.closest('input,textarea,select,[contenteditable=true],.chess-board-wrap,[role=dialog]')) return;
      const targetPly = event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(game!.moves.length, index + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? null : undefined;
      if (targetPly === undefined) return;
      event.preventDefault(); setPly(targetPly);
    }
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [game, index]);
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
  function toggleAnimations() {
    setLivePly(game?.moves.length ?? null);
    lastAdvance.current = performance.now();
    setEnabled(!animate);
  }
  if (!game) return <div className="container arena-loading"><Link href="/arena">← На арену</Link><p role={connectionError ? 'alert' : 'status'}>{connectionError || 'Открываем партию…'}</p></div>;
  const orientation: Side = flipped ? side === 'b' ? 'w' : 'b' : side || 'w';
  const ownSeat = side ? game.seats[side] : null;
  const stale = !sync.server || now - sync.server > 3500;
  const canMove = !!side && ownSeat?.kind === 'human' && game.status === 'playing' && game.turn === side && index === game.moves.length && !stale && !connectionError;
  const starting = game.status === 'waiting' && game.startsAt !== null;
  const startSeconds = starting ? Math.max(0, Math.ceil((game.startsAt! - (now || game.serverNow)) / 1000)) : 0;
  const vacancy = !game.seats.w.userId || !game.seats.b.userId;
  const historical = ply !== null || index < game.moves.length;
  const shownClocks = historical ? positionClocks : game.clocks;
  const timeout = timeoutFor(game);
  function join(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void action('join', Object.fromEntries(new FormData(event.currentTarget))); }
  const currentAnalysis = game.status === 'finished' ? game.analysis?.moves[index - 1] : undefined;
  const mateWinner: Side | undefined = chess.isCheckmate() ? chess.turn() === 'w' ? 'b' : 'w' : undefined;
  const resultText = timeout ? timeoutTitle(timeout) : reasonLabel[game.reason || ''] || game.reason;
  return <div className="container game-room">
    <div className="room-top">
      <Link href="/arena"><ArrowLeft size={15} /> На арену</Link>
      <span className={`game-status ${game.status}`}>{statusLabel[game.status]}</span>
      {game.status === 'finished' && <span className="mobile-result">{game.result}</span>}
      <span className="arena-muted">{game.format.name}</span>
      <button className="text-button spectator-link" aria-label="Пригласить зрителей" title="Пригласить зрителей" onClick={copyLink}><Link2 size={16} /><span className="share-label">Пригласить зрителей</span></button>
    </div>
    {copyMessage && <p role="status" className="room-notice field-hint">{copyMessage}</p>}
    {connectionError && <p role="alert" className="room-notice arena-error">Связь потеряна: {connectionError}. Часы на сервере продолжают идти.</p>}
    {error && <p role="alert" className="room-notice arena-error">{error}</p>}
    <div className="room-layout">
      <div className="board-column">
        <PlayerBar game={game} side={orientation === 'w' ? 'b' : 'w'} now={now} clocks={shownClocks} historical={historical} material={shownMaterial} />
        <div className="board-stage">
          <EvaluationBar move={currentAnalysis} orientation={orientation} checkmateWinner={mateWinner} finished={game.status === 'finished'} />
          <div className="countdown-board">
            <ChessBoard animate={animate} fen={chess.fen()} pieces={pieces} orientation={orientation} quality={currentAnalysis?.quality} legalMoves={canMove ? game.legalMoves : []} onMove={canMove ? move => action('move', { move, expectedPly: game.moves.length }) : undefined} busy={busy} lastMove={game.moves[index - 1]?.uci} />
            {starting && <div className="start-countdown" role="timer" aria-label={`До старта ${startSeconds} секунд`}><span>ОБА ИГРОКА ГОТОВЫ</span><strong>{startSeconds || 'Старт'}</strong><p>Приготовьтесь к первому ходу.<br />Часы ещё не идут.</p></div>}
          </div>
        </div>
        <PlayerBar game={game} side={orientation} now={now} clocks={shownClocks} historical={historical} material={shownMaterial} />
        <div className="position-caption">
          <div className="last-move-caption" aria-live="polite">{index ? <><span>Показанный ход</span><strong>{Math.ceil(index / 2)}{index % 2 ? '.' : '...'} {game.moves[index - 1].san}</strong></> : <span>{starting ? 'Старт после обратного отсчёта' : 'Ожидаем первый ход'}</span>}</div>
          {index > 0 && <p className="selected-move-timing" title={moveTiming(game.moves[index - 1])}>{moveTiming(game.moves[index - 1])}</p>}
          {game.status === 'finished' && <p className="replay-clock-note">{historical ? index ? 'Часы после показанного хода' : 'Часы перед первым ходом' : 'Часы на момент завершения партии'}</p>}
        </div>
      </div>
      <aside className="room-sidebar" aria-label="Партия и разбор">
        <section className="game-state">
          <div><span className="arena-kicker">{game.status === 'finished' ? 'РЕЗУЛЬТАТ' : 'ПАРТИЯ'}</span><h1>{game.status === 'finished' ? game.result : starting ? `Старт через ${startSeconds} с` : game.status === 'waiting' ? 'Готовим доску.' : game.turn === 'w' ? 'Ход белых.' : 'Ход чёрных.'}</h1></div>
          <p className="arena-muted">{game.status === 'finished' ? resultText : game.status === 'playing' ? game.deadline ? `До дедлайна: ${Math.max(0, (game.deadline - now) / 1000).toFixed(1)} с` : 'Время и ходы подтверждает сервер.' : starting ? 'Часы ещё не идут' : 'Подключение игроков'}</p>
          <details className="result-details"><summary aria-label="Подробнее о партии">ⓘ</summary><div className="result-popover">
            <strong>{game.format.name}</strong>
            {timeout && <div className="timeout-details timeout-event"><strong>{timeoutTitle(timeout)}</strong><p>{timeoutDescription(timeout)}</p><p className="timeout-arrival">{timeoutArrivalText(timeout)}</p><p>В списке указано время уже принятых ходов. Следующий ход до дедлайна не поступил.{game.result === '1/2-1/2' && ' Ничья: у соперника недостаточно материала для возможного мата.'}</p></div>}
            {game.format.botMoveMs !== null && <p className="field-hint">{game.format.humanMoveMs === game.format.botMoveMs ? 'Лимит каждого хода' : 'Лимит одного хода бота'}: {game.format.botMoveMs / 1000} с. Это ограничение, не добавление времени.</p>}
            {game.status === 'waiting' && <p className="field-hint">После готовности обоих игроков будет {game.startDelayMs / 1000} секунд на подготовку. До конца отсчёта ходы заблокированы, время не расходуется.</p>}
          </div></details>
        </section>
        <div className="room-tabs" role="tablist" aria-label="Панель партии" onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault(); event.stopPropagation();
          const next = selectedTab === 'review' ? 'game' : 'review'; setRoomTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}>
          <button type="button" id="review-tab" data-tab="review" role="tab" aria-selected={selectedTab === 'review'} aria-controls="room-review" tabIndex={selectedTab === 'review' ? 0 : -1} onClick={() => setRoomTab('review')}><ListOrdered size={16} />Ходы и разбор</button>
          <button type="button" id="game-tab" data-tab="game" role="tab" aria-selected={selectedTab === 'game'} aria-controls="room-game" tabIndex={selectedTab === 'game' ? 0 : -1} onClick={() => setRoomTab('game')}><Settings2 size={15} />Партия</button>
        </div>
        <div className="review-workspace" id="room-review" role="tabpanel" aria-labelledby="review-tab" hidden={selectedTab !== 'review'}>
          {game.status === 'finished' && <ReviewPanel game={game} ply={index} onPly={setPly} authenticated={!!user} onAnalysis={analysis => setGame(previous => previous ? { ...previous, analysis } : previous)} />}
          <section className="arena-panel move-panel">
            <h2>Запись партии <span>{game.moves.length} полуходов · SAN</span></h2>
            <div className="move-table" ref={moveList} tabIndex={0} aria-label="Ходы партии" role="region">
              {Array.from({ length: Math.ceil(game.moves.length / 2) }, (_, row) => <div key={row}><span>{row + 1}.</span>{[row * 2, row * 2 + 1].map(plyIndex => {
                const record = game.moves[plyIndex], analysis = game.status === 'finished' ? game.analysis?.moves[plyIndex] : undefined;
                return record ? <button key={plyIndex} title={`${analysis ? `${qualityNames[analysis.quality]}. ` : ''}${moveTiming(record)}`} disabled={game.status !== 'finished'} aria-current={index === plyIndex + 1 ? 'step' : undefined} className={index === plyIndex + 1 ? 'active' : ''} onClick={() => setPly(plyIndex + 1)}>
                  <span className="move-san">{analysis && <MoveQualityBadge quality={analysis.quality} />}{record.san}</span>
                  <small className="move-timing"><span>Ход: {(record.elapsedMs / 1000).toFixed(3)} с</span><span>Ост.: {clockText(record.remainingMs, true)}</span></small>
                </button> : <span key={plyIndex} />;
              })}</div>)}
              {!game.moves.length && <p className="arena-muted">Ходов пока нет.</p>}
            </div>
          </section>
          {game.status === 'finished' && <ReplayControls index={index} total={game.moves.length} final={ply === null} onPly={setPly} />}
        </div>
        <div className="game-details" id="room-game" role="tabpanel" aria-labelledby="game-tab" hidden={selectedTab !== 'game'}>
          {game.status === 'waiting' && vacancy && !side && !user && <AuthPanel onAuth={setUser} />}
          {game.status === 'waiting' && vacancy && !side && user && <section className="arena-panel"><h2>Занять свободное место</h2><form onSubmit={join}><label>Код от создателя партии<input name="joinCode" required minLength={20} maxLength={100} autoComplete="off" /></label><label>Имя игрока / движка<input name="engineName" maxLength={50} placeholder={user.name} /></label><button className="button" disabled={busy}>Присоединиться</button></form></section>}
          {game.status === 'waiting' && vacancy && game.createdBy === user?.id && <button className="button button-outline" disabled={busy} onClick={() => action('invite')}>Новый код для соперника</button>}
          {game.series && <section className="arena-panel"><h2>Зачётная серия · {game.series.round} / 4</h2><p className="arena-muted">По две партии каждым цветом. Ключ коннектора и остальные партии — на странице серии.</p><Link className="text-button" href={`/arena/series/${game.series.id}`}>Открыть серию и счёт ↗</Link></section>}{ownSeat?.kind === 'bot' && !game.series && game.status !== 'finished' && <section className="arena-panel"><h2>Подключение движка</h2><p className="arena-muted">Ключ управляет только твоим ботом в этой партии. Вызови ready из клиента перед стартом.</p><button className="button button-outline" disabled={busy} onClick={() => action('key')}>Выпустить ключ бота</button><p className="field-hint">Предыдущий ключ перестанет работать.</p><Link className="text-button" href="/arena/docs">Открыть документацию ↗</Link></section>}
          {secret && <section className="secret-box"><strong>{secret.label}</strong><code>{secret.value}</code><p>Не публикуй вместе со ссылкой зрителей.</p><button className="text-button" onClick={() => setSecret(null)}>Скрыть</button></section>}
          {side && game.status !== 'finished' && <button className="text-button danger" disabled={busy} onClick={() => { if (window.confirm(game.status === 'waiting' && !game.series ? 'Отменить эту партию?' : 'Сдаться в этой партии?')) void action('resign'); }}>{game.status === 'waiting' && !game.series ? 'Отменить партию' : 'Сдаться'}</button>}
          <MaterialPanel chess={chess} />
          <p className="field-hint">{game.format.name}. Время и ходы подтверждает сервер. Отключение клиента не останавливает часы.</p>
        </div>
        <div className="board-toolbar">
          <span><Eye size={13} />{side ? ownSeat?.kind === 'bot' ? 'Ты управляешь ботом' : canMove ? 'Твой ход' : 'Ты участник' : 'Ты зритель'}{game.status === 'finished' && <small>← → перемотка</small>}</span>
          <button className="text-button" aria-label="Перевернуть доску" title="Перевернуть доску" onClick={() => setFlipped(!flipped)}><RotateCw size={16} /></button>
          <button type="button" className="text-button animation-toggle" role="switch" aria-label="Анимации фигур" aria-checked={animate} disabled={reduced} title={reduced ? 'Анимации отключены системной настройкой уменьшения движения' : 'Без анимаций доска сразу догоняет игру'} onClick={toggleAnimations}><Zap size={15} />Анимации: {animate ? 'вкл' : 'выкл'}</button>
          <CopyPgn pgn={game.pgn} compact />
          <a className="text-button" aria-label="Скачать PGN" title="Скачать PGN" href={`/api/arena/games/${id}/pgn`}><Download size={16} /></a>
        </div>
      </aside>
    </div>
  </div>;
}

function ReplayControls({ index, total, final, onPly }: { index: number; total: number; final: boolean; onPly: (ply: number | null) => void }) {
  return <div className="replay-controls"><div>
    <button aria-label="В начало партии" onClick={() => onPly(0)} disabled={!index}><ChevronsLeft /></button>
    <button aria-label="Предыдущий ход" onClick={() => onPly(Math.max(0, index - 1))} disabled={!index}><ChevronLeft /></button>
    <span>{index} / {total}</span>
    <button aria-label="Следующий ход" onClick={() => onPly(Math.min(total, index + 1))} disabled={index === total}><ChevronRight /></button>
    <button aria-label="В конец партии" onClick={() => onPly(null)} disabled={final && index === total}><ChevronsRight /></button>
  </div><input type="range" aria-label="Полуход партии" min={0} max={total} value={index} onChange={event => onPly(Number(event.target.value))} /></div>;
}

function PlayerBar({ game, side, now, clocks, historical, material }: { game: GameView; side: Side; now: number; clocks: Record<Side, number>; historical: boolean; material: MaterialSummary }) {
  const player = game.seats[side];
  const running = !historical && game.status === 'playing' && game.turn === side;
  const remaining = Math.max(0, clocks[side] - (running && game.turnStartedAt ? Math.max(0, now - game.turnStartedAt) : 0));
  const clock = clockText(remaining, historical || game.status === 'finished', game.format.initialMs <= 60000);
  return <div className={`player-bar ${running ? 'running' : ''}`} data-side={side}>
    <span className={`side-dot ${side === 'w' ? 'white' : 'black'}`} />
    <div className="player-identity"><div className="player-name"><strong title={player.name}>{player.name}</strong><span>{player.kind === 'bot' ? 'BOT' : 'ЧЕЛОВЕК'}{game.status === 'waiting' && ` · ${player.ready ? 'Готов' : 'Не готов'}`}</span></div><CapturedPieces summary={material} side={side} /></div>
    <time aria-label={`${side === 'w' ? 'Белые' : 'Чёрные'}: остаток времени`} className={remaining < 10000 ? 'low-time' : ''}>{clock}</time>
  </div>;
}
