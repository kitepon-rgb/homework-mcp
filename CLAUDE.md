# homework-mcp

開発中に発生する「N日後／N週間後／N ヶ月後に確認したい」先送りタスクを、期日に新規 Claude Code セッションを自動起動して仕込んだプロンプトで処理させる MCP ツール。

## 解決する問題と要件

### 解決する問題

クオ は Claude Code を使って高速で開発を進めている。その過程で以下のような「先送り判断」が大量に発生する。

- 「このコード、1ヶ月様子を見てから削除するか判断する」
- 「N日後に対策が要るか再評価する」
- 「依存ライブラリの更新後、2週間後に挙動を確認する」

開発ペースが速すぎて、クオ の記憶だけでは期日を覚えていられない。これらの宿題が貯まる一方で消化されない状態になっている。

### 要件

1. 期日が来たら**新規 Claude Code セッション**が自動で立ち上がる
2. 仕込んでおいた**プロンプトを最初に流し込んだ状態**で開く
3. 起動先は**新規ウィンドウ**（目に見える場所）
4. 開発中の既存セッションには**割り込まない**
5. **1ヶ月オーダー**の期日に対応する（セッション expire しない）
6. マシン停止中に期日が過ぎても**起動後に発火**する

## プロジェクト位置付け

- 作者: クオ (kitepon-rgb)
- 配布: GitHub + npm (`homework-mcp`)
- 系譜: Relay-MCP / IP-MCP に続く 3 作目
- 動機: 「課題が貯まりすぎて覚えきれない」問題の解。Caveat の負の知識陳腐化思想と同じ系統で、人間の長期記憶を外部化する

## 既存ツールでは満たせない要件

「期日に**新規セッション**が**フォアグラウンド**で**1ヶ月オーダー**で自動起動する」を満たすツールは調査時点で存在しない。

| ツール | 不適合理由 |
|---|---|
| Claude Code 純正 `/loop` / 自然言語リマインダ | セッション 7 日 expire |
| Claude Desktop Cowork スケジュールタスク | アプリ常駐前提、新規 CLI セッション起動ではない |
| claude.ai/code/scheduled クラウドタスク | 完全バックグラウンド、目に見えない |
| `claude_scheduler` (GitHub) | unattended 前提、常駐ターミナル方式 |
| `Remind Me` skill / `claude-mcp-reminders` | 通知のみ |

## アーキテクチャ概観

```
┌─────────────────────────────────────────────────┐
│ 開発中の Claude Code セッション (VSCode 内)      │
│                                                  │
│   homework_schedule("2026-06-02", "...", ...)   │
│   homework_list()                               │
│   homework_cancel(id)                           │
└────────────┬─────────────────────────────────────┘
             │ MCP 呼び出し
             ▼
┌─────────────────────────────────────────────────┐
│ homework-mcp サーバー (Node.js)                  │
│                                                  │
│   ① SQLite に INSERT                             │
│   ② OS スケジューラへ 1 回限りタスク登録         │
└────────────┬─────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────┐
│ ~/.homework-mcp/tasks.db (SQLite)                │
│   id | due_at | prompt | title | cwd |           │
│   os_kind | scheduler_ref | created_at |         │
│   status | fired_at | error_message              │
└─────────────────────────────────────────────────┘

         〜 期日が来たら 〜

┌─────────────────────────────────────────────────┐
│ OS スケジューラ                                  │
│   (Windows / WSL2: schtasks                      │
│    macOS: launchd                                │
│    Linux: systemd --user timer)                  │
└────────────┬─────────────────────────────────────┘
             │ 発火
             ▼
┌─────────────────────────────────────────────────┐
│ homework-mcp 発火スクリプト                      │
│   ① DB から id でタスク取得                      │
│   ② プロンプト先頭に経過時間ヘッダ付加           │
│   ③ 新規ターミナルウィンドウで claude を起動     │
│      cwd = 仕込み時のプロジェクトルート          │
│   ④ DB を status=fired / fired_at=now に更新     │
└─────────────────────────────────────────────────┘
```

## 確定設計

