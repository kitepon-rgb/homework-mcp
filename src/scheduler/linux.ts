import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SchedulerHandler, SchedulerTask } from "./types.js";

const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const REQUIRED_GUI_VARS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
];

export class LinuxScheduler implements SchedulerHandler {
  constructor() {
    assertLingerEnabled();
    assertGuiSession();
    importEnvironmentToUserManager();
  }

  register(task: SchedulerTask): void {
    const serviceName = `${task.schedulerRef}.service`;
    const timerName = `${task.schedulerRef}.timer`;
    const servicePath = join(SYSTEMD_USER_DIR, serviceName);
    const timerPath = join(SYSTEMD_USER_DIR, timerName);

    const service = buildServiceUnit({
      execPath: task.nodeExecPath,
      fireScriptPath: task.fireScriptPath,
      taskId: task.id,
    });
    const timer = buildTimerUnit({ dueAt: task.dueAt, serviceName });

    execFileSync("mkdir", ["-p", SYSTEMD_USER_DIR]);
    writeFileSync(servicePath, service, "utf8");
    writeFileSync(timerPath, timer, "utf8");

    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "start", timerName]);
  }

  unregister(schedulerRef: string): void {
    const serviceName = `${schedulerRef}.service`;
    const timerName = `${schedulerRef}.timer`;
    const servicePath = join(SYSTEMD_USER_DIR, serviceName);
    const timerPath = join(SYSTEMD_USER_DIR, timerName);

    try {
      execFileSync("systemctl", ["--user", "stop", timerName], { stdio: "ignore" });
    } catch {
      // continue
    }
    try {
      execFileSync("systemctl", ["--user", "disable", timerName], { stdio: "ignore" });
    } catch {
      // continue
    }
    if (existsSync(timerPath)) unlinkSync(timerPath);
    if (existsSync(servicePath)) unlinkSync(servicePath);
    execFileSync("systemctl", ["--user", "daemon-reload"]);
  }
}

function assertLingerEnabled(): void {
  const out = execFileSync("loginctl", [
    "show-user",
    String(process.getuid?.() ?? ""),
    "--property=Linger",
  ], { encoding: "utf8" });
  if (!/Linger=yes/.test(out)) {
    throw new Error(
      "loginctl linger is not enabled. Run `loginctl enable-linger $USER` and retry.",
    );
  }
}

function assertGuiSession(): void {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Neither $DISPLAY nor $WAYLAND_DISPLAY is set. " +
        "homework-mcp on linux requires a GUI session to open a terminal window.",
    );
  }
}

function importEnvironmentToUserManager(): void {
  const present = REQUIRED_GUI_VARS.filter((k) => process.env[k]);
  if (present.length === 0) return;
  execFileSync("systemctl", ["--user", "import-environment", ...present]);
}

interface ServiceInput {
  execPath: string;
  fireScriptPath: string;
  taskId: string;
}

function buildServiceUnit({ execPath, fireScriptPath, taskId }: ServiceInput): string {
  return `[Unit]
Description=homework-mcp fire ${taskId}

[Service]
Type=oneshot
PassEnvironment=${REQUIRED_GUI_VARS.join(" ")}
ExecStart=${execPath} ${fireScriptPath} --task-id ${taskId}
`;
}

interface TimerInput {
  dueAt: Date;
  serviceName: string;
}

function buildTimerUnit({ dueAt, serviceName }: TimerInput): string {
  const calendar = formatOnCalendar(dueAt);
  return `[Unit]
Description=homework-mcp timer for ${serviceName}

[Timer]
OnCalendar=${calendar}
Persistent=true
Unit=${serviceName}

[Install]
WantedBy=timers.target
`;
}

function formatOnCalendar(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
