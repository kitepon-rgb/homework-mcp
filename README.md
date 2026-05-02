# homework-mcp

Schedule a "homework" task that **opens a fresh Claude Code session in a new terminal window** at a future due time, with your prompt pre-loaded as the first user message.

For development decisions you want to revisit in N days / N weeks / N months — when your own memory is no longer reliable.

## Why this exists

When you develop fast with Claude Code, you accumulate decisions like:

- *"Watch this code for a month, then decide if it can be deleted."*
- *"Re-evaluate whether we still need a workaround in N days."*
- *"After upgrading this dependency, verify behavior in 2 weeks."*

These pile up. You forget them. They never get processed.

`homework-mcp` solves this by making the OS scheduler open a new Claude Code session at the due time, with the original prompt and an "elapsed time" header automatically prepended. You see a new terminal window appear when the time comes — the homework re-enters your awareness exactly when you said it should.

## How it differs from existing tools

| Tool | Why it doesn't fit |
|---|---|
| Claude Code `/loop` / natural-language reminders | Sessions expire in 7 days |
| Claude Desktop scheduled tasks | Requires the desktop app to be running, doesn't spawn a fresh CLI session |
| `claude.ai/code/scheduled` cloud tasks | Fully background, invisible |
| `claude_scheduler` (GitHub) | Unattended-only, daemon-style |
| `Remind Me` skill / `claude-mcp-reminders` | Notifications only, no fresh session |

The unique combination this tool delivers: **fresh session + foreground new window + multi-month horizon + auto-resume after machine restart**.

## Status

