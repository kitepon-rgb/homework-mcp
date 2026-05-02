import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchtasksXml } from "./wsl2.js";
import type { SchedulerHandler, SchedulerTask } from "./types.js";

export class WindowsScheduler implements SchedulerHandler {
  register(task: SchedulerTask): void {
    const xml = buildSchtasksXml({
      dueAt: task.dueAt,
      command: task.nodeExecPath,
      args: [task.fireScriptPath, "--task-id", task.id],
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "homework-mcp-"));
    const xmlPath = join(tmpDir, "task.xml");
    try {
      const utf16 = utf16LeWithBom(xml);
      writeFileSync(xmlPath, utf16);
      execFileSync(
        "schtasks",
        ["/Create", "/XML", xmlPath, "/TN", task.schedulerRef, "/F"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  unregister(schedulerRef: string): void {
    execFileSync("schtasks", ["/Delete", "/TN", schedulerRef, "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

function utf16LeWithBom(s: string): Buffer {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(s, "utf16le");
  return Buffer.concat([bom, body]);
}
