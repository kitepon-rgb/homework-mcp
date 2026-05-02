import type { Config } from "../config.js";
import type { OsKind } from "../db.js";
import { LinuxScheduler } from "./linux.js";
import { MacosScheduler } from "./macos.js";
import type { SchedulerHandler } from "./types.js";
import { WindowsScheduler } from "./windows.js";
import { Wsl2Scheduler } from "./wsl2.js";

export function createScheduler(osKind: OsKind, config: Config): SchedulerHandler {
  switch (osKind) {
    case "windows":
      return new WindowsScheduler();
    case "wsl2":
      return new Wsl2Scheduler(config);
    case "macos":
      return new MacosScheduler();
    case "linux":
      return new LinuxScheduler();
    default:
      throw new Error(`unsupported os_kind: ${osKind satisfies never}`);
  }
}

export type { SchedulerHandler, SchedulerTask } from "./types.js";
