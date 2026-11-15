import { randomUUID } from 'node:crypto';
import { db, loadGame, saveGame, transaction } from './db';
import { ensure, text } from './errors';
import { hash, secret, sessionUser } from './auth';
import { applyMove, finish, opposite, settleClock, viewGame } from '@/features/arena/rules';
import { formats, type Game, type GameView, type Side, type TimeFormat, type UserView } from '@/features/arena/types';

export function getGame(id: string): GameView {
  return transaction(() => {
    const game = loadGame(id), now = Date.now();
    const version = game.version;
    settleClock(game, now);
    if (version !== game.version) saveGame(game);
    return viewGame(game, now);
  });
}
export function listGames(): GameView[] {
  const rows = db().prepare('SELECT id FROM games ORDER BY updated_at DESC LIMIT 50').all() as { id: string }[];
  return rows.map(row => getGame(row.id));
}
function validateFormat(input: Record<string, unknown>): TimeFormat {
  if (input.format !== 'custom') {
    ensure(typeof input.format === 'string' && Object.hasOwn(formats, input.format), 400, 'Неизвестный формат');
    return { ...formats[input.format] };
  }
  const { initialSeconds, incrementSeconds, botMoveSeconds } = input;
  ensure(Number.isInteger(initialSeconds) && Number(initialSeconds) >= 30 && Number(initialSeconds) <= 7200, 400, 'Время: от 30 до 7200 секунд');
  ensure(Number.isInteger(incrementSeconds) && Number(incrementSeconds) >= 0 && Number(incrementSeconds) <= 60, 400, 'Добавление: от 0 до 60 секунд');
  ensure(botMoveSeconds === null || Number.isInteger(botMoveSeconds) && Number(botMoveSeconds) >= 1 && Number(botMoveSeconds) <= 60, 400, 'Лимит хода бота: 1–60 секунд или null');
  return { name: 'Свой формат', initialMs: Number(initialSeconds) * 1000, incrementMs: Number(incrementSeconds) * 1000, botMoveMs: botMoveSeconds === null ? null : Number(botMoveSeconds) * 1000 };
}
export function createGame(user: UserView, input: Record<string, unknown>): GameView & { joinCode: string } {
  const format = validateFormat(input);
  const startDelaySeconds = input.startDelaySeconds ?? 8;
  ensure(Number.isInteger(startDelaySeconds) && Number(startDelaySeconds) >= 3 && Number(startDelaySeconds) <= 120, 400, 'Задержка старта: от 3 до 120 секунд');
  ensure(input.side === 'w' || input.side === 'b', 400, 'Выберите цвет');
  ensure(['human', 'bot'].includes(String(input.kind)) && ['human', 'bot'].includes(String(input.opponentKind)), 400, 'Выберите тип игроков');
  return transaction(() => {
    const recent = db().prepare('SELECT data FROM games WHERE updated_at>?').all(Date.now() - 86400_000) as { data: string }[];
    ensure(recent.filter(row => { const g = JSON.parse(row.data) as Game; return g.createdBy === user.id && g.status !== 'finished'; }).length < 5, 409, 'Не больше 5 незавершённых партий на аккаунт');
    const side = input.side as Side;
    const kind = input.kind as 'human' | 'bot';
    const seat = { userId: user.id, name: input.engineName ? text(input.engineName, 1, 50, 'Название движка') : user.name, kind, ready: kind === 'human', tokenHash: null };
    const vacant = { userId: null, name: 'Ожидаем соперника', kind: input.opponentKind as 'human' | 'bot', ready: false, tokenHash: null };
    const joinCode = secret();
    const game: Game = { id: randomUUID(), joinHash: hash(joinCode), createdBy: user.id, createdAt: Date.now(), status: 'waiting', result: '*', reason: null, seats: side === 'w' ? { w: seat, b: vacant } : { w: vacant, b: seat }, format, moves: [], clocks: { w: format.initialMs, b: format.initialMs }, turnStartedAt: null, startDelayMs: Number(startDelaySeconds) * 1000, startsAt: null, version: 0 };
    saveGame(game);
    return { ...viewGame(game, Date.now()), joinCode };
  });
}
export function seatForUser(game: Game, userId: string): Side | null {
  return game.seats.w.userId === userId ? 'w' : game.seats.b.userId === userId ? 'b' : null;
}
export function actorSide(request: Request, game: Game): { side: Side; isBot: boolean } {
  const auth = request.headers.get('authorization');
  if (auth) {
    ensure(auth.startsWith('Bearer ') && auth.length <= 120, 401, 'Неверный ключ бота');
    const tokenHash = hash(auth.slice(7));
    const side = (['w', 'b'] as Side[]).find(side => game.seats[side].kind === 'bot' && game.seats[side].tokenHash === tokenHash);
    ensure(side, 403, 'Ключ не даёт доступа к этой партии', 'forbidden');
    return { side, isBot: true };
  }
  const user = sessionUser(request);
  ensure(user, 401, 'Требуется авторизация');
  const side = seatForUser(game, user.id);
  ensure(side, 403, 'Вы зритель: управление партией недоступно', 'spectator');
  return { side, isBot: false };
}
function maybeStart(game: Game, now: number) {
  if (game.status === 'waiting' && game.startsAt === null && game.seats.w.userId && game.seats.b.userId && game.seats.w.ready && game.seats.b.ready) {
    game.startsAt = now + game.startDelayMs;
    game.version++;
    settleClock(game, now);
  }
}
export function joinGame(id: string, user: UserView, input: Record<string, unknown>): GameView {
  return transaction(() => {
    const game = loadGame(id);
    ensure(game.status === 'waiting', 409, 'Места уже распределены');
    ensure(!seatForUser(game, user.id), 409, 'Вы уже участник этой партии');
    ensure(typeof input.joinCode === 'string' && hash(input.joinCode) === game.joinHash, 403, 'Нужен действующий код приглашения от создателя партии');
    const side = (['w', 'b'] as Side[]).find(side => !game.seats[side].userId);
    ensure(side, 409, 'Свободных мест нет');
    game.seats[side] = { ...game.seats[side], userId: user.id, name: input.engineName ? text(input.engineName, 1, 50, 'Название движка') : user.name, ready: game.seats[side].kind === 'human' };
    game.version++;
    maybeStart(game, Date.now());
    saveGame(game);
    return viewGame(game, Date.now());
  });
}
export function rotateGameInvite(id: string, user: UserView): { joinCode: string } {
  return transaction(() => {
    const game = loadGame(id);
    ensure(game.createdBy === user.id && game.status === 'waiting', 403, 'Приглашение доступно создателю до начала игры');
    const joinCode = secret(); game.joinHash = hash(joinCode); saveGame(game);
    return { joinCode };
  });
}
export function rotateBotKey(id: string, user: UserView): { token: string } {
  return transaction(() => {
    const game = loadGame(id);
    const side = seatForUser(game, user.id);
    ensure(side && game.seats[side].kind === 'bot', 403, 'Ключ доступен только владельцу бота');
    ensure(game.status !== 'finished', 409, 'Партия завершена');
    const token = secret();
    game.seats[side].tokenHash = hash(token);
    saveGame(game);
    return { token };
  });
}
export function gameAction(id: string, request: Request, action: string, input: Record<string, unknown>): GameView {
  return transaction(() => {
    const game = loadGame(id), now = Date.now();
    const actor = actorSide(request, game);
    settleClock(game, now);
    if (action === 'move') {
      ensure(actor.isBot === (game.seats[actor.side].kind === 'bot'), 403, 'Для бота используйте его Bearer-ключ');
      ensure(typeof input.move === 'string' && Number.isInteger(input.expectedPly), 400, 'Нужны move и expectedPly');
      if (game.status === 'playing') applyMove(game, actor.side, input.move, Number(input.expectedPly), now);
      else ensure(game.status === 'finished' && game.reason === 'timeout', 409, 'Партия не идёт');
    } else if (action === 'ready') {
      ensure(actor.isBot && game.status === 'waiting', 409, 'Готовность доступна боту перед стартом');
      game.seats[actor.side].ready = true; game.version++;
      maybeStart(game, now);
    } else if (action === 'resign') {
      ensure(game.status !== 'finished', 409, 'Партия уже завершена');
      finish(game, game.status === 'waiting' ? '1/2-1/2' : opposite(actor.side) === 'w' ? '1-0' : '0-1', game.status === 'waiting' ? 'cancelled' : 'resignation');
    } else ensure(false, 404, 'Неизвестное действие');
    saveGame(game);
    return viewGame(game, now);
  });
}
