// Real DeepSpeedBot vs DeepSpeedBot under lobby load, in an isolated database.
// Run after npm run build: node scripts/hardbullet-smoke.mjs [report.json]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { Chess } from 'chess.js';

const base = 'http://127.0.0.1:3137', root = process.cwd();
await mkdir('test-results', { recursive: true });
const database = resolve(`test-results/hardbullet-load-${Date.now()}.sqlite`);
const sql = new DatabaseSync(database);
sql.exec('CREATE TABLE games (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const position = new Chess(), history = [];
for (let ply = 0; ply < 128; ply++) {
  const uci = ['g1f3', 'g8f6', 'f3g1', 'f6g8'][ply % 4], move = position.move(uci);
  history.push({ uci, san: move.san, fen: position.fen(), elapsedMs: 100, remainingMs: 590000 });
}
for (let index = 0; index < 50; index++) {
  const game = { id: `archive-${index}`, createdAt: 1700000000000, createdBy: 'fixture', joinHash: 'fixture',
    status: 'finished', result: '1/2-1/2', reason: 'repetition',
    seats: Object.fromEntries(['w', 'b'].map(side => [side, { userId: side, name: side, kind: 'bot', ready: true, tokenHash: null }])),
    format: { name: 'Archive fixture', initialMs: 600000, incrementMs: 0, botMoveMs: null },
    moves: history, clocks: { w: 590000, b: 590000 }, turnStartedAt: null, startsAt: null, startDelayMs: 3000, version: 1 };
  sql.prepare('INSERT INTO games VALUES(?,?,?)').run(game.id, JSON.stringify(game), index);
}
sql.close();
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3137'], {
  cwd: root, windowsHide: true, env: { ...process.env, APP_ORIGIN: base, DEEPMOVE_DB: database }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '', stopLoad = false, loadPromise;
const children = [], lobbyTimings = [], reports = [];
server.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, input, cookie, token) {
  const response = await fetch(`${base}/api/arena${path}`, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(input) });
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${data.code}`);
  return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
function bot(side, game, token, ponder) {
  const child = spawn(process.env.DEEPSPEED_PYTHON || 'python', ['run.py', '--url', base, '--game', game.id, '--side', side,
    '--mode', 'adaptive', '--ponder', ponder, '--single-core'], { cwd: resolve('DeepSpeedBot'), windowsHide: true,
    env: { ...process.env, DEEPSPEED_BOT_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
  return { child, done };
}
try {
  let ready = false;
  for (let retry = 0; retry < 100; retry++) {
    try { if ((await fetch(`${base}/api/arena`)).ok) { ready = true; break; } } catch {}
    await delay(200);
  }
  assert.ok(ready, `Server failed to start: ${serverLog}`);
  const accounts = [];
  for (const side of ['w', 'b']) accounts.push(await post('/register', { handle: `hb_${side}_${randomUUID().slice(0, 8)}`, name: `Speed ${side}`, password: randomUUID() }));
  loadPromise = (async () => {
    while (!stopLoad) {
      const started = performance.now(), response = await fetch(`${base}/api/arena`);
      assert.ok(response.ok);
      const lobby = await response.json();
      assert.equal(lobby.games.length, 50);
      assert.ok(lobby.games.every(game => Number.isInteger(game.moveCount) && !('moves' in game) && !('pgn' in game)));
      lobbyTimings.push(performance.now() - started);
      await delay(100);
    }
  })();
  for (const ponder of ['off', 'adaptive']) {
    const game = (await post('/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'hardbullet', startDelaySeconds: 3 }, accounts[0].cookie)).data;
    await post(`/games/${game.id}/join`, { joinCode: game.joinCode }, accounts[1].cookie);
    const keys = [];
    for (const account of accounts) keys.push((await post(`/games/${game.id}/key`, {}, account.cookie)).data.token);
    const running = ['w', 'b'].map((side, index) => bot(side, game, keys[index], ponder));
    const until = Date.now() + 65000;
    let state;
    do {
      await delay(100);
      state = await (await fetch(`${base}/api/arena/games/${game.id}`)).json();
      assert.ok(state.status === 'finished' || running.every(bot => bot.child.exitCode === null), 'A bot exited mid-game');
    } while (state.status !== 'finished' && Date.now() < until);
    assert.equal(state.status, 'finished', 'HardBullet exceeded a minute');
    const outputs = await Promise.all(running.map(bot => bot.done));
    for (const out of outputs) assert.equal(out.code, 0, out.stderr);
    assert.ok(state.reason !== 'timeout' || state.timeout.kind === 'total', `Per-move timeout: ${JSON.stringify(state.timeout)}`);
    assert.ok(state.moves.every(move => move.elapsedMs < 1000));
    const replay = new Chess(); replay.loadPgn(state.pgn);
    assert.deepEqual(replay.history(), state.moves.map(move => move.san));
    const events = outputs.flatMap(out => out.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))).filter(event => event.event === 'move');
    assert.ok(events.some(event => event.accepted === true && Number.isFinite(event.move_http_ms)));
    reports.push({ ponder, result: state.result, reason: state.reason, timeoutKind: state.timeout?.kind ?? null, plies: state.moves.length,
      maxAcceptedMoveMs: Math.max(...state.moves.map(move => move.elapsedMs)),
      meanAcceptedMoveMs: +(state.moves.reduce((sum, move) => sum + move.elapsedMs, 0) / state.moves.length).toFixed(3),
      meanDecisionMs: +(events.reduce((sum, event) => sum + event.decision_ms, 0) / events.length).toFixed(3),
      maxMoveHttpMs: Math.max(...events.map(event => event.move_http_ms)),
      warnings: outputs.reduce((sum, out) => sum + out.stdout.split('"event": "warning"').length - 1, 0) });
    await writeFile(`test-results/hardbullet-${ponder}.pgn`, state.pgn);
    await writeFile(`test-results/hardbullet-${ponder}.jsonl`, outputs.map(out => out.stdout).join(''));
    console.log(JSON.stringify(reports.at(-1)));
  }
  stopLoad = true; await loadPromise;
  lobbyTimings.sort((a, b) => a - b);
  const report = { measuredAt: new Date().toISOString(), platform: process.platform, node: process.version,
    scenario: 'Two real HardBullet 15+0/1s games, 50 archived 128-ply fixtures, concurrent lobby reads every 100ms, isolated SQLite/production Next server',
    games: reports, lobby: { requests: lobbyTimings.length, medianMs: +lobbyTimings[Math.floor(lobbyTimings.length / 2)].toFixed(3), maxMs: +lobbyTimings.at(-1).toFixed(3) },
    limitations: 'Local integration validation, not Elo or a guarantee against overload/network faults. Both native engines single-core with default OS-allowed core selection.' };
  if (process.argv[2]) { await mkdir(dirname(process.argv[2]), { recursive: true }); await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(serverLog); throw error; }
finally {
  stopLoad = true;
  if (loadPromise) await loadPromise.catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill();
  server.kill();
}
