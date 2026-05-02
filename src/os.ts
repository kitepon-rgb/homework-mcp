import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

export type OsKind = "windows" | "wsl2" | "macos" | "linux";

let cached: OsKind | undefined;

export function detectOsKind(): OsKind {
  if (cached !== undefined) return cached;
  cached = detectOsKindUncached();
  return cached;
}

function detectOsKindUncached(): OsKind {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";

  if (process.platform === "linux") {
    const procVersion = readProcVersion();
    const isMicrosoft = /microsoft/i.test(procVersion);

    if (!isMicrosoft) return "linux";

    const hasWSL2Marker = /WSL2/.test(procVersion);
    const unameRelease = readUnameRelease();
    const isWSL2Kernel = /-microsoft-standard-WSL2$/.test(unameRelease);

    if (hasWSL2Marker || isWSL2Kernel) return "wsl2";

    throw new Error(
      "WSL1 detected. homework-mcp is only verified on WSL2. " +
        "Upgrade your distribution with `wsl --set-version <distro> 2`.",
    );
  }

  throw new Error(
    `Unsupported platform: ${process.platform}. ` +
      "homework-mcp supports windows / wsl2 / macos / linux only.",
  );
}

function readProcVersion(): string {
  return readFileSync("/proc/version", "utf8");
}

function readUnameRelease(): string {
  return execSync("uname -r", { encoding: "utf8" }).trim();
}
