import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import type { LauncherHandler, LauncherInput } from "./types.js";
import { validatePathStrict } from "./validate.js";

type LinuxTerm = "gnome-terminal" | "konsole" | "xterm" | "alacritty" | "kitty";

export class LinuxLauncher implements LauncherHandler {
  private readonly terminal: LinuxTerm;

  constructor(config: Config) {
    const term = config.linux_terminal;
    if (
      term !== "gnome-terminal" &&
      term !== "konsole" &&
      term !== "xterm" &&
      term !== "alacritty" &&
      term !== "kitty"
    ) {
      throw new Error(`LinuxLauncher requires a known config.linux_terminal: got ${term}`);
    }
    this.terminal = term;
  }

  launch({ cwd, scriptPath }: LauncherInput): void {
    validatePathStrict(cwd, "cwd");
    validatePathStrict(scriptPath, "scriptPath");

    let argv: string[];
    switch (this.terminal) {
      case "gnome-terminal":
        argv = [`--working-directory=${cwd}`, "--", "bash", scriptPath];
        break;
      case "konsole":
        argv = ["--workdir", cwd, "-e", "bash", scriptPath];
        break;
      case "xterm":
        argv = ["-hold", "-e", "bash", scriptPath];
        break;
      case "alacritty":
        argv = ["--working-directory", cwd, "-e", "bash", scriptPath];
        break;
      case "kitty":
        argv = ["--directory", cwd, "bash", scriptPath];
        break;
    }

    const child = spawn(this.terminal, argv, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}
