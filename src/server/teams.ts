import { randomUUID } from 'node:crypto';
import { db, transaction } from './db';
import { hash, secret, publicUser, type UserRow } from './auth';
import { ensure, text } from './errors';
import type { TeamView, UserView } from '@/features/arena/types';

export function listTeams(): TeamView[] {
  const teams = db().prepare('SELECT id,name,owner_id FROM teams ORDER BY rowid DESC LIMIT 100').all() as { id: string; name: string; owner_id: string }[];
  return teams.map(team => ({ id: team.id, name: team.name, ownerId: team.owner_id, members: (db().prepare('SELECT users.* FROM users JOIN team_members ON users.id=team_members.user_id WHERE team_members.team_id=?').all(team.id) as unknown as UserRow[]).map(publicUser) }));
}
export function createTeam(user: UserView, input: Record<string, unknown>) {
  const name = text(input.name, 2, 50, 'Название команды');
  return transaction(() => {
    const count = db().prepare('SELECT count(*) AS n FROM teams WHERE owner_id=?').get(user.id) as { n: number };
    ensure(count.n < 5, 409, 'Не больше 5 команд на владельца');
    const id = randomUUID(), invite = secret();
    db().prepare('INSERT INTO teams(id,name,owner_id,invite_hash) VALUES(?,?,?,?)').run(id, name, user.id, hash(invite));
    db().prepare('INSERT INTO team_members(team_id,user_id) VALUES(?,?)').run(id, user.id);
    return { id, invite };
  });
}
export function teamAction(id: string, action: string, user: UserView, input: Record<string, unknown>) {
  return transaction(() => {
    if (action === 'join') {
      const code = text(input.invite, 20, 100, 'Код приглашения');
      const team = db().prepare('SELECT id FROM teams WHERE invite_hash=?').get(hash(code)) as { id: string } | undefined;
      ensure(team, 404, 'Приглашение недействительно');
      const count = db().prepare('SELECT count(*) AS n FROM team_members WHERE team_id=?').get(team.id) as { n: number };
      ensure(count.n < 20, 409, 'В команде уже 20 участников');
      db().prepare('INSERT OR IGNORE INTO team_members(team_id,user_id) VALUES(?,?)').run(team.id, user.id);
      return { id: team.id };
    }
    const team = db().prepare('SELECT owner_id FROM teams WHERE id=?').get(id) as { owner_id: string } | undefined;
    ensure(team, 404, 'Команда не найдена');
    if (action === 'invite') {
      ensure(team.owner_id === user.id, 403, 'Приглашения управляются владельцем');
      const invite = secret();
      db().prepare('UPDATE teams SET invite_hash=? WHERE id=?').run(hash(invite), id);
      return { invite };
    }
    ensure(action === 'leave', 404, 'Неизвестное действие');
    ensure(team.owner_id !== user.id, 409, 'Владелец не может покинуть свою команду');
    db().prepare('DELETE FROM team_members WHERE team_id=? AND user_id=?').run(id, user.id);
    db().prepare('UPDATE bots SET team_id=NULL WHERE team_id=? AND owner_id=?').run(id, user.id);
    return { ok: true };
  });
}