| 論点 | 結論 | 理由 |
|---|---|---|
| プロンプト形式 | 構造化なし、自然言語そのまま保存 | 日常的に Claude へ指示するのと同じ形式で十分。MD メモと同じノリ |
| 起動先 | 新規ターミナルウィンドウ | 既存セッションへの割り込みは邪魔。新規ウィンドウなら気付いた時に覗ける |
| cwd | 仕込み時のプロジェクトルートを必須保存・必須使用 | 状況把握から始める以上、プロジェクト外で起動しても意味がない |
| 完了追跡 | しない。発火経路は `scheduled → firing → fired` の 3 段、cancel 経路は `scheduled → cancelled`。`firing` クラッシュは自動再発火せず人間レビュー対象 | 発火再入排除の自己防衛線。OS スケジューラのワンショット保証だけに依存しない |
| CLAUDE.md 自動チェック連携 | しない | プロジェクト内で claude が動くだけで十分 |
| 経過時間対策 | プロンプト先頭に定型句で「経過時間あり、状況確認してから着手」を自動付加 | 仕込み時から状況が変わっている前提で動かせる |
| マシン停止中の missed start | OS スケジューラ側の機能で起動時自動発火（Windows: `StartWhenAvailable=true`、macOS: launchd 既定で復帰時 catch-up、Linux: `Persistent=true`） | 起動後の自動再開は OS 機能でカバーするのが堅い |

## MCP ツール定義

```typescript
homework_schedule(
  due_at: string,    // ISO 8601 (例: "2026-06-02T09:00:00+09:00")
  prompt: string,    // Claude に流し込むプロンプト本文
  title?: string     // 任意。一覧表示・通知用の短い見出し
): { id: string, due_at: string }

homework_list(filter?: {
  status?: "scheduled" | "firing" | "fired" | "cancelled"
}): Array<{
  id: string,
  due_at: string,
  title: string | null,
  status: "scheduled" | "firing" | "fired" | "cancelled",
  cwd: string
}>
// 初期実装は filter 省略時に scheduled のみ返す。filter.status 指定時はその status のみ返す。
// firing 中の長期残留行（クラッシュ検出対象）は filter:{status:"firing"} で取得可能

homework_cancel(id: string): { ok: true }
// id が存在しない／既に firing/fired/cancelled の場合は throw（フォールバック禁止）
// firing 中の cancel を許すと再入排除が破綻するため、firing も throw 対象
```

cwd は呼び出し時のプロセスから自動取得して DB に保存（ユーザー指定不要）。

## プロンプト発火テンプレート

```
[homework-mcp からの宿題]

このタスクは {created_at} に仕込まれたものです。
現在は {now} で、{elapsed} 経過しています。
コードベース・状況が変わっている可能性が高いため、
着手前に必ず現状を確認してください。

---
{ユーザーが仕込んだ元プロンプト}
```

`{elapsed}` は人間に読みやすい形式（例: 「32 日と 4 時間」）で計算する。

## 実装スタック

- 言語: Node.js (TypeScript)
- MCP サーバー: `@modelcontextprotocol/sdk`
- DB: `better-sqlite3`
- スケジューラ呼び出し: `child_process` 経由で OS 別コマンド
- 配布: npm（`npx homework-mcp` で起動可能に）

## OS 抽象化方針

### OS 判定マトリクス

`src/os.ts` に単一関数 `detectOsKind(): OsKind` を置き、**プロセス起動時に 1 回だけ実行 → const にキャッシュ**。各 scheduler / launcher 実装はこの値で dispatch する。

| 検出条件 | `os_kind` |
|---|---|
| `process.platform === 'win32'` | `'windows'` |
| `process.platform === 'linux'` かつ `/proc/version` に `microsoft` を含み、かつ `WSL2` を含むか `uname -r` が `*-microsoft-standard-WSL2` で終わる | `'wsl2'` |
| `process.platform === 'linux'` かつ `/proc/version` に `microsoft` を含むが上記の WSL2 確定条件に合致しない（= WSL1） | **throw**（WSL1 は未検証環境、フォールバック禁止原則） |
| `process.platform === 'linux'`（`microsoft` を含まない） | `'linux'` |
| `process.platform === 'darwin'` | `'macos'` |
| 上記いずれにも該当しない（FreeBSD 等） | **throw**（フォールバック禁止原則） |

判定結果は DB の `os_kind` 列に登録時に保存する（cancel 時のクリーンアップ dispatch、マシン跨ぎ事故の検出に使う）。

### 環境別実装

