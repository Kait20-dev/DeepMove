import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import { applyMove, settleClock, viewGame, pgnFor, deadlineFor, recordLateMove } from '../src/features/arena/rules';
import { formats, type Game, type Side } from '../src/features/arena/types';
import { analyzeGame, classifyLoss } from '../src/server/analysis';
import { clocksAtPly, clockText, timeoutArrivalText, timeoutFor } from '../src/features/arena/timing';

function fixture(kind: 'human' | 'bot' = 'human', format = formats.arena): Game {
  return { id: randomUUID(), createdBy: 'alice', joinHash: 'secret-never-public', createdAt: 1700000000000, status: 'playing', result: '*', reason: null, seats: { w: { userId: 'alice', name: 'Alice', kind, ready: true, tokenHash: 'white-secret' }, b: { userId: 'bob', name: 'Bob', kind, ready: true, tokenHash: 'black-secret' } }, format: { ...format }, moves: [], clocks: { w: format.initialMs, b: format.initialMs }, turnStartedAt: 1000, startDelayMs: 8000, startsAt: null, version: 0 };
}
function play(game: Game, moves: string[]) { for (const move of moves) applyMove(game, game.moves.length % 2 ? 'b' : 'w', move, game.moves.length, (game.turnStartedAt || 0) + 100); }
test('authority rejects illegal moves, wrong turn and stale requests without changing the board', () => {
  const game = fixture();
  assert.throws(() => applyMove(game, 'w', 'e2e5', 0, 1100), /Нелегальный/);
  assert.equal(game.moves.length, 0);
  assert.throws(() => applyMove(game, 'b', 'e7e5', 0, 1100), /соперника/);
  applyMove(game, 'w', 'e2e4', 0, 1200);
  assert.throws(() => applyMove(game, 'b', 'e7e5', 0, 1300), /устарела/);
  assert.equal(game.moves.length, 1);
  assert.equal(game.clocks.w, 599800);
});
test('bot limit is a 3s deadline, not an increment, including the exact boundary', () => {
  const game = fixture('bot');
  assert.equal(deadlineFor(game), 4000);
  applyMove(game, 'w', 'e2e4', 0, 3999);
  assert.equal(game.clocks.w, 597001);
  assert.equal(game.turnStartedAt, 3999);
  assert.throws(() => applyMove(game, 'b', 'e7e5', 1, 6999), /не идёт/);
  assert.equal(game.result, '1-0');
  assert.equal(game.reason, 'timeout');
  assert.equal(game.moves.length, 1);
});
test('HardBullet gives both humans and bots 15 seconds, with a strict one-second move limit and no increment', () => {
  assert.equal(formats.hardbullet.initialMs, 15000);
  assert.equal(formats.hardbullet.incrementMs, 0);
  for (const kind of ['bot', 'human'] as const) {
    const game = fixture(kind, formats.hardbullet);
    game.status = 'waiting'; game.startsAt = 5000; game.turnStartedAt = null;
    settleClock(game, 4999);
    assert.equal(game.status, 'waiting');
    assert.equal(deadlineFor(game), null);
    assert.deepEqual(game.clocks, { w: 15000, b: 15000 });
    settleClock(game, 5000);
    assert.equal(deadlineFor(game), 6000);
    applyMove(game, 'w', 'e2e4', 0, 5999);
    assert.equal(game.clocks.w, 14001);
    assert.equal(game.clocks.b, 15000);
    assert.equal(deadlineFor(game), 6999);
    assert.throws(() => applyMove(game, 'b', 'e7e5', 1, 6999), /не идёт/);
    assert.equal(game.reason, 'timeout');
    assert.equal(game.result, '1-0');
    assert.equal(game.moves.length, 1);
  }
});
test('HardBullet total clock takes priority when less than a second remains', () => {
  for (const kind of ['bot', 'human'] as const) {
    const game = fixture(kind, formats.hardbullet);
    game.clocks.w = 450;
    assert.equal(deadlineFor(game), 1450);
    applyMove(game, 'w', 'e2e4', 0, 1449);
    assert.equal(game.clocks.w, 1);
    const expired = fixture(kind, formats.hardbullet);
    expired.clocks.w = 450;
    settleClock(expired, 1450);
    assert.equal(expired.reason, 'timeout');
    assert.equal(expired.result, '0-1');
    assert.equal(expired.clocks.w, 0);
    assert.equal(expired.moves.length, 0);
  }
});
test('HardBullet PGN preserves the 15+0 control and one-second limits for both kinds of player', () => {
  const game = fixture('human', formats.hardbullet);
  applyMove(game, 'w', 'e2e4', 0, 1250);
  const pgn = pgnFor(game);
  const replay = new Chess(); replay.loadPgn(pgn);
  assert.equal(replay.getHeaders().TimeControl, '15+0');
  assert.equal(replay.getHeaders().BotMoveLimit, '1');
  assert.equal(replay.getHeaders().HumanMoveLimit, '1');
  assert.deepEqual(replay.history(), ['e4']);
});

