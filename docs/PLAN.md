# homework-mcp 実装計画

## 0. 前提と決定事項

### 絶対原則: フォールバック禁止

**やむを得ない場合を除き、フォールバック・silent catch・デフォルト埋め込み・cascade 検出は禁止。失敗は素直に throw**。クオ の確立した方針（Relay-MCP / Spotter と同じ no-silent-fallback ポリシー）。

本計画書の以下の判断はすべてこの原則に従う:
- 環境検出で複数候補を順に試すコードは書かない（指定必須 + 未指定エラー）
- スケジューラ登録失敗時の DB rollback 必須（行が残る silent failure 禁止）
- 設定欠落は起動時 throw、起動後に黙って動かない

### 確定済み（前セッションで合意）

- 動作仕様、設計判断（プロンプト形式、起動先、cwd 必須、完了追跡なし、経過時間プロンプト前置）
- MCP ツール 3 種（`homework_schedule` / `homework_list` / `homework_cancel`）
- 実装スタック（TypeScript + better-sqlite3 + @modelcontextprotocol/sdk）
- OS 抽象化方針（4 環境）

### 本セッションで決定

- **初期リリースから Windows+WSL2 / macOS / Linux 全対応**
  - 理由: OS 抽象化レイヤを後から正しく切るコストの方が高い。最初から 3 OS で作って共通項を炙り出す
  - 実機テスト方針: クオ の手元は Windows+WSL2 のみ。**macOS / Linux はβ扱い**で初期リリース。README に「Windows+WSL2 のみ実機テスト済み、macOS/Linux はベータ」と明記し、PR 受付で実機検証を補う
- **フォールバック禁止を全フェーズで貫く**（上記）
- **配布**: npm package 名は `homework-mcp`（無スコープ、取れる前提）
- **GitHub**: `kitepon-rgb/homework-mcp` を public で作成
- **README 言語**: 英語中心、日本語をサブとして併記
- **ライセンス**: MIT
- **status の 3 段化**: 発火経路は `scheduled → firing → fired` の 3 段、cancel 経路は `scheduled → cancelled`。発火スクリプトの atomic UPDATE で再入排除（CLAUDE.md「DB と OS スケジューラの整合方針」参照）
- **DB トランザクション境界**: `homework_schedule` は `BEGIN IMMEDIATE → INSERT → 外部登録 → COMMIT/ROLLBACK`。`homework_cancel` は スケジューラ削除 → 成功なら DB UPDATE
- **プロンプト渡し**: 外部ファイル + 中間 bash の `$(cat <path>)` 経由で claude に引数渡し。claude CLI の stdin リダイレクトは対話 TUI を起動しないため不可。直接的なシェル文字列結合（テンプレート文字列でプロンプト本体を埋め込む）も禁止
- **起動時 reconcile はしない**: 発火スクリプトの self-defense で十分。予防的整合チェックは silent 修復に堕ちやすいため過剰設計

## 1. 実装フェーズ

各フェーズは「**動く検証手段**」で締める。動かない状態で次に進めない。

### Phase 1: 雛形 + DB スキーマ + OS 判定

**ゴール**: `npx homework-mcp` で MCP サーバーが起動し、stdio で接続できること。DB ファイルが作られること。OS 判定が起動時に走り、未対応 OS なら起動拒否（throw）すること。

成果物:
- `package.json` (name, bin, dependencies, scripts)
- `tsconfig.json`
- `.gitignore` (`node_modules/`, `dist/`, `data/`, `*.db`)
- `src/index.ts` — `@modelcontextprotocol/sdk` の `Server` を起動するだけ。起動時に `detectOsKind()` を呼んで結果をモジュールレベル const に保持
- `src/os.ts` — `OsKind` 型と `detectOsKind()`。CLAUDE.md のマトリクスに 1:1 対応。未対応 OS は throw。**WSL1 は `/proc/version` に `microsoft` を含むが `WSL2` 文字列も `*-microsoft-standard-WSL2` 末尾も無いので throw**（未検証環境）
- `src/db.ts` — SQLite open + スキーマ作成 + 簡単な CRUD 関数。**初期化時に `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000` を発行**（発火スクリプトと MCP サーバーの並走対応）

