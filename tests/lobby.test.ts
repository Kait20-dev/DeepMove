import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Chess } from 'chess.js';
import { db, loadGame, saveGame } from '../src/server/db';
import { listGames } from '../src/server/games';
import { formats, type Game } from '../src/features/arena/types';

process.env.DEEPMOVE_DB = ':memory:';

function fixture(): Game {
  return {
    id: randomUUID(), createdBy: 'alice', joinHash: 'private-invitation', createdAt: 1700000000000,
    status: 'finished', result: '1/2-1/2', reason: 'repetition',
    seats: {
      w: { userId: 'alice', name: 'Alice', kind: 'bot', ready: true, tokenHash: 'private-white-key' },
      b: { userId: 'bob', name: 'Bob', kind: 'human', ready: true, tokenHash: null },
    },
    format: { ...formats.hardbullet }, moves: [], clocks: { w: 15000, b: 15000 },
    turnStartedAt: null, startDelayMs: 8000, startsAt: null, version: 1,
  };
}

test('lobby exposes a fixed card projection without histories, analysis, or credentials', () => {
  db().exec('DELETE FROM games');
  const game = fixture(), chess = new Chess();
  for (let index = 0; index < 128; index++) {
    const uci = ['g1f3', 'g8f6', 'f3g1', 'f6g8'][index % 4];
    const move = chess.move(uci);
    game.moves.push({ uci, san: move.san, fen: chess.fen(), elapsedMs: 100, remainingMs: 14000 });
  }
  game.analysis = { engine: 'private-heavy-analysis', depth: 12, createdAt: 1, moves: [], accuracy: { w: 100, b: 100 }, methodology: 'not needed by cards' };
  saveGame(game);
  const [summary] = listGames();
  assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'format', 'id', 'moveCount', 'reason', 'result', 'seats', 'status']);
  assert.equal(summary.moveCount, 128);
  assert.deepEqual(summary.seats, {
    w: { userId: 'alice', name: 'Alice', kind: 'bot', ready: true },
    b: { userId: 'bob', name: 'Bob', kind: 'human', ready: true },
  });
  assert.deepEqual(summary.format, game.format);
  const publicJson = JSON.stringify(summary);
  for (const omitted of ['private-', 'tokenHash', 'joinHash', 'moves', 'analysis', 'pgn', 'legalMoves', 'fen', 'clocks']) {
    assert.ok(!publicJson.includes(omitted), `lobby must omit ${omitted}`);
  }
  assert.equal(loadGame(game.id).moves.length, 128, 'projection does not alter archived data');
});

test('lobby polls still settle countdowns and exact HardBullet deadlines, and persist the result', t => {
  db().exec('DELETE FROM games');
  const now = 1794741466431;
  t.mock.method(Date, 'now', () => now);
  const future = fixture(), active = fixture(), expired = fixture();
  for (const game of [future, active, expired]) {
    game.status = 'waiting'; game.result = '*'; game.reason = null; game.version = 0;
  }
  future.startsAt = now + 1000;
  active.startsAt = now - 50;
  expired.startsAt = now - 1000;
  [future, active, expired].forEach(saveGame);
  const summaries = listGames();
  assert.equal(summaries.find(game => game.id === future.id)?.status, 'waiting');
  assert.equal(summaries.find(game => game.id === active.id)?.status, 'playing');
  assert.equal(summaries.find(game => game.id === expired.id)?.status, 'finished');
  const savedActive = loadGame(active.id), savedExpired = loadGame(expired.id);
  assert.equal(savedActive.turnStartedAt, active.startsAt);
  assert.equal(savedActive.version, 1);
  assert.equal(savedExpired.result, '0-1');
  assert.equal(savedExpired.reason, 'timeout');
  assert.equal(savedExpired.timeout?.deadlineAt, now);
  assert.equal(savedExpired.timeout?.remainingMs, 14000);
  assert.equal(savedExpired.moves.length, 0);
});

test('lobby lists at most the latest fifty games in updated order', () => {
  db().exec('DELETE FROM games');
  const games = Array.from({ length: 52 }, fixture);
  games.forEach((game, index) => {
    saveGame(game);
    db().prepare('UPDATE games SET updated_at=? WHERE id=?').run(1000 + index, game.id);
  });
  const summaries = listGames();
  assert.equal(summaries.length, 50);
  assert.deepEqual(summaries.map(game => game.id), games.slice(2).reverse().map(game => game.id));
});
