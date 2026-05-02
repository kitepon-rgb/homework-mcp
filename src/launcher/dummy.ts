import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const FIRED_LOG = join(homedir(), ".homework-mcp", "fired.log");

export function dummyLaunch(taskId: string): void {
  mkdirSync(dirname(FIRED_LOG), { recursive: true });
  const line = `${new Date().toISOString()} fired ${taskId}\n`;
  appendFileSync(FIRED_LOG, line, "utf8");
}