**DB スキーマ**:

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,         -- UUID v7
  due_at          TEXT NOT NULL,            -- ISO 8601
  prompt          TEXT NOT NULL,            -- 仕込んだ自然言語そのまま
  title           TEXT,                     -- 任意、UI 表示用
  cwd             TEXT NOT NULL,            -- 仕込み時のプロジェクトルート
  os_kind         TEXT NOT NULL,            -- 'windows' | 'wsl2' | 'macos' | 'linux'
  scheduler_ref   TEXT NOT NULL,            -- OS スケジューラ側の識別子（例: 'homework_<uuid>' / launchd plist パス）
  created_at      TEXT NOT NULL,            -- ISO 8601
  status          TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | firing | fired | cancelled
  fired_at        TEXT,                     -- ISO 8601、firing/fired 遷移時にセット（遅延発火の検出用）
  error_message   TEXT                      -- 発火失敗時のみ書く。登録失敗は ROLLBACK で行が残らないため使わない。`firing` でクラッシュ → 次回起動時に検出して error_message + status='fired' に確定（自動再発火しない）
);

-- 主要クエリ「status='scheduled' を due_at 昇順で取得」を 1 本でカバー
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);
```

**列の用途まとめ**:

| 列 | 用途 |
|---|---|
| `os_kind` | cancel 時のクリーンアップ dispatch、マシン跨ぎ事故の検出（DB を別 OS にコピーした時に気付ける） |
| `scheduler_ref` | `homework_cancel` で OS スケジューラ側からも消すための識別子。**列名と OS スケジューラ側の識別子は 1:1 対応** |
| `fired_at` | マシン停止で遅延発火した時に「何分遅れて起きたか」が分かる |
| `error_message` | 発火スクリプトが起動はしたが claude 起動に失敗した等、発火時のみ使う |

**検証**: `npx homework-mcp` 起動後、別プロセスから MCP プロトコルで `initialize` が通ること、`~/.homework-mcp/tasks.db` が作られていること。

### Phase 2: MCP ツール 3 種

**ゴール**: Claude Code から 3 ツールが呼べて、DB が正しく更新されること。**スケジューラ登録はまだしない**（次フェーズ）。

成果物:
- `src/tools.ts` — `homework_schedule` / `homework_list` / `homework_cancel` の handler
- `src/prompt.ts` — 発火プロンプトテンプレート組み立て関数（経過時間計算込み）

**`homework_schedule` の挙動**:
1. 引数バリデーション — 不正なら throw
   - `due_at` が ISO 8601 でタイムゾーン付き（オフセット無しは throw）
   - `due_at` が**現在時刻 + 5 分以上**先（過去日時 throw、近すぎる未来も throw — schtasks 登録反映遅延 + launchd/systemd の missed run 即発火を吸収するためのマージン）
   - `prompt` が非空
2. `cwd` を `process.cwd()` から取得（呼び出し元プロセスの cwd）。ホワイトリスト検証は CLAUDE.md「DB と OS スケジューラの整合方針 / プロンプトの渡し方」の規約に準拠（英数 + `/` + `_` + `-` + `.` + `:` + `\\` + 空白、`%` / `$` / `;` / `` ` `` / `&` / `|` / `(` / `)` / `<` / `>` / `\n` は不許可）。外れたら throw
3. UUID v7 生成
4. `detectOsKind()` で `os_kind` を確定（プロセス起動時にキャッシュ済み）
5. `scheduler_ref` を `homework_<uuid>` 形式で生成（OS 別実装で同じ規約を共有）
6. **トランザクション境界**: `BEGIN IMMEDIATE` → INSERT（`status='scheduled'`、`fired_at=NULL`、`error_message=NULL`）→ 外部スケジューラ登録 → 成功なら `COMMIT`、失敗なら `ROLLBACK` して throw。これで「DB に scheduled 行があるが OS には登録なし」状態は原理上発生しない
7. `{ id, due_at }` を返す（受理確認のため `due_at` も echo back）

