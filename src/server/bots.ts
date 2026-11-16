import { randomUUID } from 'node:crypto';
import { db, transaction } from './db';
import { ensure, text } from './errors';
import type { BotView, UserView, Seat } from '@/features/arena/types';

const projection = `SELECT bots.id,bots.name,bots.description,bots.owner_id AS ownerId,users.handle AS ownerHandle,bots.team_id AS teamId,teams.name AS teamName,bots.created_at AS createdAt FROM bots JOIN users ON users.id=bots.owner_id LEFT JOIN teams ON teams.id=bots.team_id`;
export function listBots(ownerId?: string): BotView[] {
  return db().prepare(`${projection}${ownerId ? ' WHERE bots.owner_id=?' : ''} ORDER BY bots.created_at DESC`).all(...(ownerId ? [ownerId] : [])) as unknown as BotView[];
}
export function ownedBot(user: UserView, id: unknown): BotView {
  ensure(typeof id === 'string', 400, 'Выберите зарегистрированного бота');
  const bot = db().prepare(`${projection} WHERE bots.id=?`).get(id) as unknown as BotView | undefined;
  ensure(bot && bot.ownerId === user.id, 403, 'Бот доступен только своему владельцу');
  if (bot.teamId) ensure(db().prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(bot.teamId, user.id), 403, 'Владелец бота больше не состоит в команде. Измените команду бота.');
  return bot;
}
export function botSeat(bot: BotView): Seat {
  return { userId: bot.ownerId, name: bot.name, kind: 'bot', ready: false, tokenHash: null, botId: bot.id, teamId: bot.teamId, teamName: bot.teamName };
}
export function saveBot(user: UserView, input: Record<string, unknown>, id?: string) {
  return transaction(() => {
    if (id) ensure(db().prepare('SELECT 1 FROM bots WHERE id=? AND owner_id=?').get(id, user.id), 403, 'Бот доступен только своему владельцу');
    else ensure((db().prepare('SELECT count(*) AS n FROM bots WHERE owner_id=?').get(user.id) as { n: number }).n < 20, 409, 'До 20 ботов на аккаунт');
    const name = text(input.name, 2, 50, 'Название бота'), description = text(input.description ?? '', 0, 500, 'Описание');
    const teamId = input.teamId ? text(input.teamId, 1, 100, 'Команда') : null;
    if (teamId) ensure(db().prepare('SELECT 1 FROM team_members WHERE team_id=? AND user_id=?').get(teamId, user.id), 403, 'Сначала вступите в эту команду');
    ensure(!db().prepare('SELECT id FROM bots WHERE owner_id=? AND name=? COLLATE NOCASE AND id<>?').get(user.id, name, id || ''), 409, 'У вас уже есть бот с таким названием');
    const botId = id || randomUUID();
    if (id) db().prepare('UPDATE bots SET name=?,description=?,team_id=? WHERE id=?').run(name, description, teamId, id);
    else db().prepare('INSERT INTO bots(id,owner_id,name,description,team_id,created_at) VALUES(?,?,?,?,?,?)').run(botId, user.id, name, description, teamId, Date.now());
    return { bot: ownedBot(user, botId) };
  });
}