**フローは 2 段構成**: OS スケジューラの Action は **`bin/homework-mcp-fire --task-id <uuid>` を呼ぶだけ**。新規ウィンドウ起動 + claude 起動は発火スクリプト（fire.js）内で OS 別 launcher を呼んで行う。これは schtasks XML `<Arguments>` の実用上 261 字制限を回避するためでもある（wt.exe + bash + claude を Action に直接乗せると WSL2 経路で 300 字超えで詰む）。

| os_kind | スケジューラ | スケジューラ Action | launcher 起動コマンド（発火スクリプト内） | ワンショット保証 |
|---|---|---|---|---|
| `windows` | schtasks (XML) | `<execPath> <fire-script> --task-id <uuid>` | `wt.exe -w new nt -d <cwd_win> -- bash -lc 'exec claude -- "$(cat <prompt_path>)"'`（`-w new` で新規ウィンドウ。`-w 0` は既存ウィンドウへの新規タブ追加になるため不可。`--` は wt の global option parser 終了マーカー。**bash コマンド内には `;` を含めない**（wt は `;` を常にサブコマンド境界として解釈し、quote 内 / `--` 後でも分割する。`$(cat <path>)` 経由のプロンプト本体は bash 内展開で wt に届かないため安全））。**bash が PATH 必須**（Git for Windows の Git Bash 等）、未存在は起動時 throw | schtasks ワンショットは自動消滅、追加処理不要 |
| `wsl2` | Windows ホスト側 schtasks（`cmd.exe /c schtasks` 経由） | `wsl.exe -d <distro> -e <execPath> <fire-script> --task-id <uuid>` | `cmd.exe /c wt.exe -w new nt -d <cwd_win> -- wsl.exe -d <distro> -e bash -lc 'exec claude -- "$(cat <prompt_path>)"'`（fire.js は WSL 内で動き、cmd.exe 経由で Windows host の wt.exe を呼ぶ。bash コマンド内に `;` 不含、上記同様） | 同上 |
| `macos` | launchd plist (`~/Library/LaunchAgents/`) | `ProgramArguments=[<execPath>, <fire-script>, "--task-id", <uuid>]` | `osascript` で Terminal.app または iTerm 新規ウィンドウ。**新規ウィンドウは確率的にならないよう `tell app "Terminal" to do script "<cmd>" in window (make new window)` 形式で強制**（iTerm は `create window`） | **発火スクリプト末尾で `launchctl bootout gui/$UID/<label>` + plist 削除**。missed start は launchd 既定で復帰時に 1 回 catch-up 発火する |
| `linux` | systemd --user timer (`OnCalendar`, `Persistent=true`) | service unit `ExecStart=<execPath> <fire-script> --task-id <uuid>` | `<config.linux_terminal>` で gnome-terminal / konsole / xterm / alacritty / kitty を起動 | **発火スクリプト末尾で `systemctl --user disable --now <unit>` + unit ファイル削除**。前提: (1) `loginctl enable-linger <user>` 必須（未実行なら登録時 throw）、(2) GUI 環境変数（`DISPLAY` / `WAYLAND_DISPLAY` / `XAUTHORITY` / `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR`）を unit の `PassEnvironment=` に列挙し、登録時に `systemctl --user import-environment` で吸い上げる。GUI セッション無し環境（ssh のみ）は登録時 throw。missed start は `Persistent=true` で復帰時 catch-up |

### 設定ファイル例 (`~/.homework-mcp/config.json`)

初回起動時に環境を自動検出して以下のような雛形を書き出す。検出結果を黙ってデフォルトに採用する形は取らない（フォールバック禁止）。ユーザーが内容を確認・必要なら修正してから先に進む。

```json
{
  "os_kind": "wsl2",
  "claude_command": "wsl.exe -d Ubuntu-22.04 -e claude",
  "terminal": "wt",
  "scheduler": "schtasks",
  "wsl_distro": "Ubuntu-22.04",
  "linux_terminal": null,
  "macos_terminal": null
}
```

- `linux_terminal` は `os_kind === 'linux'` のときのみ必須。`gnome-terminal` / `konsole` / `xterm` / `alacritty` / `kitty` のいずれか。未指定 / PATH に無いバイナリ / 既知名以外（cascade 検出はしない）は `homework_schedule` 呼び出し時に throw
- `wsl_distro` は `os_kind === 'wsl2'` のときのみ必須。複数 distro 環境で曖昧にしない。未指定なら throw
- `macos_terminal` は `os_kind === 'macos'` のときのみ必須。`Terminal` または `iTerm`。未指定 or 未知値は throw（`osascript` の AppleScript ターゲットアプリを分岐するため）

