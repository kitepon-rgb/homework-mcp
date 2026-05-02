import { spawn, execFileSync } from "node:child_process";
import type { Config } from "../config.js";
import type { LauncherHandler, LauncherInput } from "./types.js";
import { validatePathStrict } from "./validate.js";

export class Wsl2Launcher implements LauncherHandler {
  constructor(private readonly config: Config) {
    if (!config.wsl_distro) throw new Error("Wsl2Launcher requires config.wsl_distro");
  }

  launch({ cwd, scriptPath }: LauncherInput): void {
    validatePathStrict(cwd, "cwd");
    validatePathStrict(scriptPath, "scriptPath");

    const cwdWin = wslpathToWindows(cwd);
    const args = [
      "/c",
      "wt.exe",
      "-w",
      "new",
      "nt",
      "-d",
      cwdWin,
      "--",
      "wsl.exe",
      "-d",
      this.config.wsl_distro!,
      "-e",
      "bash",
      scriptPath,
    ];
    const child = spawn("cmd.exe", args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

function wslpathToWindows(wslPath: string): string {
  return execFileSync("wslpath", ["-w", wslPath], { encoding: "utf8" }).trim();
}
