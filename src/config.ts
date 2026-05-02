import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OsKind } from "./db.js";

export const CONFIG_PATH = join(homedir(), ".homework-mcp", "config.json");

export interface Config {
  os_kind: OsKind;
  wsl_distro: string | null;
  macos_terminal: "Terminal" | "iTerm" | null;
  linux_terminal: "gnome-terminal" | "konsole" | "xterm" | "alacritty" | "kitty" | null;
}

export function loadOrInitConfig(osKind: OsKind): Config {
  if (!existsSync(CONFIG_PATH)) {
    const template = buildTemplate(osKind);
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2) + "\n", "utf8");
    throw new Error(
      `homework-mcp: config file created at ${CONFIG_PATH}. ` +
        `Please review and fill in the required fields for your OS, then restart.`,
    );
  }

  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  if (raw.os_kind !== osKind) {
    throw new Error(
      `config.os_kind (${raw.os_kind}) does not match detected ${osKind}. ` +
        `If you moved the DB across machines, delete ${CONFIG_PATH} to regenerate.`,
    );
  }

  validateForOs(raw, osKind);
  return raw as Config;
}

function buildTemplate(osKind: OsKind): Config {
  return {
    os_kind: osKind,
    wsl_distro: osKind === "wsl2" ? "" : null,
    macos_terminal: osKind === "macos" ? null : null,
    linux_terminal: osKind === "linux" ? null : null,
  };
}

function validateForOs(raw: Partial<Config>, osKind: OsKind): void {
  if (osKind === "wsl2") {
    if (!raw.wsl_distro || raw.wsl_distro.length === 0) {
      throw new Error(
        `config.wsl_distro is required for os_kind=wsl2. ` +
          `Run \`wsl -l -v\` to find your distro name and edit ${CONFIG_PATH}.`,
      );
    }
  }
  if (osKind === "macos") {
    if (raw.macos_terminal !== "Terminal" && raw.macos_terminal !== "iTerm") {
      throw new Error(
        `config.macos_terminal must be "Terminal" or "iTerm" for os_kind=macos. ` +
          `Edit ${CONFIG_PATH}.`,
      );
    }
  }
  if (osKind === "linux") {
    const allowed = ["gnome-terminal", "konsole", "xterm", "alacritty", "kitty"];
    if (!raw.linux_terminal || !allowed.includes(raw.linux_terminal)) {
      throw new Error(
        `config.linux_terminal must be one of ${allowed.join(" / ")} for os_kind=linux. ` +
          `Edit ${CONFIG_PATH}.`,
      );
    }
  }
}
