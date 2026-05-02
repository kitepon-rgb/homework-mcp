#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { detectOsKind } from "./os.js";
import { openDb } from "./db.js";
import { loadOrInitConfig } from "./config.js";
import { createLauncher } from "./launcher/index.js";
import { buildFiringPrompt } from "./prompt.js";

const taskIdIndex = process.argv.indexOf("--task-id");
if (taskIdIndex < 0 || taskIdIndex === process.argv.length - 1) {
  console.error("usage: homework-mcp-fire --task-id <uuid>");
  process.exit(2);
}
const taskId = process.argv[taskIdIndex + 1];

const osKind = detectOsKind();
const config = loadOrInitConfig(osKind);
const db = openDb();

try {
  const row = db
    .prepare<[string]>(
      "SELECT id, status, due_at, prompt, cwd, created_at, scheduler_ref FROM tasks WHERE id = ?",
    )
    .get(taskId) as
    | {
        id: string;
        status: string;
        due_at: string;
        prompt: string;
        cwd: string;
        created_at: string;
        scheduler_ref: string;
      }
    | undefined;

  if (!row) {
    console.error(`task not found: ${taskId}`);
    process.exit(3);
  }
  if (row.status !== "scheduled") {
    console.error(`task ${taskId} is in status=${row.status}, skipping`);
    process.exit(0);
  }

  const dueAt = new Date(row.due_at);
  const now = new Date();
  if (dueAt.getFullYear() !== now.getFullYear()) {
    console.error(
      `year guard tripped (due=${dueAt.getFullYear()}, now=${now.getFullYear()}), skipping`,
    );
    process.exit(0);
  }

  const updateFiring = db
    .prepare<[string, string]>(
      "UPDATE tasks SET status = 'firing', fired_at = ? WHERE id = ? AND status = 'scheduled'",
    )
    .run(now.toISOString(), taskId);
  if (updateFiring.changes !== 1) {
    console.error(`atomic UPDATE missed for ${taskId} (changes=${updateFiring.changes})`);
    process.exit(4);
  }

  const promptPath = writeFiringPrompt({
    taskId,
    body: row.prompt,
    createdAt: new Date(row.created_at),
    now,
  });
  const scriptPath = writeLaunchScript({ taskId, cwd: row.cwd, promptPath });

  try {
    const launcher = createLauncher(osKind, config);
    launcher.launch({ taskId, cwd: row.cwd, scriptPath });
    db.prepare<[string]>("UPDATE tasks SET status = 'fired' WHERE id = ?").run(taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare<[string, string]>(
      "UPDATE tasks SET status = 'fired', error_message = ? WHERE id = ?",
    ).run(`launch failed: ${msg}`, taskId);
    process.exit(5);
  }

  selfCleanup(osKind, row.scheduler_ref);
} finally {
  db.close();
}

interface PromptWriteInput {
  taskId: string;
  body: string;
  createdAt: Date;
  now: Date;
}

function writeFiringPrompt({ taskId, body, createdAt, now }: PromptWriteInput): string {
  const dir = join(homedir(), ".homework-mcp", "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.txt`);
  const text = buildFiringPrompt({ createdAt, now, body });
  writeFileSync(path, text, "utf8");
  return path;
}

interface LaunchScriptInput {
  taskId: string;
  cwd: string;
  promptPath: string;
}

function writeLaunchScript({ taskId, cwd, promptPath }: LaunchScriptInput): string {
  const dir = join(homedir(), ".homework-mcp", "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${taskId}.sh`);
  const text = `#!/bin/bash\ncd ${cwd} && exec claude -- "$(cat ${promptPath})"\n`;
  writeFileSync(path, text, { mode: 0o755 });
  return path;
}

function selfCleanup(
  osKind: "windows" | "wsl2" | "macos" | "linux",
  schedulerRef: string,
): void {
  if (osKind === "windows" || osKind === "wsl2") {
    return;
  }
  if (osKind === "macos") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${schedulerRef}.plist`);
    const uid = userInfo().uid;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${schedulerRef}`], { stdio: "ignore" });
    } catch {
      // continue
    }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    return;
  }
  if (osKind === "linux") {
    const dir = join(homedir(), ".config", "systemd", "user");
    const timer = join(dir, `${schedulerRef}.timer`);
    const service = join(dir, `${schedulerRef}.service`);
    try {
      execFileSync("systemctl", ["--user", "stop", `${schedulerRef}.timer`], { stdio: "ignore" });
    } catch {
      // continue
    }
    try {
      execFileSync("systemctl", ["--user", "disable", `${schedulerRef}.timer`], { stdio: "ignore" });
    } catch {
      // continue
    }
    if (existsSync(timer)) unlinkSync(timer);
    if (existsSync(service)) unlinkSync(service);
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      // continue
    }
    return;
  }
}