**`homework_list` の挙動**: 引数 `filter?: { status?: ... }` を受け、省略時は `scheduled` のものを `due_at` 昇順で返す。`filter.status` 指定時はその status のみ返す。返却フィールドは `{ id, due_at, title, status, cwd }`。`firing` で残っている行（クラッシュ検出対象）は `filter:{status:"firing"}` で取得可能。

**`homework_cancel` の挙動**:
1. DB から id で task を読み込み。**存在しない／既に `firing` / `fired` / `cancelled` ならその時点で throw**（フォールバック禁止 — silent な no-op を避ける）
2. **スケジューラ側を先に削除**。失敗なら DB は触らず throw（再試行可能、状態不整合無し）
3. スケジューラ削除成功後、DB の status を `cancelled` に更新
4. `{ ok: true }` を返す

注: 「スケジューラ側に既に存在しない」も silent 吸収せず throw（OS 側で誰かが消した、想定外の状態として人間レビュー）

**検証**: 開発中の Claude Code から MCP ツール呼び出し → DB に行が増える、`homework_list` で読み戻せる、`homework_cancel` で消せる。

### Phase 3: スケジューラ実装（OS 別）

**ゴール**: Phase 2 の `homework_schedule` で実際に OS スケジューラに登録され、期日に発火スクリプトが起動すること。**ただし発火スクリプト本体は次フェーズ**（このフェーズでは「ログを書くだけのダミー」で発火確認）。

成果物:
- `src/scheduler/index.ts` — OS 検出 + dispatch
- `src/scheduler/windows.ts` — `schtasks /Create` で XML 食わせる、`StartWhenAvailable=true` 必須、`RestartOnFailure` 空要素、`ExecutionTimeLimit=PT1H`。`process.execPath` と fire-script パスは絶対パスで XML に焼き込み。**起動時に `bash.exe` の PATH 解決を試行、未存在なら throw**（Git for Windows 等を要求）。**XML の `<Actions>/<Exec>/<Command>` には `process.execPath` を、`<Arguments>` には `<fire-script> --task-id <uuid>` のみを書く**（wt.exe + claude は発火スクリプト内で組み立てる、261 字制限回避）
- `src/scheduler/wsl2.ts` — WSL2 から Windows ホスト側 schtasks に登録。`config.json` の `wsl_distro` を必須参照（未指定 throw）。一時 XML は `wslpath -w "$(mktemp)"` で Windows 解釈可能パスに変換、**UTF-16 LE BOM 付きで書き出し**（schtasks は UTF-8 BOM を拒否することがある）。**XML の `<Command>` には `wsl.exe`、`<Arguments>` には `-d <distro> -e <execPath> <fire-script> --task-id <uuid>` を書く**（実測 173 字、261 字制限内）
- `src/scheduler/macos.ts` — `launchd` plist を `~/Library/LaunchAgents/` に書いて `launchctl load`。`KeepAlive=false`, `RunAtLoad=false` 明示、`StartCalendarInterval` で月日時分指定（年フィールドは launchd に存在しない）。発火スクリプトの self-bootout + 冒頭の年 guard で翌年同月同日同時刻の意図しない再発火を抑える。**plist の `ProgramArguments` は配列形式 `[<execPath>, <fire-script>, "--task-id", <id>]` で書き、`Program` 単独だと引数が渡らないので使わない**。osascript による新規ウィンドウ起動は発火スクリプト内（launcher/macos.ts）の責務
- `src/scheduler/linux.ts` — `systemd --user` の `OnCalendar` timer + `Persistent=true`。`at` コマンドへのフォールバックはしない。**登録時に以下の前提チェックを順に実行、失敗で throw**:
  1. `loginctl show-user $UID --property=Linger` を確認、`Linger=no` なら throw（`loginctl enable-linger <user>` の手動実行を要求、sudo を要するので自動化しない）
  2. 環境変数 `DISPLAY` または `WAYLAND_DISPLAY` の存在を確認、両方空なら throw（GUI セッション不在環境では発火しても表示先が無い）
  3. `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR` を実行（クオ の現セッション環境変数を user manager に吸い上げ）
  4. service unit に以下を含めて生成:
     - `[Service]` `PassEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR`
     - `ExecStart=<execPath> <fire-script> --task-id <id>` — `process.execPath`（node のフルパス）と fire-script の絶対パスを焼き込み。bash wrap せず直接 exec（CLAUDE.md「環境別実装」表と一致、Windows / WSL2 / macOS と粒度を揃える）
     - `ExecStartPost=` で発火 service の self-disable は不要（発火スクリプト内で実施）
