import { authenticate, hash, requireUser, sameOrigin, sessionUser } from '@/server/auth';
import { db, rateLimit } from '@/server/db';
import { body, failure, json } from '@/server/http';
import { ensure, text } from '@/server/errors';
import { createGame, gameAction, getGame, joinGame, listGames, rotateBotKey, rotateGameInvite } from '@/server/games';
import { createTeam, listTeams, teamAction } from '@/server/teams';
import { requestAnalysis } from '@/server/analysis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path?: string[] }> };
export async function GET(request: Request, context: Context) {
  try {
    rateLimit('public-reads', 12000, 60_000);
    const path = (await context.params).path || [];
    if (path.length === 0) return json({ user: sessionUser(request), games: listGames(), teams: listTeams() });
    if (path[0] === 'me') return json({ user: sessionUser(request) });
    if (path[0] === 'games' && path[1]) {
      const game = getGame(path[1]);
      if (path[2] === 'pgn') return new Response(game.pgn, { headers: { 'Content-Type': 'application/x-chess-pgn; charset=utf-8', 'Content-Disposition': `attachment; filename="deepmove-${game.id}.pgn"`, 'Cache-Control': 'no-store' } });
      ensure(path.length === 2, 404, 'Не найдено');
      return json(game);
    }
    ensure(false, 404, 'Не найдено');
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const path = (await context.params).path || [];
    const botAction = path[0] === 'games' && path.length === 3 && ['move', 'ready', 'resign'].includes(path[2]) && request.headers.has('authorization');
    if (!botAction) sameOrigin(request);
    const input = await body(request);
    if (path[0] === 'register' || path[0] === 'login') {
      rateLimit('authentication-global', 100, 60_000);
      const { user, token } = await authenticate(input, path[0] === 'register');
      const secure = process.env.NODE_ENV === 'production' && new URL(process.env.APP_ORIGIN || request.url).protocol === 'https:';
      return json({ user }, 200, { 'Set-Cookie': `dm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}` });
    }
    if (path[0] === 'logout') {
      const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('dm_session='))?.slice(11);
      if (token) db().prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
      return json({ ok: true }, 200, { 'Set-Cookie': 'dm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (botAction) {
      rateLimit(`bot:${hash(request.headers.get('authorization') || '')}`, 300, 60_000);
      return json(gameAction(path[1], request, path[2], input));
    }
    const user = requireUser(request);
    rateLimit(`write:${user.id}`, 180, 60_000);
    if (path[0] === 'profile') {
      const name = text(input.name, 1, 50, 'Имя'), bio = typeof input.bio === 'string' ? input.bio.trim() : '';
      ensure(bio.length <= 500, 400, 'Описание: максимум 500 символов');
      db().prepare('UPDATE users SET name=?,bio=? WHERE id=?').run(name, bio, user.id);
      return json({ ok: true });
    }
    if (path[0] === 'games') {
      if (path.length === 1) { rateLimit(`create:${user.id}`, 20, 3600_000); return json(createGame(user, input), 201); }
      ensure(path.length === 3, 404, 'Не найдено');
      const [ , id, action] = path;
      if (action === 'join') return json(joinGame(id, user, input));
      if (action === 'key') return json(rotateBotKey(id, user));
      if (action === 'invite') return json(rotateGameInvite(id, user));
      if (action === 'analysis') {
        rateLimit(`analysis:${user.id}`, 4, 3600_000);
        return json(await requestAnalysis(id), 200);
      }
      return json(gameAction(id, request, action, input));
    }
    if (path[0] === 'teams') {
      if (path.length === 1) return json(createTeam(user, input), 201);
      if (path.length === 2 && path[1] === 'join') return json(teamAction('', 'join', user, input));
      ensure(path.length === 3, 404, 'Не найдено');
      return json(teamAction(path[1], path[2], user, input));
    }
    ensure(false, 404, 'Не найдено');
  } catch (error) { return failure(error); }
}
