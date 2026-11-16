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
  await page.getByLabel('Контроль времени').selectOption('hardbullet');
  await page.getByText('15 секунд суммарно каждому. Максимум 1 секунда на ход — и боту, и человеку. Без добавления.', { exact: true }).waitFor();
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
  assert.equal(await page.locator('.move-table [data-quality=blunder]').count(), 1);
  await page.getByRole('button', { name: 'В начало партии', exact: true }).click();
  assert.equal(await page.locator('.board-review-marker').count(), 0);
  assert.match(await page.locator('.evaluation-bar').getAttribute('aria-label'), /недоступна/);
  for (let index = 0; index < 3; index++) await page.getByRole('button', { name: 'Следующий ход', exact: true }).click();
  assert.equal(await page.locator('.board-review-marker').getAttribute('data-square'), 'g4');
  assert.equal(await page.locator('.board-review-marker [data-quality=blunder]').count(), 1);
  assert.equal(await page.locator('.evaluation-fill').evaluate(element => element.style.bottom), '0px');
  await page.getByRole('button', { name: 'Перевернуть доску', exact: true }).click();
  assert.equal(await page.locator('.board-review-marker').evaluate(element => element.style.left), '12.5%');
  assert.equal(await page.locator('.evaluation-fill').evaluate(element => element.style.top), '0px');
  await page.getByRole('button', { name: 'Перевернуть доску', exact: true }).click();
  await page.locator('.room-top a').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('.replay-controls span').innerText(), '2 / 4');
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
  // A spectator can discard a large animation backlog and follow current snapshots.
  const fastContext = await browser.newContext();
  const fastPage = await fastContext.newPage();
  fastPage.on('pageerror', error => errors.push(error.message));
  const burst = new Chess();
  const burstMoves = ['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2', 'b7a8q', 'g2h1q', 'a8b8', 'h1g1', 'b8c8', 'g1f1'].map(uci => {
    const move = burst.move(uci);
    return { uci, san: move.san, fen: burst.fen(), elapsedMs: 100, remainingMs: 14000 };
  });
  let burstCount = 0;
  await fastPage.route(`${base}/api/arena/games/${game.id}`, async route => {
    const count = burstCount;
    const position = new Chess();
    for (const record of burstMoves.slice(0, count)) position.move(record.uci);
    const now = Date.now();
    await route.fulfill({ json: { ...game, moves: burstMoves.slice(0, count), fen: position.fen(), pgn: position.pgn(),
      format: { name: 'HardBullet Arena', initialMs: 15000, incrementMs: 0, botMoveMs: 1000, humanMoveMs: 1000 },
      clocks: { w: 15000, b: 15000 }, status: 'playing', result: '*', reason: null, turn: position.turn(), legalMoves: [],
      analysis: null, startsAt: null, serverNow: now, turnStartedAt: now, deadline: now + 1000, version: 100 + count } });
  });
  const caption = count => `${Math.ceil(count / 2)}${count % 2 ? '.' : '...'} ${burstMoves[count - 1].san}`;
  await fastPage.goto(`${base}/arena/games/${game.id}`);
  await fastPage.getByText('Ожидаем первый ход', { exact: true }).waitFor();
  const motionSwitch = fastPage.getByRole('switch', { name: 'Анимации фигур' });
  assert.equal(await motionSwitch.getAttribute('aria-checked'), 'true');
  burstCount = 10;
  await fastPage.getByText(caption(1), { exact: true }).waitFor();
  await motionSwitch.click();
  await fastPage.getByText(caption(10), { exact: true }).waitFor();
  assert.equal(await motionSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(await fastPage.locator('[data-piece-id="a2"]').getAttribute('data-square'), 'a8');
  assert.equal(await fastPage.locator('[data-piece-id="h7"]').getAttribute('data-square'), 'h1');
  for (const [pawn, queen] of [['a2', 'd1'], ['h7', 'd8']]) {
    assert.equal(await fastPage.locator(`[data-piece-id="${pawn}"] .chess-piece`).textContent(), await fastPage.locator(`[data-piece-id="${queen}"] .chess-piece`).textContent(), 'promotions must update instantly');
  }
  for (const captured of ['a8', 'h1']) assert.equal(await fastPage.locator(`[data-piece-id="${captured}"]`).evaluate(element => getComputedStyle(element).opacity), '0');
  assert.equal(await fastPage.locator('[data-piece-id="a2"]').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  burstCount = 11;
  await fastPage.getByText(caption(11), { exact: true }).waitFor({ timeout: 1500 });
  assert.equal(await fastPage.locator('.player-bar[data-side=w] .material-advantage').innerText(), '+3');
  assert.match(await fastPage.locator('.player-bar[data-side=w] .captured-glyphs').getAttribute('aria-label'), /конь/);
  assert.equal(await fastPage.locator('.evaluation-bar.unavailable').count(), 1, 'live positions never reveal engine analysis');
  assert.equal(await fastPage.locator('.board-review-marker').count(), 0);
  burstCount = 12;
  await fastPage.getByText(caption(12), { exact: true }).waitFor({ timeout: 1500 });
  await fastPage.waitForRequest(request => request.url() === `${base}/api/arena/games/${game.id}`);
  const pollStarted = Date.now();
  await fastPage.waitForRequest(request => request.url() === `${base}/api/arena/games/${game.id}`);
  assert.ok(Date.now() - pollStarted < 800, 'unanimated live view must poll faster than the one-second animation mode');
  await fastPage.reload();
  await fastPage.getByText(caption(12), { exact: true }).waitFor();
  assert.equal(await motionSwitch.getAttribute('aria-checked'), 'false', 'preference survives reload');
  const sibling = await fastContext.newPage();
  sibling.on('pageerror', error => errors.push(error.message));
  await sibling.goto(`${base}/arena/games/${game.id}`);
  const siblingSwitch = sibling.getByRole('switch', { name: 'Анимации фигур' });
  await siblingSwitch.waitFor();
  assert.equal(await siblingSwitch.getAttribute('aria-checked'), 'false', 'preference carries into another game view');
  await sibling.getByRole('button', { name: 'В начало партии', exact: true }).click();
  assert.equal(await sibling.locator('[data-piece-id="f2"]').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
  await motionSwitch.click();
  await fastPage.getByText(caption(12), { exact: true }).waitFor();
  await sibling.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Анимации фигур"]')?.getAttribute('aria-checked') === 'true');
  burstCount = 14;
  await fastPage.getByText(caption(13), { exact: true }).waitFor();
  await fastPage.getByText(caption(14), { exact: true }).waitFor();
  await fastPage.evaluate(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } }); });
  await motionSwitch.click();
  assert.equal(await motionSwitch.getAttribute('aria-checked'), 'false', 'switch still works when storage is blocked');
  await fastContext.close();
  // A long archive stays in a single viewport, with a separate move-list scroller.
  const reviewContext = await browser.newContext(), reviewPage = await reviewContext.newPage();
  reviewPage.on('pageerror', error => errors.push(error.message));
  const longPosition = new Chess(), longMoves = [];
  for (let index = 0; index < 128; index++) {
    const uci = ['g1f3', 'g8f6', 'f3g1', 'f6g8'][index % 4], move = longPosition.move(uci);
    longMoves.push({ uci, san: move.san, fen: longPosition.fen(), elapsedMs: 100, remainingMs: 600000 - Math.ceil((index + 1) / 2) * 100 });
  }
  const qualities = ['blunder', 'inaccuracy', 'good', 'best', 'book', 'great', 'brilliant'];
  await reviewPage.route(`${base}/api/arena/games/${game.id}`, route => route.fulfill({ json: {
    ...game, status: 'finished', result: '1/2-1/2', reason: 'repetition', moves: longMoves, fen: longPosition.fen(), turn: 'w',
    serverNow: Date.now(), version: 500, legalMoves: [], startsAt: null, turnStartedAt: null, timeout: null,
    analysis: { version: 2, engine: 'UI fixture', depth: 12, createdAt: Date.now(), accuracy: { w: 80, b: 85 }, methodology: 'Deterministic UI fixture',
      moves: longMoves.map((move, index) => ({ ply: index + 1, san: move.san, evaluation: index % 2 ? -1 : 1, mate: null, loss: 0, accuracy: 90, quality: qualities[index % qualities.length], bestMove: null })) },
  } }));
  await reviewPage.goto(`${base}/arena/games/${game.id}`);
  await reviewPage.locator('.move-table button').last().waitFor({ state: 'attached' });
  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844], [375, 667], [844, 390]]) {
    await reviewPage.setViewportSize({ width, height });
    const geometry = await reviewPage.evaluate(() => ({
      width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
      board: document.querySelector('.play-board').getBoundingClientRect().toJSON(),
      controls: document.querySelector('.replay-controls').getBoundingClientRect().toJSON(),
      list: document.querySelector('.move-table').getBoundingClientRect().toJSON(),
    }));
    assert.ok(geometry.pageHeight <= height + 1 && geometry.pageWidth <= width, `room must fit ${width}×${height}: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.controls.bottom <= height && geometry.board.bottom <= height);
    assert.ok(geometry.list.height >= 50, `move list must remain usable at ${width}×${height}`);
    const boardTop = geometry.board.top;
    await reviewPage.locator('.move-table').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await reviewPage.evaluate(() => window.scrollY), 0);
    assert.equal(await reviewPage.locator('.play-board').evaluate(element => element.getBoundingClientRect().top), boardTop);
    await reviewPage.locator('.move-table button').first().click();
    assert.equal(await reviewPage.locator('.board-review-marker [data-quality=blunder]').count(), 1);
    await reviewPage.getByRole('button', { name: 'В конец партии', exact: true }).click();
    await reviewPage.screenshot({ path: `test-results/arena-review-${width}.png` });
  }
  for (const quality of qualities) assert.ok(await reviewPage.locator(`.move-table [data-quality=${quality}]`).count() > 0);
  await reviewContext.close();
  console.log('PASS: quality icons, board markers, orientation-aware evaluation, immediate captured material, keyboard replay and single-viewport long archives');
  console.log('PASS: animation switch discards backlog, updates captures/promotions instantly, polls at 200ms, persists/syncs preferences and re-enables without rewinding');
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
  const hardGame = await post(alice, '/games', { side: 'w', kind: 'bot', opponentKind: 'bot', format: 'hardbullet', startDelaySeconds: 3 }, 201);
  assert.deepEqual(hardGame.clocks, { w: 15000, b: 15000 });
  assert.equal(hardGame.format.botMoveMs, 1000);
  assert.equal(hardGame.format.humanMoveMs, 1000);
  await post(bob, `/games/${hardGame.id}/join`, { joinCode: hardGame.joinCode });
  const hardWhite = (await post(alice, `/games/${hardGame.id}/key`)).token;
  const hardBlack = (await post(bob, `/games/${hardGame.id}/key`)).token;
  await post(spectator, `/games/${hardGame.id}/ready`, {}, 200, { Authorization: `Bearer ${hardWhite}` });
  const hardScheduled = await post(spectator, `/games/${hardGame.id}/ready`, {}, 200, { Authorization: `Bearer ${hardBlack}` });
  await post(spectator, `/games/${hardGame.id}/move`, { move: 'e2e4', expectedPly: 0 }, 409, { Authorization: `Bearer ${hardWhite}` });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, hardScheduled.startsAt - Date.now() + 25)));
  const hardMoved = await post(spectator, `/games/${hardGame.id}/move`, { move: 'e2e4', expectedPly: 0 }, 200, { Authorization: `Bearer ${hardWhite}` });
  assert.equal(hardMoved.status, 'playing');
  assert.ok(hardMoved.clocks.w < 15000);
  assert.equal(hardMoved.clocks.b, 15000);
  assert.equal(hardMoved.deadline - hardMoved.turnStartedAt, 1000);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, hardMoved.deadline - Date.now() + 30)));
  const hardFinished = await (await spectator.request.get(`${base}/api/arena/games/${hardGame.id}`)).json();
  assert.equal(hardFinished.result, '1-0');
  assert.equal(hardFinished.reason, 'timeout');
  assert.equal(hardFinished.moves.length, 1);
  assert.equal(hardFinished.clocks.b, 14000);
  const hardPgn = new Chess(); hardPgn.loadPgn(hardFinished.pgn);
  assert.equal(hardPgn.getHeaders().TimeControl, '15+0');
  assert.equal(hardPgn.getHeaders().BotMoveLimit, '1');
  assert.equal(hardPgn.getHeaders().HumanMoveLimit, '1');
  assert.deepEqual(hardFinished.timeout, { side: 'b', kind: 'move', ply: 2, limitMs: 1000, remainingMs: 14000, deadlineAt: hardMoved.deadline });
  const timingPage = await spectator.newPage();
  timingPage.on('pageerror', error => errors.push(error.message));
  await timingPage.goto(`${base}/arena/games/${hardGame.id}`);
  await timingPage.locator('.game-state>.arena-muted').getByText('Чёрные: истёк лимит на ход', { exact: true }).waitFor();
  await timingPage.getByLabel('Подробнее о партии', { exact: true }).click();
  assert.match(await timingPage.locator('.game-state .timeout-arrival').innerText(), /пока не получен/);
  assert.match(await timingPage.locator('.timeout-event').innerText(), /Ход 1\.\.\. не принят/);
  await timingPage.getByLabel('Подробнее о партии', { exact: true }).click();
  const whiteClock = timingPage.getByLabel('Белые: остаток времени', { exact: true });
  const blackClock = timingPage.getByLabel('Чёрные: остаток времени', { exact: true });
  const preciseClock = ms => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
  assert.equal(await blackClock.innerText(), '0:14.000');
  await timingPage.locator('.move-table button').first().click();
  await timingPage.getByText('Часы после показанного хода', { exact: true }).waitFor();
  assert.equal(await whiteClock.innerText(), preciseClock(hardMoved.moves[0].remainingMs));
  assert.equal(await blackClock.innerText(), '0:15.000', 'selected last move precedes the opponent timeout');
  await timingPage.getByRole('button', { name: 'В начало партии', exact: true }).click();
  assert.equal(await whiteClock.innerText(), '0:15.000');
  assert.equal(await blackClock.innerText(), '0:15.000');
  await timingPage.getByRole('button', { name: 'Следующий ход', exact: true }).click();
  assert.equal(await whiteClock.innerText(), preciseClock(hardMoved.moves[0].remainingMs));
  await timingPage.getByRole('button', { name: 'В конец партии', exact: true }).click();
  await timingPage.getByText('Часы на момент завершения партии', { exact: true }).waitFor();
  assert.equal(await blackClock.innerText(), '0:14.000');
  assert.match(await timingPage.locator('.move-timing').innerText(), /Ход: .* с\s+Ост.: 0:/);
  const lateAttempt = await post(spectator, `/games/${hardGame.id}/move`, { move: 'e7e5', expectedPly: 1, receivedAt: hardMoved.deadline - 10 }, 200, { Authorization: `Bearer ${hardBlack}` });
  assert.equal(lateAttempt.moves.length, 1);
  assert.equal(lateAttempt.result, '1-0');
  assert.equal(lateAttempt.timeout.lateMove.uci, 'e7e5');
  assert.equal(lateAttempt.timeout.lateMove.delayMs, lateAttempt.timeout.lateMove.receivedAt - hardMoved.deadline);
  assert.ok(lateAttempt.timeout.lateMove.delayMs > 0);
  await timingPage.getByLabel('Подробнее о партии', { exact: true }).click();
  await timingPage.locator('.game-state .timeout-arrival').getByText(new RegExp(`Опоздание: ${lateAttempt.timeout.lateMove.delayMs} мс`)).waitFor();
  const lateHeaders = new Chess(); lateHeaders.loadPgn(lateAttempt.pgn);
  assert.equal(lateHeaders.getHeaders().LateMoveDelayMs, String(lateAttempt.timeout.lateMove.delayMs));
  // Legacy snapshots must render the same explanation without a persisted timeout object.
  await timingPage.route(`${base}/api/arena/games/${hardGame.id}`, route => route.fulfill({ json: { ...hardFinished, timeout: undefined } }));
  await timingPage.reload();
  await timingPage.locator('.game-state>.arena-muted').getByText('Чёрные: истёк лимит на ход', { exact: true }).waitFor();
  await timingPage.getByLabel('Подробнее о партии', { exact: true }).click();
  assert.match(await timingPage.locator('.game-state .timeout-arrival').innerText(), /не записывалось/);
  await timingPage.unroute(`${base}/api/arena/games/${hardGame.id}`);
  await timingPage.route(`${base}/api/arena/games/${hardGame.id}`, route => route.fulfill({ json: { ...hardFinished, clocks: { ...hardFinished.clocks, b: 0 }, timeout: { side: 'b', kind: 'total', ply: 2, limitMs: 15000, remainingMs: 0 } } }));
  await timingPage.reload();
  await timingPage.locator('.game-state>.arena-muted').getByText('Чёрные: закончилось общее время', { exact: true }).waitFor();
  assert.equal(await blackClock.innerText(), '0:00.000');
  await timingPage.screenshot({ path: 'test-results/arena-timeout-replay.png' });
  await timingPage.close();
  console.log('PASS: timeout cause and failed ply, exact replay clocks for both sides, final timeout event, legacy archives and total-clock explanation');
  console.log('PASS: HardBullet UI preset, 15-second clocks, countdown, no increment, real one-second forfeit and PGN');
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
  await page.getByLabel('Организация', { exact: true }).fill('КАИТ №20');
  await page.getByLabel('Город', { exact: true }).fill('Москва');
  await page.getByLabel('Сайт', { exact: true }).fill('https://example.com');
  await page.getByLabel('Загрузить аватар', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: 'Убрать фото', exact: true }).waitFor();
  const profileSaved = page.waitForResponse(response => response.url().endsWith('/api/arena/profile') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.equal((await profileSaved).status(), 200);
  await page.getByRole('link', { name: 'Открыть публичный профиль' }).click();
  await page.waitForURL(`${base}/arena/players/e2e_white`);
  await page.getByText('КАИТ №20', { exact: true }).waitFor();
  await page.getByRole('img', { name: 'Аватар E2E White', exact: true }).waitFor();
  const aliasLogin = await alice.request.post(`${base}/api/arena/login`, { headers: { Origin: `http://localhost:${port}` }, data: { handle: 'e2e_white', password: 'e2e-password-white-123' } });
  assert.equal(aliasLogin.status(), 200, 'loopback alias login must work with configured APP_ORIGIN');
  const team = await post(alice, '/teams', { name: 'E2E Team' }, 201);
  await post(bob, `/teams/${team.id}/invite`, {}, 403);
  await post(bob, '/teams/join', { invite: team.invite });
  const dashboard = await (await alice.request.get(`${base}/api/arena`)).json();
  assert.equal(dashboard.teams.find(item => item.id === team.id).members.length, 2);
  const csrf = await alice.request.post(`${base}/api/arena/profile`, { data: { name: 'Hacked', bio: '' }, headers: { Origin: 'https://evil.example' } }); assert.equal(csrf.status(), 403);
  console.log('PASS: profile editing, team membership, owner-only invites, cross-origin rejection');
  // Real four-round series: browser registration, public spectator and Python SDK auto-colors.
  await post(bob, `/teams/${team.id}/leave`);
  const opponentTeam = await post(bob, '/teams', { name: 'E2E Opponents' }, 201);
  await page.goto(`${base}/arena?tab=bots`);
  await page.getByLabel('Название бота', { exact: true }).fill('E2E Series White');
  await page.getByLabel('Команда бота').selectOption(team.id);
  await page.getByLabel('Описание бота', { exact: true }).fill('Four-round connector test.');
  await page.getByRole('button', { name: 'Зарегистрировать', exact: true }).click();
  await page.getByText('Бот сохранён', { exact: true }).waitFor();
  const myBots = (await (await alice.request.get(`${base}/api/arena`)).json()).bots;
  const myBot = myBots.find(item => item.name === 'E2E Series White');
  const otherBot = (await post(bob, '/bots', { name: 'E2E Series Black', teamId: opponentTeam.id }, 201)).bot;
  await post(bob, `/bots/${myBot.id}`, { name: 'Hijacked' }, 403);
  await page.getByRole('button', { name: 'Кубки и зачёты', exact: true }).click();
  await page.getByLabel('Формат серии').selectOption('rapid');
  const seriesCreated = page.waitForResponse(response => response.url().endsWith('/api/arena/series') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Создать серию', exact: true }).click();
  const cup = await (await seriesCreated).json();
  await page.waitForURL(`${base}/arena/series/${cup.series.id}`);
  await page.getByText('Код приглашения серии', { exact: true }).waitFor();
  await post(bob, `/series/${cup.series.id}/join`, { botId: otherBot.id, invite: cup.invite });
  await page.getByRole('button', { name: 'Получить ключ серии', exact: true }).click();
  await page.getByText('Ключ серии · сохрани сейчас', { exact: true }).waitFor();
  // Rotate via API for process setup; UI-issued key must be invalidated immediately.
  const seriesWhiteKey = (await post(alice, `/series/${cup.series.id}/key`)).token;
  const seriesBlackKey = (await post(bob, `/series/${cup.series.id}/key`)).token;
  await post(spectator, `/series/${cup.series.id}/key`, {}, 401);
  const publicSeries = await (await spectator.request.get(`${base}/api/arena/series/${cup.series.id}`)).json();
  assert.equal(publicSeries.series.games.length, 4);
  assert.ok(!JSON.stringify(publicSeries).includes(seriesWhiteKey));
  async function runPythonSeries(token) {
    const code = `import os\nfrom deepmove_client import DeepMoveSeriesClient\nc=DeepMoveSeriesClient(os.environ['DEEPMOVE_URL'],os.environ['DEEPMOVE_SERIES'],os.environ['DEEPMOVE_SERIES_TOKEN'])\nmoves=['f2f3','e7e5','g2g4','d8h4']\nr=c.play(lambda state,budget:moves[len(state['moves'])])\nassert r['status']=='finished' and r['counted'] and r['score']=={'a':2,'b':2}\nprint('four rounds complete')`;
    const child = spawn('python', ['-c', code], { cwd: resolve('clients'), windowsHide: true, env: { ...process.env, DEEPMOVE_URL: base, DEEPMOVE_SERIES: cup.series.id, DEEPMOVE_SERIES_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 65000);
    try { const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0, `Python series client failed: ${output}`); }
    finally { clearTimeout(timer); }
  }
  await Promise.all([runPythonSeries(seriesWhiteKey), runPythonSeries(seriesBlackKey)]);
  const ranking = await (await spectator.request.get(`${base}/api/arena/leaderboard`)).json();
  assert.equal(ranking.bots.find(item => item.id === myBot.id).points, 2);
  assert.equal(ranking.teams.find(item => item.id === team.id).points, 2);
  assert.equal(ranking.bots.find(item => item.id === otherBot.id).played, 4);
  await observer.goto(`${base}/arena?tab=cups`);
  await observer.getByRole('cell', { name: 'E2E Series White', exact: false }).waitFor();
  await observer.getByRole('button', { name: 'Кубок конструкторов', exact: true }).click();
  await observer.getByRole('cell', { name: 'E2E Team', exact: false }).waitFor();
  console.log('PASS: avatar upload and public profile, local alias login, registered bot ownership, four sequential games with two real Python series clients, both cup tables');
  // Responsive real pages, screenshots, logs and assets.
  for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
    await observer.setViewportSize({ width, height });
    for (const [name, path] of [['lobby', '/arena'], ['game', `/arena/games/${game.id}`], ['hardbullet', `/arena/games/${hardGame.id}`], ['docs', '/arena/docs'], ['cups', '/arena?tab=cups'], ['series', `/arena/series/${cup.series.id}`], ['profile', '/arena/players/e2e_white']]) {
      await observer.goto(base + path, { waitUntil: 'networkidle' });
      assert.equal(await observer.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow at ${width}`);
      await observer.screenshot({ path: `test-results/arena-${name}-${width}.png`, fullPage: true });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 3 viewport sizes × lobby/game/HardBullet/docs; no horizontal overflow or browser runtime errors');
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
