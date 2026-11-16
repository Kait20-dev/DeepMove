import { createHmac, randomUUID } from 'node:crypto';
import { db, loadGame, saveGame, transaction } from './db';
import { hash, secret } from './auth';
import { botSeat, ownedBot } from './bots';
import { ensure } from './errors';
import { settleClock } from '@/features/arena/rules';
import { formats, type BotView, type Game, type Leaderboard, type SeriesView, type UserView } from '@/features/arena/types';

interface SeriesRecord {
  id: string; creatorId: string; createdAt: number; botA: BotView; botB: BotView | null;
  formatKey: string; startDelayMs: number; inviteHash: string; gameIds: string[];
  keyHashes: { a: string | null; b: string | null };
  completedView?: SeriesView;
}
function read(id: string): SeriesRecord {
  const row = db().prepare('SELECT data FROM series WHERE id=?').get(id) as { data: string } | undefined;
  ensure(row, 404, 'Серия не найдена');
  return JSON.parse(row.data);
}
function save(series: SeriesRecord) {
  db().prepare('INSERT INTO series(id,data,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(series.id, JSON.stringify(series), series.createdAt);
}
/** Called inside a transaction. Results enter both cups atomically after all four games. */
function snapshot(series: SeriesRecord): SeriesView {
  if (series.completedView) return series.completedView;
  const games = series.gameIds.map(id => {
    const game = loadGame(id), version = game.version;
    settleClock(game, Date.now());
    if (version !== game.version) saveGame(game);
    return game;
  });
  const finished = games.length === 4 && games.every(game => game.status === 'finished' && game.result !== '*' && game.reason !== 'cancelled');
  if (finished) for (const game of games) for (const side of ['w', 'b'] as const) {
    const seat = game.seats[side];
    const points = game.result === '1/2-1/2' ? .5 : game.result === (side === 'w' ? '1-0' : '0-1') ? 1 : 0;
    db().prepare('INSERT OR IGNORE INTO cup_results(series_id,game_id,bot_id,team_id,points) VALUES(?,?,?,?,?)').run(series.id, game.id, seat.botId!, seat.teamId || null, points);
  }
  const score = { a: 0, b: 0 };
  for (const game of games) if (game.status === 'finished' && game.result !== '*' && game.reason !== 'cancelled') {
    const aWhite = game.seats.w.botId === series.botA.id;
    const white = game.result === '1/2-1/2' ? .5 : game.result === '1-0' ? 1 : 0;
    score.a += aWhite ? white : 1 - white; score.b += aWhite ? 1 - white : white;
  }
  const view: SeriesView = { id: series.id, creatorId: series.creatorId, createdAt: series.createdAt, botA: series.botA, botB: series.botB, format: formats[series.formatKey], status: !series.botB ? 'inviting' : games.every(g => g.status === 'finished') ? 'finished' : 'playing', games: games.map((g, index) => ({ id: g.id, round: index + 1, white: g.seats.w.name, black: g.seats.b.name, status: g.status, result: g.result })), score, counted: finished };
  if (finished) { series.completedView = view; save(series); }
  return view;
}
export function createSeries(user: UserView, input: Record<string, unknown>) {
  return transaction(() => {
    const bot = ownedBot(user, input.botId);
    ensure(typeof input.format === 'string' && Object.hasOwn(formats, input.format), 400, 'Выберите формат серии');
    const delay = input.startDelaySeconds ?? 8;
    ensure(Number.isInteger(delay) && Number(delay) >= 3 && Number(delay) <= 120, 400, 'Задержка: 3–120 секунд');
    const active = (db().prepare("SELECT data FROM series WHERE json_extract(data,'$.creatorId')=? AND json_extract(data,'$.completedView.counted') IS NULL").all(user.id) as { data: string }[]).map(row => JSON.parse(row.data) as SeriesRecord).filter(s => !s.botB || s.gameIds.some(id => loadGame(id).status !== 'finished'));
    ensure(active.length < 5, 409, 'До 5 незавершённых серий на аккаунт');
    const invite = secret();
    const series: SeriesRecord = { id: randomUUID(), creatorId: user.id, createdAt: Date.now(), botA: bot, botB: null, formatKey: input.format, startDelayMs: Number(delay) * 1000, inviteHash: hash(invite), gameIds: [], keyHashes: { a: null, b: null } };
    save(series); return { series: snapshot(series), invite };
  });
}
export function joinSeries(id: string, user: UserView, input: Record<string, unknown>) {
  return transaction(() => {
    const series = read(id);
    ensure(!series.botB, 409, 'В серии уже есть соперник');
    ensure(series.creatorId !== user.id, 409, 'Соперника подключает другой участник');
    ensure(typeof input.invite === 'string' && hash(input.invite) === series.inviteHash, 403, 'Нужен действующий код приглашения серии');
    const bot = ownedBot(user, input.botId);
    // Revalidate the initiator's membership at acceptance, then freeze both entries.
    series.botA = ownedBot({ id: series.creatorId } as UserView, series.botA.id);
    ensure(!bot.teamId || bot.teamId !== series.botA.teamId, 409, 'Зачётная серия проводится между разными командами');
    series.botB = bot;
    const format = { ...formats[series.formatKey] };
    for (let round = 1; round <= 4; round++) {
      const a = botSeat(series.botA), b = botSeat(bot);
      const game: Game = { id: randomUUID(), createdAt: Date.now(), createdBy: user.id, joinHash: hash(secret()), status: 'waiting', result: '*', reason: null, seats: round % 2 ? { w: a, b } : { w: b, b: a }, format, moves: [], clocks: { w: format.initialMs, b: format.initialMs }, turnStartedAt: null, version: 0, startDelayMs: series.startDelayMs, startsAt: null, series: { id, round } };
      saveGame(game); series.gameIds.push(game.id);
    }
    save(series); return { series: snapshot(series) };
  });
}
export function getSeries(id: string) { return transaction(() => snapshot(read(id))); }
export function seriesInvite(id: string, user: UserView) {
  return transaction(() => {
    const series = read(id);
    ensure(series.creatorId === user.id && !series.botB, 403, 'Приглашением управляет создатель до принятия вызова');
    const invite = secret(); series.inviteHash = hash(invite); save(series);
    return { invite };
  });
}
export function listSeries() {
  return transaction(() => (db().prepare('SELECT data FROM series ORDER BY created_at DESC LIMIT 100').all() as { data: string }[]).map(row => snapshot(JSON.parse(row.data))));
}
export function previousRoundFinished(game: Game) {
  if (!game.series || game.series.round === 1) return true;
  const series = read(game.series.id);
  return series.gameIds.slice(0, game.series.round - 1).every(id => loadGame(id).status === 'finished');
}
function gameToken(key: string, id: string) { return createHmac('sha256', key).update(`deepmove-series-game:${id}`).digest('base64url'); }
export function seriesKey(id: string, user: UserView) {
  return transaction(() => {
    const series = read(id);
    const player = series.botA.ownerId === user.id ? 'a' : series.botB?.ownerId === user.id ? 'b' : null;
    ensure(player && series.botB, 403, 'Ключ доступен участнику после принятия приглашения');
    const key = secret(); series.keyHashes[player] = hash(key);
    const bot = player === 'a' ? series.botA : series.botB;
    for (const gameId of series.gameIds) {
      const game = loadGame(gameId);
      if (game.status === 'finished') continue;
      const side = game.seats.w.botId === bot.id ? 'w' : 'b';
      game.seats[side].tokenHash = hash(gameToken(key, gameId)); saveGame(game);
    }
    save(series); return { token: key };
  });
}
export function seriesConnection(id: string, request: Request) {
  return transaction(() => {
    const series = read(id), authorization = request.headers.get('authorization') || '';
    ensure(authorization.startsWith('Bearer ') && authorization.length <= 120, 401, 'Нужен Bearer-ключ серии');
    const key = authorization.slice(7), keyHash = hash(key);
    const player = series.keyHashes.a === keyHash ? 'a' : series.keyHashes.b === keyHash ? 'b' : null;
    ensure(player && series.botB, 403, 'Неверный или отозванный ключ серии');
    const view = snapshot(series);
    const current = view.games.find(game => game.status !== 'finished');
    const bot = player === 'a' ? series.botA : series.botB;
    const game = current ? loadGame(current.id) : null;
    return { status: view.status, counted: view.counted, round: current?.round ?? 4, score: view.score, gameId: current?.id ?? null, side: game ? game.seats.w.botId === bot.id ? 'w' : 'b' : null, token: game ? gameToken(key, game.id) : null };
  });
}
export function leaderboard(): Leaderboard {
  return transaction(() => {
    // Settle incomplete series too: a timeout can be the fourth result.
    const pending = db().prepare("SELECT data FROM series WHERE json_extract(data,'$.completedView.counted') IS NULL").all() as { data: string }[];
    for (const row of pending) snapshot(JSON.parse(row.data));
    const completedSeries = (db().prepare("SELECT COUNT(*) AS n FROM series WHERE json_extract(data,'$.completedView.counted')=1").get() as { n: number }).n;
    const pendingSeries = (db().prepare("SELECT COUNT(*) AS n FROM series WHERE json_extract(data,'$.completedView.counted') IS NULL").get() as { n: number }).n;
    const totals = `SUM(points) AS points,COUNT(*) AS played,SUM(points=1) AS wins,SUM(points=0.5) AS draws,SUM(points=0) AS losses`;
    const bots = db().prepare(`SELECT bots.id,bots.name,users.handle AS ownerHandle,teams.name AS teamName,${totals} FROM cup_results JOIN bots ON bots.id=cup_results.bot_id JOIN users ON users.id=bots.owner_id LEFT JOIN teams ON teams.id=bots.team_id GROUP BY bots.id ORDER BY points DESC,wins DESC,bots.name COLLATE NOCASE,bots.id`).all();
    const teams = db().prepare(`SELECT teams.id,teams.name,COUNT(DISTINCT bot_id) AS bots,${totals} FROM cup_results JOIN teams ON teams.id=cup_results.team_id GROUP BY teams.id ORDER BY points DESC,wins DESC,teams.name COLLATE NOCASE,teams.id`).all();
    return { bots, teams, completedSeries, pendingSeries } as unknown as Leaderboard;
  });
}
