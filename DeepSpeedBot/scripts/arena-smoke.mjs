// Real official API, isolated SQLite database, actual compiled engine + unchanged baseline.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const folder = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(folder, '..');
const python = process.env.DEEPSPEED_PYTHON || 'python';
const baselinePython = process.env.DEEPMOVE_BOT_PYTHON || join(root, 'DeepMoveBot', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await access(join(folder, 'build', process.platform === 'win32' ? 'deepspeed.exe' : 'deepspeed'));
await access(baselinePython);
await access(join(root, '.next/BUILD_ID'));
await mkdir(join(folder, 'reports'), { recursive: true });
const base = 'http://127.0.0.1:3127';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3127'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, APP_ORIGIN: base, DEEPMOVE_DB: join(folder, 'reports', `smoke-${randomUUID()}.sqlite`) },
});
let serverLog = '';
server.stdout.on('data', c => { serverLog = (serverLog + c).slice(-3000); });
server.stderr.on('data', c => { serverLog = (serverLog + c).slice(-3000); });
const bots = [], reports = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/arena')).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(ready, 'Isolated arena failed to start');
  async function post(path, body, cookie, token, expected = 200) {
    const response = await fetch(base + '/api/arena' + path, { method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(expected === 200 ? response.ok : response.status === expected, `${path}: HTTP ${response.status}`);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const accounts = [];
  for (const side of ['w', 'b']) accounts.push(await post('/register', { handle: `speed_${side}_${randomUUID().slice(0, 8)}`, name: `Speed test ${side}`, password: randomUUID() }));
  function runBot(side, game, token, native) {
    const executable = native ? python : baselinePython;
    const args = native ? ['run.py', '--url', base, '--game', game.id, '--side', side, '--single-core', '--mode', 'adaptive']
      : ['-m', 'deepmove_bot', 'play', '--url', base, '--game', game.id, '--side', side, '--max-think', '0.12', '--seed', '61'];
    const child = spawn(executable, args, { cwd: native ? folder : join(root, 'DeepMoveBot'), windowsHide: true,
      env: { ...process.env, [native ? 'DEEPSPEED_BOT_TOKEN' : 'DEEPMOVE_BOT_TOKEN']: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    bots.push(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
    return { child, done };
  }
  for (const [index, nativeSide] of ['w', 'b'].entries()) {
    const game = (await post('/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'custom', initialSeconds: 300, incrementSeconds: 0, botMoveSeconds: 3, startDelaySeconds: 3, engineName: nativeSide === 'w' ? 'DeepSpeedBot' : 'DeepMoveBot' }, accounts[0].cookie)).data;
    await post(`/games/${game.id}/join`, { joinCode: game.joinCode, engineName: nativeSide === 'b' ? 'DeepSpeedBot' : 'DeepMoveBot' }, accounts[1].cookie);
    const keys = {};
    for (const [i, side] of ['w', 'b'].entries()) keys[side] = (await post(`/games/${game.id}/key`, {}, accounts[i].cookie)).data.token;
    await post(`/games/${game.id}/move`, { move: 'e2e4', expectedPly: 0 }, null, keys.w, 409);
    const white = runBot('w', game, keys.w, nativeSide === 'w');
    const black = runBot('b', game, keys.b, nativeSide === 'b');
    const deadline = Date.now() + 180000;
    let state, truncated = false;
    while (Date.now() < deadline) {
      state = await (await fetch(base + `/api/arena/games/${game.id}`)).json();
      for (const token of Object.values(keys)) assert.ok(!JSON.stringify(state).includes(token), 'Secret leaked into public state');
      if (state.status === 'finished') break;
      assert.ok(white.child.exitCode === null && black.child.exitCode === null, 'Bot exited before match finished');
      if (state.moves.length > 300) { truncated = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    if (state.status !== 'finished') { truncated = true; await post(`/games/${game.id}/resign`, {}, accounts[0].cookie); }
    const outputs = await Promise.all([white.done, black.done]);
    for (const out of outputs) assert.equal(out.code, 0, out.stderr);
    state = await (await fetch(base + `/api/arena/games/${game.id}`)).json();
    assert.notEqual(state.reason, 'timeout', 'A bot violated the real server deadline');
    const native = outputs[nativeSide === 'w' ? 0 : 1].stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const searches = native.filter(line => line.event === 'move');
    assert.ok(searches.length > 2, 'Too few actual native searches');
    assert.ok(searches.some(line => line.event === 'move' && line.ponder_hit), 'No native ponder hit in real API game');
    assert.ok(native.some(line => line.event === 'finished'));
    const report = { native_side: nativeSide, result: state.result, reason: state.reason, plies: state.moves.length, truncated, format: state.format,
      max_server_move_ms: Math.max(...state.moves.map(m => m.elapsedMs)), native_summary: native.find(line => line.event === 'finished'),
      native_searches: searches.length, native_ponder_hits: searches.filter(line => line.ponder_hit).length,
      max_native_search_ms: Math.max(...searches.map(line => line.elapsed_ms)) };
    reports.push(report);
    await writeFile(join(folder, `reports/arena-${index + 1}.pgn`), state.pgn, 'utf8');
    await writeFile(join(folder, `reports/arena-${index + 1}.jsonl`), native.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8');
    console.log(JSON.stringify(report));
  }
  await writeFile(join(folder, 'reports/arena-smoke.json'), JSON.stringify({ status: 'passed', games: reports }, null, 2) + '\n');
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  for (const bot of bots) if (bot.exitCode === null) bot.kill();
  server.kill();
}