**Beta.** Tested end-to-end on Windows + WSL2 (the author's environment). macOS and Linux launchers are implemented but rely on community PRs to verify in production. See [Platform support](#platform-support).

## Install

```bash
npm install -g homework-mcp
```

Requires Node.js >= 20 and < 23 (constrained by `better-sqlite3` prebuilds).

Register with Claude Code:

```bash
claude mcp add --scope user homework npx homework-mcp
```

On first start, a config template is written to `~/.homework-mcp/config.json` and the server exits with an instructional error. Edit the template to fill in OS-specific fields, then restart.

## Configuration

`~/.homework-mcp/config.json`:

```jsonc
{
  "os_kind": "wsl2",
  "wsl_distro": "Ubuntu-22.04",
  "macos_terminal": null,
  "linux_terminal": null
}
```

| Field | Required when | Allowed values |
|---|---|---|
| `os_kind` | always | `windows` / `wsl2` / `macos` / `linux` (auto-detected) |
| `wsl_distro` | `os_kind=wsl2` | the distro name from `wsl -l -v` |
| `macos_terminal` | `os_kind=macos` | `Terminal` or `iTerm` |
| `linux_terminal` | `os_kind=linux` | `gnome-terminal` / `konsole` / `xterm` / `alacritty` / `kitty` |

Unset / unknown values cause `homework_schedule` to throw at call time. There is no silent fallback.

## Tools

### `homework_schedule(due_at, prompt, title?)`

Schedule a homework task.

```typescript
homework_schedule({
  due_at: "2026-06-02T09:00:00+09:00",
  prompt: "Check whether the auth middleware rewrite landed cleanly. Look for new bugs around session token storage.",
  title: "auth-rewrite-followup"
})
// → { id: "01...", due_at: "2026-06-02T00:00:00.000Z" }
```

- `due_at` must be ISO 8601 **with timezone offset** and **at least 5 minutes in the future**.
- `prompt` is stored verbatim in SQLite. No structure required — write it like a natural-language note.
- The current working directory of the calling process is captured automatically and used when the task fires.

When the task fires, a new terminal window opens in the original `cwd`, and a fresh `claude` session starts with this prompt as the initial user message:

```
[homework-mcp からの宿題]

このタスクは {created_at} に仕込まれたものです。
現在は {now} で、{elapsed} 経過しています。
コードベース・状況が変わっている可能性が高いため、
着手前に必ず現状を確認してください。

---
{your prompt}
```

The "elapsed time" header tells the future Claude session that conditions may have changed and to verify the current state before acting.

### `homework_list(filter?)`

List homework tasks.

```typescript
homework_list()                                   // scheduled tasks (default)
homework_list({ filter: { status: "fired" } })    // already fired
homework_list({ filter: { status: "firing" } })   // crash candidates (see below)
homework_list({ filter: { status: "cancelled" } })
```

### `homework_cancel(id)`

Cancel a scheduled task. Throws if the task does not exist or is already in `firing` / `fired` / `cancelled`.

## How firing works

```
┌─────────────────────────────────────────────────┐
│ MCP server (stdio)                              │
│   homework_schedule → INSERT row + register OS  │
│                       scheduler one-shot trigger│
└────────────┬────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│ ~/.homework-mcp/tasks.db (SQLite, WAL mode)     │
└─────────────────────────────────────────────────┘

         ~ at the due time ~

┌─────────────────────────────────────────────────┐
│ OS scheduler                                    │
│   Windows: schtasks                             │
│   WSL2:    Windows-host schtasks via cmd.exe    │
│   macOS:   launchd (LaunchAgent)                │
│   Linux:   systemd --user timer                 │
└────────────┬────────────────────────────────────┘
             │ fires fire-script with --task-id
             ▼
┌─────────────────────────────────────────────────┐
│ bin/homework-mcp-fire                           │
│   ① DB lookup, year guard, atomic UPDATE        │
│      to status='firing'                         │
│   ② Write prompt + launch script to runs/       │
│   ③ Spawn new terminal window via OS launcher   │
│   ④ status='fired', clean up plist / unit file  │
└─────────────────────────────────────────────────┘
```

### Status state machine

```
fire path:    scheduled → firing → fired
cancel path:  scheduled → cancelled
```

`firing` is an atomic checkpoint. If the fire-script crashes between `firing` and `fired`, the row stays in `firing` for human review (no auto re-fire). `homework_list({filter:{status:"firing"}})` surfaces these.

### Re-entrancy guarantee

Two concurrent fires of the same task: one wins the atomic `UPDATE WHERE status='scheduled'`, the other sees `changes()=0` and exits without launching `claude`. Verified end-to-end in tests.

## Platform support

| Platform | Tested |
|---|---|
| Windows + WSL2 | ✅ End-to-end (the author's environment) |
| Windows native | ⚠️ Implemented, not exercised by author |
| macOS | ⚠️ Beta — code present, awaiting community verification |
| Linux | ⚠️ Beta — code present, awaiting community verification |

Linux requires:
- `loginctl enable-linger $USER` (so user-systemd survives logout)
- A live GUI session at registration time (DISPLAY or WAYLAND_DISPLAY set), so the GUI terminal can be reached when the timer fires

Windows native requires `bash` on PATH (Git for Windows or the WSL launcher).

## No-fallback policy

This project follows a strict **no-silent-fallback** rule:

- Missing config fields → throw at call time, no defaults.
- Scheduler registration failure → DB row is rolled back, error propagates.
- Unknown OS / WSL1 / unconfigured Linux terminal → throw, never guess.
- Prompt files are passed via `bash $(cat <path>)` argument substitution, not stdin redirection (Claude CLI's TUI is not initialized by stdin pipes, verified empirically).

If a homework task can't be scheduled or fired correctly, you find out **now**, not at the due time when it silently fails to appear.

## Related

- [Caveat](https://github.com/kitepon-rgb/Caveat) — long-term storage of "negative knowledge" (traps), the inspiration for the elapsed-time prompt header.
- [Relay-MCP](https://github.com/kitepon-rgb/Relay) — the SQLite + MCP server pattern this project reuses.
- [Throughline](https://github.com/kitepon-rgb/Throughline) — context compression and cross-session memory carry-over.

## License

MIT — see [LICENSE](./LICENSE).

---

## 日本語

開発中に発生する「N日後／N週間後／N ヶ月後に確認したい」先送りタスクを、期日に新規 Claude Code セッションを自動起動して仕込んだプロンプトで処理させる MCP ツール。

要件:
1. 期日が来たら**新規 Claude Code セッション**が自動で立ち上がる
2. 仕込んでおいた**プロンプトを最初の user message として流し込んだ状態**で開く
3. 起動先は**新規ウィンドウ**（目に見える場所）
4. 開発中の既存セッションには**割り込まない**
5. **1ヶ月オーダー**の期日に対応する（セッション expire しない）
6. マシン停止中に期日が過ぎても**起動後に発火**する

詳細は上記英語セクションを参照してください。