### Windows schtasks の重要設定

過去分発火（マシン停止中に期日が過ぎたタスクの起動後自動発火）と、再入排除を実現するため、XML 定義に以下が必須:

```xml
<Settings>
  <StartWhenAvailable>true</StartWhenAvailable>
  <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
  <RestartOnFailure />              <!-- 空 = 失敗時再試行なし。再入の発生源になる -->
  <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
</Settings>
```

- `StartWhenAvailable=true` がないと、期日を過ぎたタスクは起動後に発火せず無効化される
- `RestartOnFailure` が要素として存在し中身が空であれば再試行ポリシー無効。要素自体を省くと OS 既定が混入し再入の温床になる
- `ExecutionTimeLimit=PT0S` は無制限を意味し、暴走時にゾンビ化する。短時間有限値にする

### DB と OS スケジューラの整合方針

DB（SQLite）と OS スケジューラ（schtasks/launchd/systemd）は別レイヤなので、状態整合は以下の規約で取る。フォールバック禁止原則のもと、silent な事後修復はしない。

**`homework_schedule` の登録順序**: `BEGIN IMMEDIATE → INSERT → 外部スケジューラ登録 → COMMIT`。外部登録が失敗したら `ROLLBACK` して throw。これで「DB に scheduled 行があるが OS には登録なし」状態は原理上発生しない。

**`homework_cancel` の削除順序**: スケジューラ削除 → 成功なら DB を `cancelled` に更新。スケジューラ削除失敗なら DB は触らず throw（再試行可能、状態不整合無し）。「スケジューラ側に既に存在しない」も silent 吸収せず throw。

**発火スクリプトの 3 段 status 遷移**: 発火経路は `scheduled → firing → fired`。cancel 経路は別で `scheduled → cancelled`（homework_cancel から遷移、firing/fired/cancelled からの遷移は throw）。

1. 起動直後、atomic UPDATE: `UPDATE tasks SET status='firing', fired_at=:now WHERE id=:id AND status='scheduled'`。`changes()==1` でなければ throw（既に他インスタンスが処理した、cancel された、行が存在しない、のいずれか）
2. プロンプト組立 → ターミナル + claude を spawn → PID 取得を待つ
3. spawn 成功確認後、`status='fired'` に確定。spawn 失敗は `error_message` に記録して `fired` に確定（再発火しない）
4. `firing` のまま長期間残った行（プロセス SIGKILL 等）は次回起動時にクラッシュ検出として `error_message` 付きで `fired` に確定。**自動再発火しない**（人間レビュー対象、`homework_list` の別フィルタで取得可能にする）
5. 最後に OS スケジューラの自己 cleanup（macOS: bootout + plist 削除、Linux: disable + unit 削除、Windows: 自動消滅で何もしない）

**プロンプトの渡し方（中間 bash + 引数渡し）**: claude CLI の正規の prompt 渡しはコマンドライン引数（`claude [prompt]`）。stdin リダイレクト（`claude < <path>`）は claude が stdout 非 TTY を non-interactive 扱いする仕様のため対話 TUI を起動しない。よって以下の経路に固定する:

1. 発火時に `~/.homework-mcp/runs/<uuid>.txt` へプロンプト本文（経過時間ヘッダ付き）を UTF-8 で書き出し
2. ターミナル起動コマンドラインは固定文字列のみ:
   ```
   bash -lc 'exec claude -- "$(cat ~/.homework-mcp/runs/<uuid>.txt)"'
   ```
3. `$(cat <path>)` は bash の command substitution（quote 内）で cat 出力を 1 個の引数として展開する。プロンプト本体に `"`, 改行, `$(...)`, バッククォート, `%VAR%` が含まれていても、cat 出力は文字列としてそのまま argv に乗り、シェルで再評価されない
4. `--` で位置引数の境界を明示し、prompt が `-` で始まる文字列でも安全に渡す
5. `<path>`（一時ファイルパス）と `<cwd>` は Node 側で「英数 + `/` + `_` + `-` + `.` + `:`（Windows ドライブ用）+ `\\`（Windows パス区切り用）+ ` `（空白、ただし全体を quote で囲む）」のホワイトリスト検証、外れたら throw（path injection 防止）。**`%` / `$` / `;` / `` ` ``  / `&` / `|` / `(` / `)` / `<` / `>` / `\n` は不許可**（cmd の `%` 展開、bash の `$`、wt のサブコマンド境界 `;` 等を防ぐ）
6. プロンプト本文の SQL 等エスケープは不要（DB は parameterized binding、シェルは cat 経由）

直接 `claude "プロンプト全文"` のような文字列結合は禁止（テンプレート文字列で組むと `"` や改行で破綻する）。**Node 側で argv を組み立て、bash の `$(cat <path>)` 経由で claude に渡す**のが唯一の正解。