test('timeout records the failed side and unaccepted ply separately from the last accepted move', () => {
  const game = fixture('bot', formats.hardbullet);
  applyMove(game, 'w', 'e2e4', 0, 1300);
  settleClock(game, 9000); // Late observation must still settle at the official deadline.
  assert.deepEqual(game.timeout, { side: 'b', kind: 'move', ply: 2, limitMs: 1000, remainingMs: 14000, deadlineAt: 2300 });
  assert.equal(game.moves.length, 1);
  assert.equal(game.moves[0].elapsedMs, 300);
  const saved = JSON.parse(JSON.stringify(game)) as Game;
  assert.deepEqual(viewGame(saved, 10000).timeout, game.timeout);
  delete saved.timeout;
  const { deadlineAt: _deadlineAt, ...legacyTimeout } = game.timeout!;
  void _deadlineAt;
  assert.deepEqual(timeoutFor(saved), legacyTimeout, 'old archives infer the cause but cannot recover unrecorded arrival times');
  const parsed = new Chess(); parsed.loadPgn(pgnFor(saved));
  assert.equal(parsed.getHeaders().TimeoutKind, 'move');
  assert.equal(parsed.getHeaders().TimeoutSide, 'b');
  assert.equal(parsed.getHeaders().TimeoutPly, '2');
  assert.equal(parsed.getHeaders().TimeoutRemainingMs, '14000');
  assert.deepEqual(parsed.history(), ['e4']);
});

test('total timeout wins ties with the move cap and old archives recover total exhaustion', () => {
  for (const remaining of [450, 1000]) {
    const game = fixture('bot', formats.hardbullet);
    game.clocks.w = remaining;
    settleClock(game, 2000);
    assert.deepEqual(game.timeout, { side: 'w', kind: 'total', ply: 1, limitMs: remaining, remainingMs: 0, deadlineAt: 1000 + remaining });
  }
  const game = fixture('human', formats.rapid);
  applyMove(game, 'w', 'e2e4', 0, 1300);
  settleClock(game, 601300);
  const { deadlineAt: _deadlineAt, ...expected } = game.timeout!;
  void _deadlineAt;
  delete game.timeout;
  assert.deepEqual(timeoutFor(game), expected);
  game.reason = 'checkmate';
  assert.equal(timeoutFor(game), null);
});

test('only the first legal late attempt records exact lateness, including a prior spectator settlement', () => {
  const game = fixture('bot', formats.hardbullet);
  applyMove(game, 'w', 'e2e4', 0, 1300);
  settleClock(game, 5000);
  const version = game.version;
  assert.match(timeoutArrivalText(game.timeout!), /пока не получен/);
  recordLateMove(game, 'w', 'g1f3', 1, 2400);
  recordLateMove(game, 'b', 'e7e5', 0, 2400);
  recordLateMove(game, 'b', 'e7e4', 1, 2400);
  recordLateMove(game, 'b', 'not-a-move', 1, 2400);
  recordLateMove(game, 'b', 'e7e5', 1, 2299);
  assert.equal(game.timeout!.lateMove, undefined);
  assert.equal(game.version, version);
  recordLateMove(game, 'b', 'e7e5', 1, 2379);
  assert.deepEqual(game.timeout!.lateMove, { uci: 'e7e5', receivedAt: 2379, delayMs: 79 });
  assert.match(timeoutArrivalText(game.timeout!), /Опоздание: 79 мс/);
  assert.equal(game.version, version + 1);
  recordLateMove(game, 'b', 'd7d5', 1, 9999);
  assert.equal(timeoutFor(game)!.lateMove!.delayMs, 79);
  assert.equal(game.moves.length, 1);
  assert.equal(game.result, '1-0');
  assert.deepEqual(game.clocks, { w: 14700, b: 14000 });
  const replay = new Chess(); replay.loadPgn(pgnFor(game));
  assert.equal(replay.getHeaders().LateMoveDelayMs, '79');
  assert.equal(replay.getHeaders().LateMove, 'e7e5');
  assert.deepEqual(replay.history(), ['e4']);
});