- `src/launcher/dummy.ts` — `~/.homework-mcp/fired.log` に id と発火時刻を書くだけ。**Phase 3 限定の検証用**で、Phase 4 の OS 別 launcher 実装と同時に削除する（CLAUDE.md のディレクトリ構成には載せない）

**Windows + WSL2 の判定**: CLAUDE.md「OS 判定マトリクス」参照。`microsoft` 含む + `WSL2` または `*-microsoft-standard-WSL2` で確定。

**3 分後に発火するテストタスク**を作って、各 OS で動作確認:
1. `homework_schedule({ due_at: 3分後, prompt: "test" })`
2. 3 分待つ
3. `~/.homework-mcp/fired.log` に書き込まれていること
4. OS スケジューラから自動的にタスクが消えていること（macOS: 自己 bootout、Linux: 自己 disable + unit unlink、Windows: ワンショットの自動消滅）

**追加の検証項目（OS スケジューラの自己 cleanup と新規ウィンドウ）**:
- macOS: 発火後 plist が `~/Library/LaunchAgents/` から消えていること
- Linux: 発火後 unit ファイルが消え、`systemctl --user list-timers` に出ないこと
- Windows: `wt.exe -w new nt` で**毎回新規ウィンドウ**が開くこと（既存ウィンドウへタブ追加にならないこと）
- Windows / WSL2: schtasks XML の `<Arguments>` 実測長確認。Action を「fire-script 呼出のみ」に限定する設計のため Windows native 131 字 / WSL2 173 字（実測済み）で 261 字制限内に収まる。新規ウィンドウ起動と claude 引数渡しは発火スクリプト内で行う

注: 同一 id の二重発火耐性検証（atomic UPDATE による再入排除）と launchd の年 guard 検証は **Phase 4** で実施（発火スクリプト本体に atomic UPDATE と年 guard を入れるため）。Phase 3 のダミー launcher は `fired.log` への書き込みのみで、再入排除骨格は持たない。

**検証**: 上記が Windows+WSL2 / macOS / Linux すべてで通る。**ここで通らないなら次に進めない**。macOS / Linux はβ扱いだが Phase 3 は実機（VM 含む）で 1 回は通すこと。

### Phase 4: 発火スクリプト本体（ターミナル起動）

**ゴール**: 期日に新規ターミナルウィンドウが開いて、cwd に移動して claude が起動し、プロンプトが流し込まれること。

**プロンプト渡しは中間 bash + 引数渡し**（決定済み）: `bash -lc 'exec claude -- "$(cat <path>)"'`。claude CLI の正規 prompt 渡しはコマンドライン引数（`claude [prompt]`）。stdin リダイレクトは stdout 非 TTY を non-interactive 扱いする仕様で対話 TUI を起動しないため不可。詳細は CLAUDE.md「DB と OS スケジューラの整合方針」参照。

