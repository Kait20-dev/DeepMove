// Integration test for the real Python bot. Uses an isolated local database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const folder = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(folder, '..');
const python = process.env.DEEPMOVE_BOT_PYTHON || join(folder, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await access(python);
await access(join(root, '.next/BUILD_ID')).catch(() => { throw new Error('First run npm run build in the arena repository root'); });
await mkdir(join(folder, 'reports'), { recursive: true });
const base = 'http://127.0.0.1:3117';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3117'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, APP_ORIGIN: base, DEEPMOVE_DB: join(folder, 'reports', `smoke-${randomUUID()}.sqlite`) },
});
let log = '';
server.stdout.on('data', chunk => { log = (log + chunk).slice(-3000); });
server.stderr.on('data', chunk => { log = (log + chunk).slice(-3000); });
const bots = [];
let botFailure;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/arena')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Isolated arena did not start');
  async function post(path, body, cookie) {
    const response = await fetch(base + '/api/arena' + path, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const white = await post('/register', { handle: 'test_math_white', name: 'DeepMoveBot White', password: 'local-test-password-white' });
  const black = await post('/register', { handle: 'test_math_black', name: 'DeepMoveBot Black', password: 'local-test-password-black' });
  const game = (await post('/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'arena', engineName: 'DeepMoveBot White' }, white.cookie)).data;
  await post(`/games/${game.id}/join`, { joinCode: game.joinCode, engineName: 'DeepMoveBot Black' }, black.cookie);
  const keys = {
    w: (await post(`/games/${game.id}/key`, {}, white.cookie)).data.token,
    b: (await post(`/games/${game.id}/key`, {}, black.cookie)).data.token,
  };
  function runBot(side) {
    // Secrets are in environment only, never command-line args or test output.
    const child = spawn(python, ['-m', 'deepmove_bot', 'play', '--url', base, '--game', game.id, '--side', side, '--depth', '5', '--seed', side === 'w' ? '17' : '23'], {
      cwd: folder, windowsHide: true, env: { ...process.env, DEEPMOVE_BOT_TOKEN: keys[side] }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    const done = once(child, 'exit').then(([code]) => {
      assert.equal(code, 0, `Bot ${side} failed: ${error}`);
      return output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    }).catch(error => { botFailure = error; return []; });
    bots.push(child);
    return done;
  }
  const doneWhite = runBot('w'), doneBlack = runBot('b');
  let state;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (botFailure) throw botFailure;
    state = await (await fetch(base + `/api/arena/games/${game.id}`)).json();
    assert.notEqual(state.reason, 'timeout', 'Math bot exceeded the real 3-second deadline');
    if (state.moves.length >= 12 || state.status === 'finished') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(state.moves.length >= 12 || state.status === 'finished', 'Bots made no progress');
  if (state.status !== 'finished') await post(`/games/${game.id}/resign`, {}, white.cookie);
  const logs = (await Promise.all([doneWhite, doneBlack])).flat();
  if (botFailure) throw botFailure;
  state = await (await fetch(base + `/api/arena/games/${game.id}`)).json();
  assert.equal(state.status, 'finished');
  const serialized = JSON.stringify(state);
  for (const key of Object.values(keys)) assert.ok(!serialized.includes(key));
  const searches = logs.filter(line => Object.hasOwn(line, 'completed_depth'));
  assert.ok(searches.length >= 12);
  assert.ok(searches.every(line => line.move && Number.isFinite(line.elapsed_ms)));
  const report = {
    status: 'passed', plies: state.moves.length, format: state.format,
    termination: state.reason, note: 'Stopped by explicit test resignation after 12 plies; not a strength result.',
    min_completed_depth: Math.min(...searches.map(line => line.completed_depth)),
    max_search_ms: Math.max(...searches.map(line => line.elapsed_ms)),
    max_server_move_ms: Math.max(...state.moves.map(move => move.elapsedMs)),
    result: state.result,
  };
  await writeFile(join(folder, 'reports/arena-smoke.pgn'), state.pgn, 'utf8');
  await writeFile(join(folder, 'reports/arena-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(log);
  throw error;
} finally {
  for (const bot of bots) bot.kill();
  server.kill();
}