test('an exact-deadline late move has zero lateness and legacy archives remain unknown', () => {
  const game = fixture('bot', formats.hardbullet);
  settleClock(game, 2000);
  recordLateMove(game, 'w', 'e2e4', 0, 2000);
  assert.equal(game.timeout!.lateMove!.delayMs, 0);
  delete game.timeout;
  assert.match(timeoutArrivalText(timeoutFor(game)!), /не записывалось/);
  recordLateMove(game, 'w', 'e2e4', 0, 3000);
  assert.equal(game.timeout, undefined);
});

test('cached public position data refreshes after moves, late attempts and archive edits while clocks and analysis stay fresh', () => {
  const game = fixture('bot', formats.hardbullet);
  const first = viewGame(game, 1000);
  assert.equal(first.moves.length, 0);
  applyMove(game, 'w', 'e2e4', 0, 1300);
  assert.match(viewGame(game, 1400).pgn, /e4/);
  settleClock(game, 2300);
  const finished = viewGame(game, 2400);
  assert.ok(!finished.pgn.includes('LateMoveDelayMs'));
  recordLateMove(game, 'b', 'e7e5', 1, 2379);
  assert.match(viewGame(game, 2401).pgn, /LateMoveDelayMs "79"/);
  game.seats.w.name = 'Renamed archive';
  assert.match(viewGame(game, 2402).pgn, /Renamed archive/);
  game.clocks.w = 12345;
  game.seats.w.ready = false;
  const fresh = viewGame(game, 2403);
  assert.equal(fresh.serverNow, 2403);
  assert.equal(fresh.clocks.w, 12345);
  assert.equal(fresh.seats.w.ready, false);
  assert.ok(!JSON.stringify(fresh).includes('white-secret'));
});

