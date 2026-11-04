import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
export function openDatabase(directory) {
  const db = new DatabaseSync(path.join(directory, 'rooms.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY,value TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,totp_secret TEXT NOT NULL,last_step INTEGER NOT NULL DEFAULT -1,disabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,failed INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS admin_invites (hash TEXT PRIMARY KEY,username TEXT NOT NULL,target_id TEXT,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',code_hash TEXT NOT NULL UNIQUE,version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'active',join_open INTEGER NOT NULL DEFAULT 1,submissions_open INTEGER NOT NULL DEFAULT 1,voting_open INTEGER NOT NULL DEFAULT 0,approval_required INTEGER NOT NULL DEFAULT 1,starts_at TEXT,submissions_end_at TEXT,voting_end_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),name TEXT NOT NULL,name_key TEXT NOT NULL,credential_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(room_id,name_key),UNIQUE(id,room_id));
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id),member_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,image TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'published',created_at TEXT NOT NULL,UNIQUE(id,room_id),FOREIGN KEY(member_id,room_id) REFERENCES members(id,room_id));
    CREATE TABLE IF NOT EXISTS votes (member_id TEXT NOT NULL,entry_id TEXT NOT NULL,room_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(member_id,entry_id),FOREIGN KEY(member_id,room_id) REFERENCES members(id,room_id),FOREIGN KEY(entry_id,room_id) REFERENCES entries(id,room_id));
    CREATE TRIGGER IF NOT EXISTS vote_budget BEFORE INSERT ON votes WHEN (SELECT count(*) FROM votes WHERE member_id=NEW.member_id)>=3 BEGIN SELECT RAISE(ABORT,'vote limit reached'); END;
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY,admin_id TEXT,action TEXT NOT NULL,room_id TEXT,target TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS room_members ON members(room_id);
    CREATE INDEX IF NOT EXISTS room_entries ON entries(room_id);
    CREATE INDEX IF NOT EXISTS room_votes ON votes(room_id);`);
  return db;
}
export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