**SQLite の並行制御**: 発火スクリプトと MCP サーバーが同一 DB を並走するので、`db.ts` 初期化時に `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;` を発行。

**絶対パス焼き込み**: OS スケジューラは MCP サーバーと独立に発火するので `process.cwd()` も `~` 展開も使えない。発火スクリプトのフルパス、DB パス、Node のフルパス（`process.execPath`）を**登録時にスナップショット**して XML / plist / unit ファイルに埋め込む。nvm で Node パスが動的に変わる環境では、登録後に Node バージョンを切り替えると発火不能になることを許容する（フォールバック禁止のもとで正しい挙動）。

## 初期リリース範囲（決定済み）

**Windows+WSL2 / macOS / Linux を初期リリースから含める。**

理由: 後追いで OS を増やす設計コストより、最初から OS 抽象化レイヤを正しく切る方が結果的に早い。

## 既知の罠（実装時に効く）

- **Windows: Node `spawn('claude', ...)` は ENOENT で失敗する**。`claude` は `.cmd` ラッパーのため、Node から直接 spawn できない。本プロジェクトでは `wt.exe` 経由で起動するためこの問題を回避できるが、claude のパス検出ロジックを書く時は要注意
- **Claude Code は settings.json の hooks を hot-reload しない**。本プロジェクトには直接関係しないが、開発中に hook を書いた場合 session 再起動が必要
- **`/proc/version` の `microsoft` だけでは WSL1/WSL2 を区別できない**。WSL1 はカーネルが Linux ではなく互換レイヤで `wsl.exe -e` の挙動が WSL2 と微妙に異なる。`WSL2` 文字列か `uname -r` 末尾で確定すること
- **systemd --user は lingering 無効環境で session 終了と共に死ぬ**。`loginctl enable-linger <user>` 未実行の Linux で OnCalendar timer を登録すると、ssh ログアウト後に発火しない。検出して throw、手動実行を要求する
- **systemd --user で起動したサービスは GUI 環境変数を持たない**。`DISPLAY` / `WAYLAND_DISPLAY` / `XAUTHORITY` / `DBUS_SESSION_BUS_ADDRESS` 不在では `gnome-terminal` (DBus 経由) も `xterm` (X11) も起動できず即 fail。対策: (1) unit の `[Service]` に `PassEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR` を必須、(2) 登録時に `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR` を実行（クオ の GUI 環境変数を user manager に吸い上げる）、(3) GUI セッション不在（ssh のみ）の環境は登録時 throw（`$DISPLAY` と `$WAYLAND_DISPLAY` が**両方空**なら検出可能。Wayland-only 環境では `$DISPLAY` が空でも `$WAYLAND_DISPLAY` があれば動くため、両方の OR 条件で判定）
- **launchd / systemd の `OnCalendar` 系は本質的に繰り返し**。年フィールドが無い、または翌年同月同日に再発火する。発火スクリプトで自身を bootout/disable + ファイル削除しないとワンショットにならない
- **WSL2 経由のコマンド実行は引用符が二重展開される**。Windows cmd → WSL login shell の 2 段で展開されるため、引数文字列にプロンプト本文を乗せると壊れる。プロンプトはファイルに書き出し、bash の `$(cat <path>)` 経由で claude に引数渡しする（command substitution は quote 内なら 1 個の引数として展開）
- **WSL2 から Windows 側 schtasks に渡す一時ファイルは `wslpath -w` で Windows 解釈可能パスに変換必須**。`/tmp` の XML は schtasks から見えない
- **OS スケジューラへの登録は絶対パス焼き込みが必須**。発火時には `process.cwd()` も `~` 展開も使えない。`process.execPath`（Node のフルパス）を登録時にスナップショットして埋め込む。nvm でバージョン切替後に発火不能になることは許容（フォールバック禁止のもとで正しい挙動）
- **claude CLI は stdin リダイレクト (`claude < <path>`) で対話 TUI を起動しない**。`-p, --print` の説明にあるとおり stdout 非 TTY なら自動的に non-interactive モードに落ちる。正規の prompt 渡しはコマンドライン引数（`claude [prompt]`）。本プロジェクトでは中間 bash + `$(cat <path>)` 経由で argv に乗せる
- **`wt.exe -w 0` は新規ウィンドウを開かない**。`-w 0` は「最も新しく使われた window id」エイリアスで既存ウィンドウへ新規タブ追加になる。新規ウィンドウは **`-w new`** が正解
- **wt.exe は `;` を常にサブコマンド境界として解釈する**（quote 内 / `--` の後ろでも例外なく分割する。エスケープは `\;` のみ）。bash コマンド本体に `;` を含めると意図せず複数タブに分裂し、後半は wt のサブコマンドとして実行されて「指定されたファイルが見つかりません」エラーになる。本プロジェクトでは bash コマンド本体は `bash -lc 'exec claude -- "$(cat <path>)"'` のみで `;` を含まず、プロンプト本体は `$(cat <path>)` 経由で bash 内展開のため wt には到達しない。cwd / prompt_path のホワイトリストでも `;` を不許可にして残る侵入経路を塞ぐ
- **Windows での Node `child_process.spawn` は argv 配列で渡す**。`spawn('cmd.exe', '/c wt.exe ...')` のような shell 文字列渡しは禁止。多重 shell 解釈（cmd.exe → wt.exe → wsl.exe → bash）で quote が落ちる。`spawn('cmd.exe', ['/c', 'wt.exe', '-w', 'new', 'nt', '-d', cwdWin, '--', 'wsl.exe', '-d', distro, '-e', 'bash', '-lc', innerCmd])` のように要素ごとに渡す。`windowsVerbatimArguments` の挙動は spawn の対象によって異なるため、Phase 4 実機検証で最終 bash に届く時点で quote が保たれていることを確認
- **schtasks の XML は UTF-16 LE BOM 付きで渡す**。schtasks は UTF-8 BOM 付きの XML を「ファイル形式が無効」で拒否することがある。`iconv -f UTF-8 -t UTF-16LE` + BOM 付与で確実に通る
- **schtasks XML の `<Arguments>` 実用 261 字制限**。wt.exe + bash + claude を Action に直接乗せる設計だと WSL2 経路で 303 字に達して詰む。Action は `<execPath> <fire-script> --task-id <uuid>` のみに限定し、wt.exe + claude は発火スクリプト内で組み立てる二段構成にする
- **macOS launchd `StartCalendarInterval` は年フィールドを持たない**。同月同日同時刻に翌年再発火するため、self-bootout が間に合わなかった場合の保険として、発火スクリプト冒頭で「`due_at` の年と現在の年が一致しなければ exit 0」の年 guard を入れる
- **過去日時で OS スケジューラに登録すると即発火する**（launchd の missed run catch-up、systemd `Persistent=true`、schtasks `StartWhenAvailable=true`）。`due_at >= now + 5 分` を `homework_schedule` でバリデーションし、登録後の反映遅延と race を吸収する
- **better-sqlite3 の prebuilt binary は Node の `MODULE_VERSION` に厳密**。`engines.node` を prebuilt がある範囲（例: `>=20 <23`）に固定しないと、レンジ外で再ビルドに落ち、Windows では VS Build Tools 必須で詰む

