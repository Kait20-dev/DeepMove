import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, loadGame, rateLimit } from '../src/server/db';
import { hash, secret, authenticate, sessionUser, sameOrigin } from '../src/server/auth';
import { actorSide, createGame, gameAction, getGame, joinGame, rotateBotKey, rotateGameInvite } from '../src/server/games';
import { createTeam, teamAction, listTeams } from '../src/server/teams';
import { body } from '../src/server/http';
import type { UserView } from '../src/features/arena/types';
process.env.DEEPMOVE_DB = ':memory:';
function user(): { user: UserView; request: Request } {
  const id = randomUUID(), token = secret();
  db().prepare('INSERT INTO users(id,handle,name,password,created_at) VALUES(?,?,?,?,?)').run(id, id, 'Test', 'unused', Date.now());
  db().prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(hash(token), id, Date.now() + 100000);
  return { user: { id, handle: id, name: 'Test', bio: '', createdAt: Date.now() }, request: new Request('http://localhost:3000', { headers: { cookie: `dm_session=${token}` } }) };
}
test('invites protect vacant seats; spectator and other accounts cannot move, ready or rotate keys', () => {
  const alice = user(), bob = user(), mallory = user();
  const game = createGame(alice.user, { format: 'arena', side: 'w', kind: 'bot', opponentKind: 'human' });
  assert.throws(() => joinGame(game.id, mallory.user, {}), /приглашения/);
  assert.throws(() => rotateBotKey(game.id, mallory.user), /владельцу/);
  assert.throws(() => gameAction(game.id, mallory.request, 'resign', {}), /зритель/);
  assert.throws(() => gameAction(game.id, alice.request, 'ready', {}), /Готовность/);
  joinGame(game.id, bob.user, { joinCode: game.joinCode });
  const { token } = rotateBotKey(game.id, alice.user);
  const request = new Request('http://localhost', { headers: { authorization: `Bearer ${token}` } });
  const ready = gameAction(game.id, request, 'ready', {}); assert.equal(ready.status, 'playing');
  assert.throws(() => gameAction(game.id, alice.request, 'move', { move: 'e2e4', expectedPly: 0 }), /Bearer/);
  const moved = gameAction(game.id, request, 'move', { move: 'e2e4', expectedPly: 0 }); assert.equal(moved.moves.length, 1);
  assert.throws(() => gameAction(game.id, request, 'move', { move: 'e2e4', expectedPly: 0 }), /устарела/);
  assert.equal(getGame(game.id).moves.length, 1);
});
test('bot credentials are game-scoped, not readable, and revocable; invite rotation invalidates the old code', () => {
  const alice = user(), bob = user();
  const first = createGame(alice.user, { format: 'rapid', side: 'w', kind: 'bot', opponentKind: 'bot' });
  const second = createGame(alice.user, { format: 'rapid', side: 'w', kind: 'bot', opponentKind: 'bot' });
  const old = rotateBotKey(first.id, alice.user).token;
  const request = new Request('http://localhost', { headers: { authorization: `Bearer ${old}` } });
  assert.throws(() => actorSide(request, loadGame(second.id)), /Ключ/);
  rotateBotKey(first.id, alice.user);
  assert.throws(() => actorSide(request, loadGame(first.id)), /Ключ/);
  const code = rotateGameInvite(first.id, alice.user).joinCode;
  assert.throws(() => joinGame(first.id, bob.user, { joinCode: first.joinCode }), /приглашения/);
  joinGame(first.id, bob.user, { joinCode: code });
  const json = JSON.stringify(getGame(first.id)); assert.ok(!json.includes(old)); assert.ok(!json.includes(code)); assert.ok(!json.includes('Hash'));
});
test('profile authentication uses salted KDF, hashed sessions and exact same-origin validation', async () => {
  const handle = `user_${randomUUID().slice(0, 8)}`;
  const registered = await authenticate({ handle, name: 'Alice', password: 'a-long-test-password' }, true);
  const stored = db().prepare('SELECT password FROM users WHERE id=?').get(registered.user.id) as { password: string };
  assert.ok(!stored.password.includes('a-long-test-password'));
  await assert.rejects(authenticate({ handle, password: 'wrong-long-password' }, false), /Неверный/);
  const login = await authenticate({ handle, password: 'a-long-test-password' }, false);
  const request = new Request('http://localhost:3000', { headers: { cookie: `dm_session=${login.token}` } });
  assert.equal(sessionUser(request)?.id, registered.user.id);
  db().prepare('UPDATE sessions SET expires=0 WHERE hash=?').run(hash(login.token)); assert.equal(sessionUser(request), null);
  assert.throws(() => sameOrigin(new Request('http://localhost:3000', { headers: { origin: 'https://evil.example' } })), /другого сайта/);
  assert.doesNotThrow(() => sameOrigin(new Request('http://localhost:3000', { headers: { origin: 'http://localhost:3000' } })));
});
test('team join requires invitation and rotation is restricted to its owner', () => {
  const alice = user().user, bob = user().user;
  const team = createTeam(alice, { name: 'Deep Test' });
  assert.throws(() => teamAction(team.id, 'invite', bob, {}), /владельцем/);
  assert.throws(() => teamAction('', 'join', bob, { invite: 'x'.repeat(43) }), /недействительно/);
  teamAction('', 'join', bob, { invite: team.invite });
  assert.equal(listTeams().find(item => item.id === team.id)?.members.length, 2);
  teamAction(team.id, 'invite', alice, {});
  assert.throws(() => teamAction('', 'join', bob, { invite: team.invite }), /недействительно/);
  teamAction(team.id, 'leave', bob, {});
  assert.equal(listTeams().find(item => item.id === team.id)?.members.length, 1);
});
test('rate limits persist and oversized or malformed JSON requests are rejected', async () => {
  rateLimit('test-rate', 1, 1000, 0); assert.throws(() => rateLimit('test-rate', 1, 1000, 1), /много запросов/);
  assert.doesNotThrow(() => rateLimit('test-rate', 1, 1000, 1001));
  await assert.rejects(body(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'x'.repeat(70000) }) })), /64/);
  await assert.rejects(body(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })), /JSON-объект/);
});
