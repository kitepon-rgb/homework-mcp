import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { SchedulerHandler, SchedulerTask } from "./types.js";

export class Wsl2Scheduler implements SchedulerHandler {
  constructor(private readonly config: Config) {
    if (!config.wsl_distro) {
      throw new Error("Wsl2Scheduler requires config.wsl_distro");
    }
  }

  register(task: SchedulerTask): void {
    const xml = buildSchtasksXml({
      dueAt: task.dueAt,
      command: "wsl.exe",
      args: [
        "-d",
        this.config.wsl_distro!,
        "-e",
        task.nodeExecPath,
        task.fireScriptPath,
        "--task-id",
        task.id,
      ],
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "homework-mcp-"));
    const wslXmlPath = join(tmpDir, "task.xml");
    try {
      const utf16 = utf16LeWithBom(xml);
      writeFileSync(wslXmlPath, utf16);
      const winXmlPath = wslpathToWindows(wslXmlPath);
      execFileSync(
        "cmd.exe",
        ["/c", "schtasks", "/Create", "/XML", winXmlPath, "/TN", task.schedulerRef, "/F"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  unregister(schedulerRef: string): void {
    execFileSync("cmd.exe", ["/c", "schtasks", "/Delete", "/TN", schedulerRef, "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function wslpathToWindows(wslPath: string): string {
  return execFileSync("wslpath", ["-w", wslPath], { encoding: "utf8" }).trim();
}

function utf16LeWithBom(s: string): Buffer {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(s, "utf16le");
  return Buffer.concat([bom, body]);
}

interface XmlInput {
  dueAt: Date;
  command: string;
  args: string[];
}

export function buildSchtasksXml({ dueAt, command, args }: XmlInput): string {
  const localStart = formatLocalIso(dueAt);
  const argString = args.map(quoteArg).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localStart}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(command)}</Command>
      <Arguments>${escapeXml(argString)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function quoteArg(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
