// Real HTTP game: DeepNeuroBot vs DeepPatternBot, isolated DB, bounded smoke test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const python = process.env.DEEPMOVE_BOT_PYTHON || join(root, '.venv-bots', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
await access(python);
await access(join(root, '.next/BUILD_ID')).catch(() => { throw new Error('Run npm run build first'); });
const reports = join(root, 'test-results/learning-bots');
await mkdir(reports, { recursive: true });
const origin = 'http://127.0.0.1:3129';
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3129'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, APP_ORIGIN: origin, DEEPMOVE_DB: join(reports, `smoke-${randomUUID()}.sqlite`) },
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
const bots = [];
let botFailure;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(origin + '/api/arena')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.ok(ready, serverLog);
  async function post(path, body, cookie) {
    const response = await fetch(origin + '/api/arena' + path, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const white = await post('/register', { handle: 'test_neuro', name: 'DeepNeuroBot', password: 'local-test-password-white' });
  const black = await post('/register', { handle: 'test_pattern', name: 'DeepPatternBot', password: 'local-test-password-black' });
  const game = (await post('/games', {
    side: 'w', kind: 'bot', opponentKind: 'bot', format: 'arena', engineName: 'DeepNeuroBot', startDelaySeconds: 3,
  }, white.cookie)).data;
  await post(`/games/${game.id}/join`, { joinCode: game.joinCode, engineName: 'DeepPatternBot' }, black.cookie);
  const keys = {
    w: (await post(`/games/${game.id}/key`, {}, white.cookie)).data.token,
    b: (await post(`/games/${game.id}/key`, {}, black.cookie)).data.token,
  };
  function runBot(side, module) {
    const child = spawn(python, ['-m', module, 'play', '--url', origin, '--game', game.id, '--side', side,
      '--depth', '2', '--nodes', '256', '--max-think', '0.1'], {
      cwd: root, windowsHide: true, env: { ...process.env, DEEPMOVE_BOT_TOKEN: keys[side] },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bots.push(child);
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    return once(child, 'exit').then(([code]) => {
      assert.equal(code, 0, `${module} failed: ${error}`);
      return output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    }).catch(error => { botFailure = error; return []; });
  }
  const completion = [runBot('w', 'deepneuro_bot'), runBot('b', 'deeppattern_bot')];
  const deadline = Date.now() + 30000;
  let state;
  while (Date.now() < deadline) {
    if (botFailure) throw botFailure;
    state = await (await fetch(origin + `/api/arena/games/${game.id}`)).json();
    assert.notEqual(state.reason, 'timeout', 'Bot exceeded real arena deadline');
    if (state.moves.length >= 12 || state.status === 'finished') break;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  assert.ok(state.moves.length >= 12 || state.status === 'finished', 'Bots made no progress');
  if (state.status !== 'finished') await post(`/games/${game.id}/resign`, {}, white.cookie);
  const stopDeadline = Date.now() + 5000;
  while (bots.some(bot => bot.exitCode === null) && Date.now() < stopDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(bots.every(bot => bot.exitCode !== null), 'Bot did not exit after finished state');
  const logs = await Promise.all(completion);
  if (botFailure) throw botFailure;
  state = await (await fetch(origin + `/api/arena/games/${game.id}`)).json();
  assert.equal(state.status, 'finished');
  for (const key of Object.values(keys)) assert.ok(!JSON.stringify(state).includes(key));
  assert.ok(logs.every(records => records.some(record => record.move)), 'Both engines must make real moves');
  const report = { status: 'passed', bots: ['DeepNeuroBot', 'DeepPatternBot'], plies: state.moves.length,
    termination: state.reason, training: false, max_server_move_ms: Math.max(...state.moves.map(move => move.elapsedMs)),
    note: 'Explicit test resignation after 12 plies; transport check, not a strength result.' };
  await writeFile(join(reports, 'arena-smoke.pgn'), state.pgn, 'utf8');
  await writeFile(join(reports, 'arena-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const bot of bots) if (bot.exitCode === null) bot.kill();
  if (server.exitCode === null) server.kill();
}
