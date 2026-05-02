import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import type { OsKind, TaskRow, TaskStatus } from "./db.js";
import type { SchedulerHandler } from "./scheduler/types.js";

const PATH_WHITELIST = /^[A-Za-z0-9_./\\:\- ]*$/;
const MIN_LEAD_TIME_MS = 5 * 60 * 1000;

export interface ScheduleInput {
  due_at: string;
  prompt: string;
  title?: string;
}

export interface ScheduleOutput {
  id: string;
  due_at: string;
}

export interface ListItem {
  id: string;
  due_at: string;
  title: string | null;
  status: TaskStatus;
  cwd: string;
}

export interface ListInput {
  filter?: { status?: TaskStatus };
}

export interface CancelInput {
  id: string;
}

export interface ToolsContext {
  fireScriptPath: string;
  nodeExecPath: string;
}

export class HomeworkTools {
  constructor(
    private readonly db: Database.Database,
    private readonly osKind: OsKind,
    private readonly scheduler: SchedulerHandler,
    private readonly ctx: ToolsContext,
  ) {}

  schedule(input: ScheduleInput): ScheduleOutput {
    const dueAt = parseAndValidateDueAt(input.due_at);
    validatePrompt(input.prompt);
    const cwd = process.cwd();
    validatePath(cwd, "cwd");

    const id = uuidv7();
    const schedulerRef = `homework_${id.replace(/-/g, "_")}`;
    const createdAt = new Date().toISOString();

    const insert = this.db.prepare<[string, string, string, string | null, string, string, string, string]>(`
      INSERT INTO tasks (id, due_at, prompt, title, cwd, os_kind, scheduler_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      insert.run(
        id,
        dueAt.toISOString(),
        input.prompt,
        input.title ?? null,
        cwd,
        this.osKind,
        schedulerRef,
        createdAt,
      );
      this.scheduler.register({
        id,
        schedulerRef,
        dueAt,
        cwd,
        fireScriptPath: this.ctx.fireScriptPath,
        nodeExecPath: this.ctx.nodeExecPath,
      });
    });
    tx.immediate();

    return { id, due_at: dueAt.toISOString() };
  }

  list(input: ListInput = {}): ListItem[] {
    const status = input.filter?.status ?? "scheduled";
    const rows = this.db
      .prepare<[string]>(
        "SELECT id, due_at, title, status, cwd FROM tasks WHERE status = ? ORDER BY due_at ASC",
      )
      .all(status) as Array<Pick<TaskRow, "id" | "due_at" | "title" | "status" | "cwd">>;
    return rows.map((r) => ({
      id: r.id,
      due_at: r.due_at,
      title: r.title,
      status: r.status,
      cwd: r.cwd,
    }));
  }

  cancel(input: CancelInput): { ok: true } {
    const row = this.db
      .prepare<[string]>("SELECT id, status, scheduler_ref FROM tasks WHERE id = ?")
      .get(input.id) as Pick<TaskRow, "id" | "status" | "scheduler_ref"> | undefined;
    if (!row) throw new Error(`task not found: ${input.id}`);
    if (row.status !== "scheduled") {
      throw new Error(`task is already ${row.status}, cannot cancel: ${input.id}`);
    }

    this.scheduler.unregister(row.scheduler_ref);
    this.db
      .prepare<[string]>("UPDATE tasks SET status = 'cancelled' WHERE id = ?")
      .run(input.id);

    return { ok: true };
  }
}

function parseAndValidateDueAt(raw: string): Date {
  if (!raw || typeof raw !== "string") {
    throw new Error("due_at must be a non-empty ISO 8601 string");
  }
  if (!hasTimezone(raw)) {
    throw new Error(
      `due_at must include a timezone offset (e.g. "2026-06-02T09:00:00+09:00"): ${raw}`,
    );
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`due_at is not a valid ISO 8601 datetime: ${raw}`);
  }
  const lead = d.getTime() - Date.now();
  if (lead < MIN_LEAD_TIME_MS) {
    throw new Error(
      `due_at must be at least 5 minutes in the future. lead = ${Math.round(lead / 1000)}s`,
    );
  }
  return d;
}

function hasTimezone(raw: string): boolean {
  return /([Zz]|[+-]\d{2}:?\d{2})$/.test(raw);
}

function validatePrompt(p: unknown): asserts p is string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
}

function validatePath(p: string, label: string): void {
  if (!PATH_WHITELIST.test(p)) {
    throw new Error(`${label} contains disallowed characters: ${p}`);
  }
}
