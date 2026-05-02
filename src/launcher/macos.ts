import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import type { LauncherHandler, LauncherInput } from "./types.js";
import { validatePathStrict } from "./validate.js";

export class MacosLauncher implements LauncherHandler {
  constructor(private readonly config: Config) {
    if (config.macos_terminal !== "Terminal" && config.macos_terminal !== "iTerm") {
      throw new Error(
        `MacosLauncher requires config.macos_terminal in {Terminal, iTerm}: got ${config.macos_terminal}`,
      );
    }
  }

  launch({ cwd, scriptPath }: LauncherInput): void {
    validatePathStrict(cwd, "cwd");
    validatePathStrict(scriptPath, "scriptPath");

    const shellCmd = `bash ${scriptPath}`;
    const script =
      this.config.macos_terminal === "Terminal"
        ? `tell application "Terminal" to do script ${quoteAppleScript(shellCmd)} in window (make new window)`
        : `tell application "iTerm" to create window with default profile command ${quoteAppleScript(shellCmd)}`;

    const child = spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

function quoteAppleScript(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
