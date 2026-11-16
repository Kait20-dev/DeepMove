import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db, loadGame, saveGame } from '../src/server/db';
import { getUser, hash, secret } from '../src/server/auth';
import { updateProfile, publicProfile } from '../src/server/profiles';
import { saveBot, ownedBot, listBots } from '../src/server/bots';
import { createTeam, teamAction } from '../src/server/teams';
import { createSeries, joinSeries, getSeries, leaderboard, seriesKey, seriesConnection, seriesInvite } from '../src/server/series';
import { actorSide, createGame, gameAction, getGame } from '../src/server/games';
import { finish } from '../src/features/arena/rules';
process.env.DEEPMOVE_DB = ':memory:';
function user() {
  const id = randomUUID(), token = secret();
  db().prepare('INSERT INTO users(id,handle,name,password,created_at) VALUES(?,?,?,?,?)').run(id, `u_${id.replaceAll('-', '').slice(0, 15)}`, 'Участник', 'unused', Date.now());
  db().prepare('INSERT INTO sessions(hash,user_id,expires) VALUES(?,?,?)').run(hash(token), id, Date.now() + 600000);
  return { user: getUser(id)!, request: new Request('http://localhost:3000', { headers: { cookie: `dm_session=${token}` } }) };
}
const bearer = (key: string) => new Request('http://localhost:3000', { headers: { authorization: `Bearer ${key}` } });

test('profile fields persist, avatar is normalized, and public profile contains no credentials', async () => {
  const alice = user(), other = user();
  const image = await sharp({ create: { width: 300, height: 160, channels: 3, background: '#9283bd' } }).png().toBuffer();
  const result = await updateProfile(alice.user, { name: 'Алиса', handle: 'alice_profile', organization: 'КАИТ №20', city: 'Москва', website: 'https://example.com', bio: 'Мой движок', avatar: `data:image/png;base64,${image.toString('base64')}` });
  assert.equal(result.user.organization, 'КАИТ №20');
  assert.equal(result.user.handle, 'alice_profile');
  const avatar = Buffer.from(result.user.avatar!.split(',')[1], 'base64'), metadata = await sharp(avatar).metadata();
  assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 128); assert.equal(metadata.height, 128);
  const publicData = JSON.stringify(publicProfile('alice_profile'));
  assert.ok(!publicData.includes('password')); assert.ok(!publicData.includes('token')); assert.ok(!publicData.includes('unused'));
  await assert.rejects(updateProfile(other.user, { name: 'Другой', handle: 'alice_profile' }), /занят/);
  await assert.rejects(updateProfile(result.user, { name: 'Алиса', website: 'javascript:alert(1)' }), /http/);
  await assert.rejects(updateProfile(result.user, { name: 'Алиса', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }), /Аватар/);
  await assert.rejects(updateProfile(result.user, { name: 'Алиса', avatar: 'data:image/png;base64,YWJj' }), /прочитать/);
  const cleared = await updateProfile(result.user, { name: 'Алиса', avatar: null });
  assert.equal(cleared.user.avatar, null); assert.equal(cleared.user.organization, 'КАИТ №20');
});

test('registered bots require ownership and real team membership; leaving detaches future affiliation', () => {
  const alice = user(), bob = user();
  const team = createTeam(alice.user, { name: 'Участники' });
  assert.throws(() => saveBot(bob.user, { name: 'Не свой', teamId: team.id }), /вступите/);
  const bot = saveBot(alice.user, { name: 'MathBot', teamId: team.id }).bot;
  assert.equal(listBots(alice.user.id)[0].id, bot.id);
  assert.equal(listBots(bob.user.id).length, 0);
  assert.throws(() => ownedBot(bob.user, bot.id), /владельцу/);
  assert.throws(() => saveBot(bob.user, { name: 'Подмена' }, bot.id), /владельцу/);
  assert.throws(() => saveBot(alice.user, { name: 'mathbot' }), /уже есть/);
  teamAction('', 'join', bob.user, { invite: team.invite });
  const second = saveBot(bob.user, { name: 'SecondBot', teamId: team.id }).bot;
  teamAction(team.id, 'leave', bob.user, {});
  assert.equal(ownedBot(bob.user, second.id).teamId, null);
  assert.throws(() => createGame(bob.user, { format: 'rapid', side: 'w', kind: 'human', opponentKind: 'bot', botId: second.id }), /места бота/);
});