## ディレクトリ構成（予定）

```
homework-mcp/
├── CLAUDE.md            ← このファイル
├── README.md
├── package.json
├── tsconfig.json
├── docs/
│   └── PLAN.md          ← 実装計画
├── src/
│   ├── index.ts         ← MCP サーバー entry
│   ├── os.ts            ← OS 判定（detectOsKind）
│   ├── db.ts            ← SQLite スキーマ + アクセス層
│   ├── scheduler/       ← OS 別スケジューラ実装
│   │   ├── index.ts     ← OS 検出 + dispatch
│   │   ├── windows.ts
│   │   ├── wsl2.ts      ← Windows ホスト側 schtasks に cmd.exe /c 経由で登録
│   │   ├── macos.ts
│   │   └── linux.ts
│   ├── launcher/        ← 発火時のターミナル起動
│   │   ├── index.ts
│   │   ├── windows.ts
│   │   ├── wsl2.ts      ← wt.exe -w new nt -d <cwd_win> -- wsl.exe -d <distro> -e bash -lc 'exec claude -- "$(cat <prompt_path>)"'
│   │   ├── macos.ts
│   │   └── linux.ts
│   ├── tools.ts         ← MCP ツール定義
│   ├── prompt.ts        ← 発火テンプレート組み立て
│   └── fire.ts          ← 発火スクリプト本体（bin/homework-mcp-fire の実体）
├── bin/
│   ├── homework-mcp       ← MCP サーバー entry（npx homework-mcp で起動）
│   └── homework-mcp-fire  ← 発火スクリプト本体（OS スケジューラから呼ばれる）
└── data/
    └── tasks.db         ← gitignore 対象
```

