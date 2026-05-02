import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { SchedulerHandler, SchedulerTask } from "./types.js";

const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");

export class MacosScheduler implements SchedulerHandler {
  register(task: SchedulerTask): void {
    const label = task.schedulerRef;
    const plistPath = join(LAUNCH_AGENTS_DIR, `${label}.plist`);
    const plist = buildPlist({
      label,
      dueAt: task.dueAt,
      programArguments: [task.nodeExecPath, task.fireScriptPath, "--task-id", task.id],
    });
    writeFileSync(plistPath, plist, "utf8");
    const uid = userInfo().uid;
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  unregister(schedulerRef: string): void {
    const plistPath = join(LAUNCH_AGENTS_DIR, `${schedulerRef}.plist`);
    const uid = userInfo().uid;
    if (existsSync(plistPath)) {
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${schedulerRef}`], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Continue to file removal even if launchctl already evicted the job
      }
      unlinkSync(plistPath);
    } else {
      throw new Error(`launchd plist not found: ${plistPath}`);
    }
  }
}

interface PlistInput {
  label: string;
  dueAt: Date;
  programArguments: string[];
}

function buildPlist({ label, dueAt, programArguments }: PlistInput): string {
  const month = dueAt.getMonth() + 1;
  const day = dueAt.getDate();
  const hour = dueAt.getHours();
  const minute = dueAt.getMinutes();
  const argsXml = programArguments
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Month</key>
        <integer>${month}</integer>
        <key>Day</key>
        <integer>${day}</integer>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
