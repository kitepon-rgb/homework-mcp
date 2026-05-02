import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TaskStatus = "scheduled" | "firing" | "fired" | "cancelled";
export type OsKind = "windows" | "wsl2" | "macos" | "linux";

export interface TaskRow {
  id: string;
  due_at: string;
  prompt: string;
  title: string | null;
  cwd: string;
  os_kind: OsKind;
  scheduler_ref: string;
  created_at: string;
  status: TaskStatus;
  fired_at: string | null;
  error_message: string | null;
}

export const DB_PATH = join(homedir(), ".homework-mcp", "tasks.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  due_at          TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  title           TEXT,
  cwd             TEXT NOT NULL,
  os_kind         TEXT NOT NULL,
  scheduler_ref   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled',
  fired_at        TEXT,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);
`;

export function openDb(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