test('replay clocks retain both sides, increments and the position before a final timeout', () => {
  const game = fixture('human', formats.blitz);
  assert.deepEqual(clocksAtPly(game, 0), { w: 180000, b: 180000 });
  applyMove(game, 'w', 'e2e4', 0, 1300);
  applyMove(game, 'b', 'e7e5', 1, 1700);
  applyMove(game, 'w', 'g1f3', 2, 2200);
  assert.deepEqual(clocksAtPly(game, 1), { w: 181700, b: 180000 });
  assert.deepEqual(clocksAtPly(game, 2), { w: 181700, b: 181600 });
  assert.deepEqual(clocksAtPly(game, 3), { w: 183200, b: 181600 });
  settleClock(game, 183800);
  assert.equal(game.clocks.b, 0);
  assert.equal(clocksAtPly(game, 3).b, 181600);
  assert.equal(clockText(12288, true), '0:12.288');
  assert.equal(clockText(59999, true), '0:59.999');
  assert.equal(clockText(60000, true), '1:00.000');
});
test('countdown blocks early moves and clocks start at the scheduled instant', () => {
  const game = fixture('bot');
  game.status = 'waiting'; game.turnStartedAt = null; game.startsAt = 9000;
  settleClock(game, 8999);
  assert.equal(game.status, 'waiting'); assert.equal(deadlineFor(game), null);
  assert.equal(game.clocks.w, 600000);
  assert.throws(() => applyMove(game, 'w', 'e2e4', 0, 8999), /обратный отсчёт/);
  settleClock(game, 9000);
  assert.equal(game.status, 'playing'); assert.equal(game.turnStartedAt, 9000);
  assert.equal(deadlineFor(game), 12000);
  applyMove(game, 'w', 'e2e4', 0, 9500);
  assert.equal(game.clocks.w, 599500);
});
test('a delayed read does not shift the scheduled start or forgive a bot timeout', () => {
  const game = fixture('bot');
  game.status = 'waiting'; game.turnStartedAt = null; game.startsAt = 9000;
  settleClock(game, 12000);
  assert.equal(game.status, 'finished'); assert.equal(game.reason, 'timeout');
  assert.equal(game.clocks.w, 597000); assert.equal(game.result, '0-1');
});
test('humans use total time; rapid gives a bot the same 10 minutes; blitz increments only accepted moves', () => {
  const human = fixture(); applyMove(human, 'w', 'e2e4', 0, 11000); assert.equal(human.clocks.w, 590000);
  const bot = fixture('bot', formats.rapid); applyMove(bot, 'w', 'e2e4', 0, 11000); assert.equal(bot.clocks.w, 590000);
  const blitz = fixture('bot', formats.blitz); applyMove(blitz, 'w', 'e2e4', 0, 2000); assert.equal(blitz.clocks.w, 181000);
  const total = fixture('bot'); total.clocks.w = 500; settleClock(total, 1500); assert.equal(total.result, '0-1'); assert.equal(total.clocks.w, 0);
});
test('PGN is replayable and includes canonical result, timing, en passant and castling', () => {
  const game = fixture(); play(game, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'e7d6', 'g1f3', 'g8f6', 'f1e2', 'f8e7', 'e1g1']);
  const pgn = pgnFor(game), parsed = new Chess(); parsed.loadPgn(pgn);
  assert.equal(parsed.fen(), game.moves.at(-1)?.fen);
  assert.match(pgn, /O-O/); assert.match(pgn, /\[%clk /); assert.match(pgn, /\[%emt /); assert.match(pgn, /\[BotMoveLimit "3"\]/);
  const mate = fixture(); play(mate, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(mate.result, '0-1'); assert.equal(mate.reason, 'checkmate');
  const replay = new Chess(); replay.loadPgn(pgnFor(mate)); assert.equal(replay.getHeaders().Result, '0-1');
});
test('threefold repetition is tracked from full history', () => {
  const game = fixture(); play(game, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
  assert.equal(game.reason, 'repetition'); assert.equal(game.result, '1/2-1/2');
});
test('public snapshot strips all secrets and correctly accounts for captured pieces', () => {
  const game = fixture(); play(game, ['e2e4', 'd7d5', 'e4d5']);
  const view = viewGame(game, 1400), json = JSON.stringify(view);
  for (const secret of ['secret-never-public', 'white-secret', 'black-secret', 'tokenHash', 'joinHash']) assert.ok(!json.includes(secret));
  assert.deepEqual(view.material.capturedByWhite, ['p']); assert.equal(view.material.balance, 1);
  assert.equal(view.legalMoves.includes('d8d5'), true);
});
test('promotion must be explicit and records the promoted piece', () => {
  const game = fixture();
  play(game, ['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2']);
  assert.throws(() => applyMove(game, 'w', 'b7a8', 8, 2000), /Нелегальный/);
  applyMove(game, 'w', 'b7a8n', 8, 2000);
  assert.equal(new Chess(game.moves.at(-1)?.fen).get('a8')?.type, 'n');
});
test('analysis refuses live games and classifies losses with documented boundaries', async () => {
  await assert.rejects(analyzeGame(fixture()), /после завершения/);
  assert.equal(classifyLoss(0), 'best'); assert.equal(classifyLoss(101), 'inaccuracy'); assert.equal(classifyLoss(251), 'blunder');
});
test('real Stockfish analysis returns finite scores and notices the losing move', { timeout: 30000 }, async () => {
  const game = fixture(); play(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  const analysis = await analyzeGame(game);
  assert.equal(analysis.version, 2);
  assert.equal(analysis.moves.length, 4);
  assert.equal(analysis.moves[2].quality, 'blunder');
  assert.equal(analysis.moves[3].mate, -1);
  for (const side of ['w', 'b'] as Side[]) assert.ok(analysis.accuracy[side]! >= 0 && analysis.accuracy[side]! <= 100);
  assert.ok(analysis.moves.every(move => Number.isFinite(move.evaluation) && Number.isFinite(move.loss)));
});

test('real Stockfish distinguishes catalogue theory and a compensated queen sacrifice', { timeout: 30000 }, async () => {
  const game = fixture();
  play(game, ['e2e4', 'e7e5', 'g1f3', 'd7d6', 'f1c4', 'c8g4', 'b1c3', 'g7g6', 'f3e5', 'g4d1', 'c4f7', 'e8e7', 'c3d5']);
  assert.equal(game.reason, 'checkmate');
  const analysis = await analyzeGame(game);
  assert.equal(analysis.moves[0].quality, 'book');
  assert.equal(analysis.moves[1].quality, 'book');
  assert.equal(analysis.moves[8].quality, 'brilliant');
  assert.equal(analysis.moves[8].san, 'Nxe5');
});
