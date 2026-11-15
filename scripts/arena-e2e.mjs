import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Chess } from 'chess.js';
import { once } from 'node:events';

const port = 3107, base = `http://127.0.0.1:${port}`;
await mkdir('test-results', { recursive: true });
const database = resolve(`test-results/arena-e2e-${Date.now()}.sqlite`);
let serverLog = '';
function startServer() {
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    windowsHide: true, env: { ...process.env, DEEPMOVE_DB: database, APP_ORIGIN: base }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { serverLog = (serverLog + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-6000); });
  return child;
}
let server = startServer();
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/arena`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, `Test server did not start: ${serverLog}`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const alice = await browser.newContext(), bob = await browser.newContext(), spectator = await browser.newContext();
  async function post(context, path, input = {}, expected = 200, headers = {}) {
    const response = await context.request.post(`${base}/api/arena${path}`, { data: input, headers: { Origin: base, ...headers } });
    const result = await response.json();
    assert.equal(response.status(), expected, `${path}: ${JSON.stringify(result)}`);
    return result;
  }
  const page = await alice.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/arena`);
  await page.getByRole('button', { name: 'Впервые здесь? Создать аккаунт' }).click();
  await page.getByLabel('Имя', { exact: true }).fill('E2E White');
  await page.getByLabel('Логин', { exact: true }).fill('e2e_white');
  await page.getByLabel('Пароль', { exact: true }).fill('e2e-password-white-123');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await page.getByRole('heading', { name: 'Новая партия', exact: true }).waitFor();
  await post(bob, '/register', { handle: 'e2e_black', name: 'E2E Black', password: 'e2e-password-black-123' });
  await page.getByLabel('Контроль времени').selectOption('rapid');
  const created = page.waitForResponse(response => response.url() === `${base}/api/arena/games` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Создать партию', exact: true }).click();
  const game = await (await created).json();
  await page.waitForURL(`${base}/arena/games/${game.id}`);
  await page.getByText('Готовим доску.', { exact: true }).waitFor();
  await post(bob, `/games/${game.id}/join`, { joinCode: 'incorrect' }, 403);
  const countdown = await post(bob, `/games/${game.id}/join`, { joinCode: game.joinCode });
  assert.equal(countdown.status, 'waiting');
  assert.equal(countdown.startDelayMs, 8000);
  assert.ok(countdown.startsAt > countdown.serverNow);
  const observer = await spectator.newPage(); observer.on('pageerror', error => errors.push(error.message));
  await observer.goto(`${base}/arena/games/${game.id}`);
  await observer.getByText('Ты зритель', { exact: true }).waitFor();
  await observer.locator('.start-countdown').waitFor();
  await observer.screenshot({ path: 'test-results/arena-countdown.png' });
  await post(alice, `/games/${game.id}/move`, { move: 'e2e4', expectedPly: 0 }, 409);
  const beforeStart = await (await spectator.request.get(`${base}/api/arena/games/${game.id}`)).json();
  assert.equal(beforeStart.clocks.w, 600000);
  assert.equal(beforeStart.moves.length, 0);
  await post(spectator, `/games/${game.id}/move`, { move: 'e2e4', expectedPly: 0 }, 401);
  const blackPage = await bob.newPage(); await blackPage.goto(`${base}/arena/games/${game.id}`);
  // Actual board input: Fool's mate, two isolated browser accounts.
  async function humanMove(player, from, to, expectedPly) {
    await player.waitForFunction(() => [...document.querySelectorAll('.board-toolbar span')].some(element => element.textContent.includes('Твой ход')));
    await player.getByRole('button', { name: new RegExp(`^${from},`) }).click();
    const accepted = player.waitForResponse(response => response.url().endsWith(`/games/${game.id}/move`) && response.request().method() === 'POST');
    await player.getByRole('button', { name: new RegExp(`^${to},`) }).click();
    const response = await accepted; assert.equal(response.status(), 200);
    assert.equal((await response.json()).moves.length, expectedPly + 1);
  }
  await humanMove(page, 'f2', 'f3', 0);
  await humanMove(blackPage, 'e7', 'e5', 1);
  await humanMove(page, 'g2', 'g4', 2);
  await humanMove(blackPage, 'd8', 'h4', 3);
  await observer.getByRole('heading', { name: '0-1', exact: true }).waitFor();
  const pgn = await (await spectator.request.get(`${base}/api/arena/games/${game.id}/pgn`)).text();
  const replay = new Chess(); replay.loadPgn(pgn); assert.equal(replay.isCheckmate(), true);
  await page.getByRole('button', { name: 'Анализировать партию', exact: true }).click();
  await page.getByText('Белые · точность', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'В начало партии', exact: true }).click();
  assert.equal(await page.locator('.chess-piece').count(), 32);
  await page.getByRole('button', { name: 'В конец партии', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'В начало партии', exact: true }).click();
  await page.waitForTimeout(500);
  const piece = page.locator('[data-piece-id="f2"]');
  const fromTransform = await piece.evaluate(element => getComputedStyle(element).transform);
  await page.getByRole('button', { name: 'Следующий ход', exact: true }).click();
  await page.waitForTimeout(100);
  const movingTransform = await piece.evaluate(element => getComputedStyle(element).transform);
  await page.waitForTimeout(450);
  const toTransform = await piece.evaluate(element => getComputedStyle(element).transform);
  assert.notEqual(movingTransform, fromTransform);
  assert.notEqual(movingTransform, toTransform, 'piece must visibly travel, not teleport');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await piece.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'В конец партии', exact: true }).click();
  await spectator.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await observer.getByRole('button', { name: 'Скопировать PGN', exact: true }).click();
  assert.equal((await observer.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), pgn.replaceAll('\r\n', '\n'));
  await observer.getByRole('button', { name: 'PGN скопирован', exact: true }).waitFor();
  await observer.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied for fallback test')) }); });
  await observer.getByRole('button', { name: 'PGN скопирован', exact: true }).click();
  assert.equal(await observer.getByLabel('PGN для ручного копирования').inputValue(), pgn);
  await observer.getByRole('button', { name: 'Закрыть', exact: true }).click();
  console.log('PASS: server countdown blocks moves without charging clocks; visible piece movement, reduced motion and PGN clipboard/fallback');
  const queuePage = await spectator.newPage();
  queuePage.on('pageerror', error => errors.push(error.message));
  let snapshotsRead = 0;
  await queuePage.route(`${base}/api/arena/games/${game.id}`, async route => {
    const count = snapshotsRead++ === 0 ? 0 : 2;
    const position = new Chess();
    for (const move of replay.history({ verbose: true }).slice(0, count)) position.move(move);
    const finalState = await (await spectator.request.get(`${base}/api/arena/games/${game.id}`)).json();
    const now = Date.now();
    await route.fulfill({ json: { ...finalState, moves: finalState.moves.slice(0, count), fen: position.fen(), status: 'playing', result: '*', reason: null, turn: position.turn(), legalMoves: position.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion || ''}`), analysis: null, startsAt: null, serverNow: now, turnStartedAt: now, version: count } });
  });
  await queuePage.goto(`${base}/arena/games/${game.id}`);
  await queuePage.getByText('Ожидаем первый ход', { exact: true }).waitFor();
  await queuePage.getByText('1. f3', { exact: true }).waitFor();
  await queuePage.getByText('1... e5', { exact: true }).waitFor();
  await queuePage.close();
  console.log('PASS: two moves in one network snapshot are shown one at a time');
  console.log('PASS: human vs human, spectator, real board input, PGN, finished-game review and local Stockfish');
  // Key-scoped bots: ready, stale moves, request races, total+per-move deadline.
  const botGame = await post(alice, '/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'arena', engineName: 'E2E Alpha', startDelaySeconds: 3 }, 201);
  await post(bob, `/games/${botGame.id}/join`, { joinCode: botGame.joinCode, engineName: 'E2E Beta' });
  const whiteKey = (await post(alice, `/games/${botGame.id}/key`)).token;
  const blackKey = (await post(bob, `/games/${botGame.id}/key`)).token;
  const publicState = await (await spectator.request.get(`${base}/api/arena/games/${botGame.id}`)).text();
  assert.ok(!publicState.includes(whiteKey) && !publicState.includes('tokenHash') && !publicState.includes('joinHash'));
  await post(spectator, `/games/${game.id}/ready`, {}, 403, { Authorization: `Bearer ${whiteKey}` });
  await post(alice, `/games/${botGame.id}/analysis`, {}, 409);
  await post(spectator, `/games/${botGame.id}/ready`, {}, 200, { Authorization: `Bearer ${whiteKey}` });
  const scheduled = await post(spectator, `/games/${botGame.id}/ready`, {}, 200, { Authorization: `Bearer ${blackKey}` });
  assert.equal(scheduled.status, 'waiting');
  await post(spectator, `/games/${botGame.id}/move`, { move: 'e2e4', expectedPly: 0 }, 409, { Authorization: `Bearer ${whiteKey}` });
  const sameStart = await post(spectator, `/games/${botGame.id}/ready`, {}, 200, { Authorization: `Bearer ${whiteKey}` });
  assert.equal(sameStart.startsAt, scheduled.startsAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, scheduled.startsAt - Date.now() + 25)));
  const requests = await Promise.all(['e2e4', 'd2d4'].map(move => spectator.request.post(`${base}/api/arena/games/${botGame.id}/move`, { data: { move, expectedPly: 0 }, headers: { Authorization: `Bearer ${whiteKey}` } })));
  assert.deepEqual(requests.map(response => response.status()).sort(), [200, 409]);
  await new Promise(resolve => setTimeout(resolve, 3100));
  const timeout = await (await spectator.request.get(`${base}/api/arena/games/${botGame.id}`)).json();
  assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.result, '1-0'); assert.equal(timeout.moves.length, 1);
  console.log('PASS: bot keys, readiness, cross-game denial, concurrent duplicate prevention, automatic 3-second forfeit');
  const pythonGame = await post(alice, '/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'arena' }, 201);
  await post(bob, `/games/${pythonGame.id}/join`, { joinCode: pythonGame.joinCode });
  const pythonWhiteKey = (await post(alice, `/games/${pythonGame.id}/key`)).token;
  const pythonBlackKey = (await post(bob, `/games/${pythonGame.id}/key`)).token;
  async function runPython(side, token) {
    const code = `import os\nfrom deepmove_client import DeepMoveClient\nc=DeepMoveClient(os.environ['DEEPMOVE_URL'],os.environ['DEEPMOVE_GAME'],os.environ['DEEPMOVE_BOT_TOKEN'],os.environ['DEEPMOVE_SIDE'])\nmoves=['f2f3','e7e5','g2g4','d8h4']\nr=c.play(lambda state,budget:moves[len(state['moves'])])\nassert r['result']=='0-1' and len(r['moves'])==4\nprint('ok')`;
    const child = spawn('python', ['-c', code], { cwd: resolve('clients'), windowsHide: true, env: { ...process.env, DEEPMOVE_URL: base, DEEPMOVE_GAME: pythonGame.id, DEEPMOVE_BOT_TOKEN: token, DEEPMOVE_SIDE: side }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 20000);
    try { const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0, `Python client failed: ${output}`); }
    finally { clearTimeout(timer); }
  }
  await Promise.all([runPython('w', pythonWhiteKey), runPython('b', pythonBlackKey)]);
  console.log('PASS: two real Python SDK processes play a legal bot-vs-bot game');
  // Profiles and invitation-only teams.
  await page.goto(`${base}/arena`); await page.getByRole('button', { name: 'Мой профиль', exact: true }).click();
  await page.getByLabel('О себе', { exact: true }).fill('An original test engine.'); await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByText('Профиль сохранён', { exact: true }).waitFor();
  const team = await post(alice, '/teams', { name: 'E2E Team' }, 201);
  await post(bob, `/teams/${team.id}/invite`, {}, 403);
  await post(bob, '/teams/join', { invite: team.invite });
  const dashboard = await (await alice.request.get(`${base}/api/arena`)).json();
  assert.equal(dashboard.teams.find(item => item.id === team.id).members.length, 2);
  const csrf = await alice.request.post(`${base}/api/arena/profile`, { data: { name: 'Hacked', bio: '' }, headers: { Origin: 'https://evil.example' } }); assert.equal(csrf.status(), 403);
  console.log('PASS: profile editing, team membership, owner-only invites, cross-origin rejection');
  // Responsive real pages, screenshots, logs and assets.
  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
    await observer.setViewportSize({ width, height });
    for (const [name, path] of [['lobby', '/arena'], ['game', `/arena/games/${game.id}`], ['docs', '/arena/docs']]) {
      await observer.goto(base + path, { waitUntil: 'networkidle' });
      assert.equal(await observer.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow at ${width}`);
      await observer.screenshot({ path: `test-results/arena-${name}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 3 viewport sizes × lobby/game/docs; no horizontal overflow or browser runtime errors');
  for (const context of [alice, bob, spectator]) await Promise.all(context.pages().map(page => page.close()));
  const exited = once(server, 'exit'); server.kill(); await exited;
  server = startServer();
  let restored;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await alice.request.get(`${base}/api/arena/games/${game.id}`); if (response.ok()) { restored = await response.json(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(restored?.result, '0-1'); assert.equal(restored?.moves.length, 4); assert.equal(restored?.analysis?.moves.length, 4);
  assert.equal((await (await alice.request.get(`${base}/api/arena/me`)).json()).user.handle, 'e2e_white');
  console.log('PASS: moves, result, analysis and authenticated session survive server restart');
  console.log('PASS: all arena end-to-end checks (isolated SQLite test database)');
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  await browser?.close(); server.kill();
}
