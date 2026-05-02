import { spawn } from "node:child_process";
import type { LauncherHandler, LauncherInput } from "./types.js";
import { validatePathStrict } from "./validate.js";

export class WindowsLauncher implements LauncherHandler {
  launch({ cwd, scriptPath }: LauncherInput): void {
    validatePathStrict(cwd, "cwd");
    validatePathStrict(scriptPath, "scriptPath");

    const args = ["-w", "new", "nt", "-d", cwd, "--", "bash", scriptPath];
    const child = spawn("wt.exe", args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}
