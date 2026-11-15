import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { randomUUID } from 'node:crypto';
import { applyMove, settleClock, viewGame, pgnFor, deadlineFor } from '../src/features/arena/rules';
import { formats, type Game, type Side } from '../src/features/arena/types';
import { analyzeGame, classifyLoss } from '../src/server/analysis';

function fixture(kind: 'human' | 'bot' = 'human', format = formats.arena): Game {
  return { id: randomUUID(), createdBy: 'alice', joinHash: 'secret-never-public', createdAt: 1700000000000, status: 'playing', result: '*', reason: null, seats: { w: { userId: 'alice', name: 'Alice', kind, ready: true, tokenHash: 'white-secret' }, b: { userId: 'bob', name: 'Bob', kind, ready: true, tokenHash: 'black-secret' } }, format: { ...format }, moves: [], clocks: { w: format.initialMs, b: format.initialMs }, turnStartedAt: 1000, version: 0 };
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
  assert.equal(classifyLoss(0), 'best'); assert.equal(classifyLoss(101), 'mistake'); assert.equal(classifyLoss(251), 'blunder');
});
test('real Stockfish analysis returns finite scores and notices the losing move', { timeout: 30000 }, async () => {
  const game = fixture(); play(game, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  const analysis = await analyzeGame(game);
  assert.equal(analysis.moves.length, 4);
  assert.equal(analysis.moves[2].quality, 'blunder');
  assert.equal(analysis.moves[3].mate, -1);
  for (const side of ['w', 'b'] as Side[]) assert.ok(analysis.accuracy[side]! >= 0 && analysis.accuracy[side]! <= 100);
  assert.ok(analysis.moves.every(move => Number.isFinite(move.evaluation) && Number.isFinite(move.loss)));
});