成果物:
- `bin/homework-mcp-fire`（実体は `src/fire.ts` をビルドした成果物） — 引数: `--task-id <id>`。発火スクリプト擬似コード:
  ```
  1. DB lookup: SELECT * FROM tasks WHERE id=:id
     - 行なし → throw + scheduler_ref から自身を unregister
     - status != 'scheduled' → throw（既に処理済み or cancelled）
  2. 年 guard（macOS の launchd 再発火対策）:
     - due_at の年 != 現在の年 → exit 0（翌年同月同日同時刻の意図しない再発火を抑える）
  3. atomic UPDATE: UPDATE tasks SET status='firing', fired_at=:now
                    WHERE id=:id AND status='scheduled'
     - changes() != 1 → throw（race で他インスタンスに取られた）
  4. プロンプト組立: prompt.ts で経過時間ヘッダ付加 →
                    ~/.homework-mcp/runs/<uuid>.txt に UTF-8 で書き出し
  5. 新規ターミナル + claude を spawn:
     - OS 別 launcher を呼ぶ（各 launcher が cwd の渡し方を分担: Windows/WSL2 は `wt.exe -d <cwd_win>` でターミナル側に渡し bash 本体は `bash -lc 'exec claude -- "$(cat <path>)"'`、xterm のみ `--working-directory` 非対応のため bash 内で `cd <cwd> && exec claude ...`、他は terminal の cwd 引数を使用）
     - PID 取得を待つ（spawn 成功確認）
     - spawn 失敗 → error_message 記録、status='fired' に確定（再発火しない）
  6. spawn 成功後:
     - status='fired' に確定
     - OS 別 self-cleanup:
       - macOS: launchctl bootout gui/$UID/<label> + plist 削除
       - Linux: systemctl --user disable --now <unit> + unit ファイル削除
       - Windows: schtasks のワンショットは自動消滅、何もしない
     - 一時ファイル ~/.homework-mcp/runs/<uuid>.txt は残す（デバッグ用、別途 retention で掃除）
  ```
- `src/launcher/windows.ts` — `wt.exe -w new nt -d <cwd_win> -- bash -lc 'exec claude -- "$(cat <prompt_path>)"'`。`--` は wt の global option parser 終了マーカー（`;` の境界解釈は `--` でも防げないが、本コマンドは bash 本体に `;` を含まないため安全）。`bash` は Git for Windows 等を PATH 必須（scheduler/windows.ts 起動時にチェック済み）。`cwd` と一時ファイルパスはホワイトリスト検証
- `src/launcher/wsl2.ts` — `cmd.exe /c wt.exe -w new nt -d <cwd_win> -- wsl.exe -d <distro> -e bash -lc 'exec claude -- "$(cat <wsl_path>)"'`。**`<cwd_win>` は WSL 側の cwd を `wslpath -w` で Windows 形式（`C:\...`）に変換した値**（cmd.exe は UNC パス `\\wsl.localhost\...` を current directory として扱えない）。`<wsl_path>` は WSL 側の絶対パス
- `src/launcher/macos.ts` — `config.macos_terminal` で分岐:
  - `Terminal`: `osascript -e 'tell application "Terminal" to do script "cd <cwd> && exec claude -- \"$(cat <path>)\"" in window (make new window)'` — **`in window (make new window)` で新規ウィンドウを強制**（`do script` 単独だと最前面 window 設定次第で既存に割り込む）
  - `iTerm`: `osascript -e 'tell application "iTerm" to create window with default profile command "bash -lc ..."'` — iTerm は `create window` で新規ウィンドウ強制
- `src/launcher/linux.ts` — `config.linux_terminal` で argv テンプレートを切替（`-e` の後の引数渡し方が terminal ごとに違う点に注意）:
  - `gnome-terminal --working-directory=<cwd> -- bash -lc 'exec claude -- "$(cat <path>)"'`（`--` 後は argv ベクター）
  - `konsole --workdir <cwd> -e "bash -lc 'exec claude -- \"\$(cat <path>)\"'"` — **`-e` の後は単一文字列**（konsole が `-lc` を自分の引数と誤解するのを防ぐ）
  - `xterm -hold -e bash -lc 'cd <cwd> && exec claude -- "$(cat <path>)"'` — **`-hold` 必須**（claude exit 時に window が消えてエラーログを見失わないため）。xterm は `--working-directory` 非対応のためシェルで cd
  - `alacritty --working-directory <cwd> -e bash -lc 'exec claude -- "$(cat <path>)"'`
  - `kitty --directory <cwd> bash -lc 'exec claude -- "$(cat <path>)"'`
  - 上記 5 種以外は throw（cascade 検出はしない）

**`firing` クラッシュ検出**:
- MCP サーバー起動時に `SELECT * FROM tasks WHERE status='firing'` で該当行を全件取得
- 各行を `error_message='firing 中にクラッシュ、claude 起動未確認'` + `status='fired'` に確定（**自動再発火しない**、人間レビュー）
- これは「予防的整合チェック」ではなく「自プロセスが過去に残した中間状態の確定処理」なのでフォールバック禁止と矛盾しない