test('cup series uses four alternating colors, sequential starts and revocable scoped connector keys', () => {
  const alice = user(), bob = user(), spectator = user();
  const a = saveBot(alice.user, { name: 'A' + randomUUID().slice(0, 8) }).bot;
  const b = saveBot(bob.user, { name: 'B' + randomUUID().slice(0, 8) }).bot;
  const created = createSeries(alice.user, { botId: a.id, format: 'hardbullet', startDelaySeconds: 3 });
  assert.throws(() => joinSeries(created.series.id, bob.user, { botId: b.id, invite: 'bad' }), /код/);
  assert.throws(() => seriesInvite(created.series.id, bob.user), /создатель/);
  const invite = seriesInvite(created.series.id, alice.user).invite;
  assert.throws(() => joinSeries(created.series.id, bob.user, { botId: b.id, invite: created.invite }), /код/);
  const joined = joinSeries(created.series.id, bob.user, { botId: b.id, invite }).series;
  assert.deepEqual(joined.games.map(g => g.white), [a.name, b.name, a.name, b.name]);
  assert.equal(joined.games.length, 4);
  assert.throws(() => seriesKey(joined.id, spectator.user), /участнику/);
  const keyA = seriesKey(joined.id, alice.user).token, keyB = seriesKey(joined.id, bob.user).token;
  const connectionA = seriesConnection(joined.id, bearer(keyA)), connectionB = seriesConnection(joined.id, bearer(keyB));
  assert.equal(connectionA.side, 'w'); assert.equal(connectionB.side, 'b');
  assert.equal(connectionA.gameId, joined.games[0].id);
  assert.throws(() => actorSide(bearer(keyA), loadGame(connectionA.gameId!)), /Ключ/);
  assert.throws(() => actorSide(bearer(connectionA.token!), loadGame(joined.games[1].id)), /Ключ/);
  assert.throws(() => gameAction(joined.games[1].id, alice.request, 'ready', {}), /Готовность/);
  assert.throws(() => gameAction(joined.games[1].id, bearer(seriesConnection(joined.id, bearer(keyA)).token!), 'ready', {}), /Ключ/);
  // Even a separately issued valid future game key cannot start that round early.
  const future = loadGame(joined.games[1].id); future.seats.b.tokenHash = hash('future-key'); saveGame(future);
  assert.throws(() => gameAction(future.id, bearer('future-key'), 'ready', {}), /предыдущей/);
  gameAction(connectionA.gameId!, bearer(connectionA.token!), 'ready', {});
  const countdown = gameAction(connectionB.gameId!, bearer(connectionB.token!), 'ready', {});
  assert.ok(countdown.startsAt); assert.equal(countdown.clocks.w, 15000);
  const replacement = seriesKey(joined.id, alice.user).token;
  assert.throws(() => seriesConnection(joined.id, bearer(keyA)), /отозванный/);
  assert.throws(() => actorSide(bearer(connectionA.token!), loadGame(connectionA.gameId!)), /Ключ/);
  assert.equal(seriesConnection(joined.id, bearer(replacement)).gameId, joined.games[0].id);
  gameAction(connectionA.gameId!, alice.request, 'resign', {});
  assert.equal(getGame(connectionA.gameId!).result, '0-1');
  assert.equal(seriesConnection(joined.id, bearer(replacement)).side, 'b');
  assert.ok(!JSON.stringify(getSeries(joined.id)).includes('keyHashes'));
});

test('both cups count 1/0.5/0 once after all four results and retain original team after transfer', () => {
  const alice = user(), bob = user();
  const oldTeam = createTeam(alice.user, { name: 'Old Constructors' }), newTeam = createTeam(alice.user, { name: 'New Constructors' });
  const bTeam = createTeam(bob.user, { name: 'Opponent Constructors' });
  const a = saveBot(alice.user, { name: 'CupBotA', teamId: oldTeam.id }).bot, b = saveBot(bob.user, { name: 'CupBotB', teamId: bTeam.id }).bot;
  const created = createSeries(alice.user, { botId: a.id, format: 'rapid' });
  const series = joinSeries(created.series.id, bob.user, { botId: b.id, invite: created.invite }).series;
  const before = leaderboard().bots.find(row => row.id === a.id)?.points || 0;
  const results = ['1-0', '0-1', '1/2-1/2', '1-0'] as const; // A: W W D L
  for (let i = 0; i < 3; i++) { const game = loadGame(series.games[i].id); finish(game, results[i], 'checkmate'); saveGame(game); }
  assert.equal(leaderboard().bots.find(row => row.id === a.id)?.points || 0, before);
  saveBot(alice.user, { name: 'RenamedCupBotA', teamId: newTeam.id }, a.id);
  const last = loadGame(series.games[3].id); finish(last, results[3], 'checkmate'); saveGame(last);
  const result = leaderboard();
  assert.equal(result.bots.find(row => row.id === a.id)?.points, 2.5);
  assert.equal(result.bots.find(row => row.id === a.id)?.played, 4);
  assert.equal(result.bots.find(row => row.id === a.id)?.wins, 2);
  assert.equal(result.bots.find(row => row.id === b.id)?.points, 1.5);
  assert.equal(result.teams.find(row => row.id === oldTeam.id)?.points, 2.5);
  assert.equal(result.teams.find(row => row.id === newTeam.id), undefined);
  assert.equal(getSeries(series.id).counted, true);
  assert.equal(leaderboard().bots.find(row => row.id === a.id)?.points, 2.5);
  const friendly = createGame(alice.user, { format: 'rapid', side: 'w', kind: 'bot', opponentKind: 'bot', botId: a.id });
  const game = loadGame(friendly.id); finish(game, '1-0', 'checkmate'); saveGame(game);
  assert.equal(leaderboard().bots.find(row => row.id === a.id)?.points, 2.5);
  // A second engine adds its own points to the same constructors' cup.
  const secondBot = saveBot(alice.user, { name: 'SecondCupEngine', teamId: oldTeam.id }).bot;
  const next = createSeries(alice.user, { botId: secondBot.id, format: 'hardbullet' });
  const joined = joinSeries(next.series.id, bob.user, { botId: b.id, invite: next.invite }).series;
  for (let i = 0; i < 3; i++) { const g = loadGame(joined.games[i].id); finish(g, '1/2-1/2', 'repetition'); saveGame(g); }
  const timeout = loadGame(joined.games[3].id);
  timeout.status = 'playing'; timeout.turnStartedAt = Date.now() - 1100; saveGame(timeout);
  // This fourth-round timeout is settled by the standings read itself.
  const summed = leaderboard();
  assert.equal(summed.bots.find(row => row.id === secondBot.id)?.points, 2.5);
  assert.equal(summed.teams.find(row => row.id === oldTeam.id)?.points, 5);
  assert.equal(summed.teams.find(row => row.id === oldTeam.id)?.bots, 2);
  assert.equal(getSeries(joined.id).counted, true);
});
