import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensure } from './errors';
import type { Game } from '@/features/arena/types';

let database: DatabaseSync | undefined;
export function db(): DatabaseSync {
  if (!database) {
    const location = process.env.DEEPMOVE_DB || resolve('data/deepmove.sqlite');
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
    database = new DatabaseSync(location);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', password TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), invite_hash TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(team_id,user_id));
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS games_updated ON games(updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);`);
  }
  return database;
}
export function transaction<T>(fn: () => T): T {
  const sql = db();
  sql.exec('BEGIN IMMEDIATE');
  try { const result = fn(); sql.exec('COMMIT'); return result; }
  catch (error) { sql.exec('ROLLBACK'); throw error; }
}
export function loadGame(id: string): Game {
  const row = db().prepare('SELECT data FROM games WHERE id=?').get(id) as { data: string } | undefined;
  ensure(row, 404, 'Партия не найдена');
  return JSON.parse(row.data) as Game;
}
export function saveGame(game: Game) {
  db().prepare('INSERT INTO games(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(game.id, JSON.stringify(game), Date.now());
}
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const row = db().prepare(`INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count`).get(key, now + windowMs, now, now) as { count: number };
  ensure(row.count <= limit, 429, 'Слишком много запросов. Повторите позже.', 'rate_limited');
  if (Math.random() < .01) db().prepare('DELETE FROM rate_limits WHERE reset_at<?').run(now);
}