**検証**:
- 各 OS で 3 分後発火テスト → 新規ウィンドウが開いて claude が起動し、プロンプトが流れ込むこと
- プロンプトに `"`, 改行, `$(echo INJECT)`, バッククォートを含めて壊れないことを確認（command substitution の quote 内展開で 1 個の引数として安全に渡ること）
- 二重発火耐性: 同一 id を `schtasks /Run` 等で 2 回連続発火させて、`status` が `firing` → `fired` に 1 回だけ遷移すること（atomic UPDATE で 2 回目は `changes()=0` で throw exit）
- 年 guard: macOS で `due_at` の翌年同時刻にスクリプトを手動起動 → 年比較で exit 0 になり claude が起動しないこと
- **Node spawn の argv 組み立てで quote エスケープが壊れないこと**: 設計確定段階の WSL2 検証で `cmd.exe /c "wt.exe ... -- wsl.exe ... bash -lc '...'"` を shell 経由で叩くと多重解釈で single quote が落ちる事象を確認。本物の launcher は `child_process.spawn('cmd.exe', ['/c', 'wt.exe', '-w', 'new', ...])` の argv 配列形式で実装し、shell 解釈を最後の `bash -lc` 1 段に絞る。Windows は `windowsVerbatimArguments` の取り扱いに注意（cmd.exe / wt.exe / wsl.exe それぞれが内部で lpCommandLine を再 parse するため、最終的に bash に届く時点で quote が保たれていることを実機確認）

### Phase 5: README + 配布準備

**ゴール**: `npm publish` でリリースできる状態。

成果物:
- `README.md` — インストール手順、ツール仕様、各 OS のセットアップ前提（macOS: Terminal.app オートメーション権限、Linux: `linux_terminal` の明示指定 + `loginctl enable-linger` 実行、WSL2: `wsl_distro` の明示指定、等）
- `LICENSE` (MIT)
- `package.json` の `bin` / `files` / `engines` フィールド整備
  - `bin`: `homework-mcp` (MCP サーバー) と `homework-mcp-fire` (発火スクリプト) の 2 entry を登録
  - `engines.node`: better-sqlite3 prebuilt がある範囲（例: `>=20 <23`）に固定。レンジ外は再ビルド必須で Windows では VS Build Tools が要るため詰む
- `npm pack` で生成される tarball の中身確認

## 2. 実装時のリスクと実機確認項目

設計判断は決定済み（0 節）。以下は実装時に実機で確認が要る点・OS 固有のリスクをまとめたもの。

### claude CLI の prompt 渡し方式（決定済み）

`claude --help` 精読の結果、正規の prompt 渡しはコマンドライン引数（`claude [prompt]`）と確定。stdin リダイレクトは `-p, --print` の説明にあるとおり stdout 非 TTY なら non-interactive モードに自動切替する仕様のため、対話 TUI を起動しない。

採用方式: 中間 bash + `$(cat <path>)` 経由で claude に引数渡し。
```
bash -lc 'exec claude -- "$(cat ~/.homework-mcp/runs/<uuid>.txt)"'
```

- bash の command substitution（quote 内の `$(...)`）は cat 出力を 1 個の引数として展開。プロンプト内の `"`, 改行, `$(...)`, バッククォート等はシェルで再評価されない
- `--` で位置引数の境界を明示
- `<path>` は Node 側でホワイトリスト検証済み

Phase 4 着手時に新規ターミナル経由で実機検証する項目: 「対話セッションが立ち上がり、初期 prompt が user message として処理される」こと。万一 claude CLI の挙動が変わって引数渡しが non-interactive 扱いになった場合は blocker として停止（xdotool / クリップボード貼り付け等の脆い代替には逃げない）。

### Windows + WSL2 から Windows 側 schtasks を呼ぶ経路

WSL2 で動いている MCP サーバーから、ホスト Windows の Task Scheduler に登録する必要がある。`schtasks.exe` を `cmd.exe /c schtasks ...` 経由で呼ぶ。確認・対応事項:

- **引数の二重展開**: Windows cmd → WSL login shell の 2 段で展開される。プロンプト本文を引数に乗せず、ファイル経由で渡す（方式 B の理由のひとつ）
- **一時ファイルパス変換**: 一時 XML は `wslpath -w "$(mktemp)"` で Windows 解釈可能パスに変換。WSL 側 `/tmp` は schtasks から見えない
- **発火経路**: 発火時に Windows 側 schtasks が `wsl.exe -d <distro> -e <cmd>` 経由で WSL2 内コマンドを呼ぶ。`wsl_distro` は `config.json` に必須記載
- **絶対パス焼き込み**: 発火スクリプトのフルパス、DB パス、Node のフルパス（`process.execPath`）を登録時にスナップショットして XML に埋め込む

### Linux: systemd --user の lingering 必須

`loginctl enable-linger <user>` 未実行の環境では ssh ログアウトで user session が死に、OnCalendar timer が止まる。要件 6（マシン停止中の missed start）が破綻する。

- 登録冒頭で `loginctl show-user $UID --property=Linger` を確認、`Linger=no` なら throw
- `loginctl enable-linger` は sudo を要するので自動化しない。手動実行を README に明記
- silent に「動いてる風」で進ませない

### macOS の Terminal.app 権限

`osascript` で Terminal.app を制御するには「オートメーション」権限の許可ダイアログが初回出る。ユーザー操作前提。README で説明する。

### Linux のターミナル多様性

`gnome-terminal` 前提で書くと KDE / xterm 環境で動かない。

**フォールバック禁止原則に従い、cascade 検出はしない**。`~/.homework-mcp/config.json` の `linux_terminal` で**明示指定必須**とする。未指定または指定されたバイナリが PATH に無ければ、`homework_schedule` 呼び出し時にエラーで停止する。

初回起動時の自動検出は「config.json の雛形を書き出す時のヒント」としてのみ使う。検出結果を黙ってデフォルトに採用する形は取らない（ユーザーが config を見て確認 → 必要なら修正してから先に進む）。

### macOS / Linux の実機テスト不足

クオ の手元は Windows+WSL2 のみ。macOS / Linux はβ扱いで初期リリース、PR 受付で実機検証を補う。Phase 3 / 4 検証は最低限 VM での通過を目標とし、本番運用での挙動は β 期間のフィードバックで詰める。README に「Windows+WSL2 のみ実機テスト済み、macOS/Linux はベータ」と明記。

特に以下 2 点は実機なしで設計確定したものでβ期間に検証が必要:
- macOS: AppleScript の `tell app "Terminal" to do script "..." in window (make new window)` で確実に新規ウィンドウが開くこと（Terminal.app の Settings 状態に依存しないこと）。iTerm2 の `create window with default profile command "..."` も同様
- Linux: systemd --user の `PassEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR` + 登録時 `systemctl --user import-environment` で実際に `gnome-terminal` / `konsole` 等の GUI ターミナルが起動できること

### 後回し可の小論点

実装着手前に決めなくて良いが、Phase 4 までに方針を決めておくべき:

- **発火時のログ出力先**: 発火スクリプトの標準出力／エラー出力をどこに残すか（`~/.homework-mcp/logs/<task-id>.log` 案）
- **同一 cwd に複数タスクが同時発火した時の挙動**: 単純には N 個のターミナルウィンドウが開く。これで OK とするか、まとめるかは要決定（まとめは複雑化するので OK 寄り）
- **`runs/` ディレクトリの retention 期間**: 発火時に書き出した `~/.homework-mcp/runs/<uuid>.txt` を「残す」方針は決定済み（デバッグ用、Phase 4 擬似コード参照）。**保持期間のみ未決**（30 日後 cleanup 案）

## 3. 実装順序の判断

Phase 1 → 2 → 3 → 4 → 5 で進める。各フェーズの**検証**を通さずに次に進まない。

特に Phase 3 は OS ごとに独立で書く（共通項を抜く誘惑に抵抗する）。3 OS（+ WSL2）全部書いた後に重複コードが目立ったら、その時点で抽象化する。**書く前に共通インターフェースを「先取り」しない**（Karpathy 原則 2: まず単純に）。
