// Run: node scripts/lobby-benchmark.mjs [report.json]
// Uses isolated in-memory fixtures; never opens the arena's live database.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Chess } from 'chess.js';

const require = createRequire(import.meta.url);
require('tsx/cjs');
process.env.DEEPMOVE_DB = ':memory:';
const { db, loadGame, saveGame, transaction } = require('../src/server/db.ts');
const { listGames } = require('../src/server/games.ts');
const { fullChess, material, pgnFor } = require('../src/features/arena/rules.ts');
const { formats } = require('../src/features/arena/types.ts');

const chess = new Chess(), moves = [];
for (let index = 0; index < 128; index++) {
  const uci = ['g1f3', 'g8f6', 'f3g1', 'f6g8'][index % 4];
  const move = chess.move(uci);
  moves.push({ uci, san: move.san, fen: chess.fen(), elapsedMs: 100, remainingMs: 590000 });
}
for (let index = 0; index < 50; index++) {
  saveGame({
    id: `lobby-benchmark-${index}`, createdAt: 1700000000000, createdBy: 'fixture', joinHash: 'fixture-secret',
    status: 'finished', result: '1/2-1/2', reason: 'repetition', format: formats.rapid,
    seats: Object.fromEntries(['w', 'b'].map(side => [side, { userId: side, name: side, kind: 'bot', ready: true, tokenHash: null }])),
    moves, clocks: { w: 590000, b: 590000 }, turnStartedAt: null, startDelayMs: 8000, startsAt: null, version: 1,
  });
}

// Reproduce the former lobby algorithm explicitly: replay every archive once for
// board/material and once for PGN, rather than calling the now-optimized viewGame.
function legacyListGames() {
  const rows = db().prepare('SELECT id FROM games ORDER BY updated_at DESC LIMIT 50').all();
  return rows.map(row => transaction(() => {
    const game = loadGame(row.id), position = fullChess(game);
    return { id: game.id, fen: position.fen(), pgn: pgnFor(game), material: material(position) };
  }));
}
function measure(fn, repetitions) {
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now(); fn(); samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { repetitions, minMs: +samples[0].toFixed(3), medianMs: +samples[Math.floor(samples.length / 2)].toFixed(3), maxMs: +samples.at(-1).toFixed(3) };
}
legacyListGames(); listGames();
const baseline = measure(legacyListGames, 5), optimized = measure(listGames, 25);
const report = {
  measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
  fixture: { games: 50, pliesPerGame: 128, status: 'finished', storage: 'isolated in-memory SQLite' },
  baseline: { algorithm: 'Former lobby: full board/material replay plus PGN replay for all archives', ...baseline },
  optimized: { algorithm: 'Explicit lobby summary projection with clock settlement, no history replay', ...optimized },
  medianSpeedup: +(baseline.medianMs / optimized.medianMs).toFixed(2),
  limitations: 'Local CPU measurements, not a network benchmark. Repeated legal knight cycles model long archives, including repeated positions. No chess-search settings or move-quality changes.',
};
if (process.argv[2]) { mkdirSync(dirname(process.argv[2]), { recursive: true }); writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report, null, 2));
