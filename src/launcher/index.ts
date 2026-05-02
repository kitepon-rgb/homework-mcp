import type { Config } from "../config.js";
import type { OsKind } from "../db.js";
import { LinuxLauncher } from "./linux.js";
import { MacosLauncher } from "./macos.js";
import type { LauncherHandler } from "./types.js";
import { WindowsLauncher } from "./windows.js";
import { Wsl2Launcher } from "./wsl2.js";

export function createLauncher(osKind: OsKind, config: Config): LauncherHandler {
  switch (osKind) {
    case "windows":
      return new WindowsLauncher();
    case "wsl2":
      return new Wsl2Launcher(config);
    case "macos":
      return new MacosLauncher(config);
    case "linux":
      return new LinuxLauncher(config);
    default:
      throw new Error(`unsupported os_kind: ${osKind satisfies never}`);
  }
}

export type { LauncherHandler, LauncherInput } from "./types.js";