実 DB の置き場所は `~/.homework-mcp/tasks.db`、リポジトリ内の `data/` は開発時のみ。

## 関連プロジェクト

- [Caveat](https://github.com/kitepon-rgb/Caveat) — 負の知識（罠）の永続化と検索。本プロジェクトの「経過時間プロンプト前置」の発想元
- [Relay-MCP](https://github.com/kitepon-rgb/Relay) — SQLite + MCP サーバーの実装パターン参照元
- [IP-MCP] — npm 配布形式の参照元
- [Throughline](https://github.com/kitepon-rgb/Throughline) — context 圧縮、`/clear` 後のセッション間記憶引継ぎ

## ユーザー (クオ) の環境前提

- メイン PC: Windows + WSL2、Claude Code は WSL2 側で運用（2026-05 にネイティブから移行済み）
- VSCode で開発、その中の Claude Code セッションが主戦場
- Ollama は Windows ネイティブ
- macOS / Linux 環境は持っていない可能性が高い → クロスプラットフォーム実装は WSL2 で書きつつ実機テストは PR 受付で補う方針もあり得る

## 開発時の指針（クオ の鉄則と整合）

- **フォールバック禁止（絶対原則）**: やむを得ない場合を除き、silent catch / デフォルト埋め込み / cascade 検出を書かない。設定欠落・登録失敗・環境未検出は起動時 throw。「動いてる風」で進める方が後で痛い、というのが クオ の確立した方針（Relay-MCP / Spotter でも同方針）
  - 例: Linux のターミナルを `gnome-terminal` → `konsole` → `xterm` と順番に試すのは禁止。`config.json` で明示させ、未指定または不在なら **エラー** で停止
  - 例: `homework_schedule` は `BEGIN IMMEDIATE → INSERT → 外部スケジューラ登録 → COMMIT/ROLLBACK` の順序でトランザクション境界を切る。外部登録失敗時は ROLLBACK して throw、DB に scheduled 行が残らないことを原理的に保証する
  - 例: `homework_cancel` は **スケジューラ削除 → 成功なら DB を `cancelled` に更新** の順。スケジューラ削除失敗時に DB を進めない。「スケジューラ側に既に存在しない」も silent 吸収せず throw
  - 例: プロンプト本文をシェル引数に文字列結合して渡さない。`"`, 改行, `$(...)` で破綻する。**外部ファイル + 中間 bash の `$(cat <path>)` 経由で claude に引数渡し**に固定する（claude CLI は stdin リダイレクトでは対話モードを起動しないため）
  - 例: 「方式 A 試して駄目なら B、最悪 xdotool」のような cascade は禁止。claude CLI が引数渡しに非対応なら blocker として停止
  - 例: 起動時の予防的整合チェック（DB と OS スケジューラの reconcile）は入れない。発火スクリプトの atomic UPDATE と self-defense（行なし or status 不一致なら throw）で十分。予防的修復は silent 修復に堕ちやすい
  - 例: `try { ... } catch { return defaultValue }` のような書き方をしない
- **過剰設計しない**: 1 回しか使わない柔軟性は入れない、起こり得ないエラーハンドリングは書かない
- **抽象化は 3 回目から**: OS 別実装はそれぞれ独立に書き、共通項が見えてから抽象を抜く
- **コメント最小**: 識別子で意図が伝わるなら書かない。「なぜ」だけ書く（罠の存在、非自明な制約）
- **依頼外の改善禁止**: 隣接コードのリファクタや「ついでに直す」をしない
