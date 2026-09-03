# KTW Orca v1.4.196 最小相容發行層

施作者：Codex；更新時間：2026-09-03 14:50 +0800。

這個 overlay 疊到官方 `v1.4.196` tag 的 peeled exact commit
`aad4ae42ea5e555f25fdec679ebbcd18cc1e8911`。官方版本已包含：

- retained PTY hydration：upstream `3457acb6476af0b71e8d66b3664cf468a89aa4c3`；
- daemon swap-window presence authority：upstream
  `4cb013c0a9251275fa3d20ea33b45429e07aa6be`。

因此本版不再重複修改 PTY hydration／swap 檔案，只保留官方仍缺少的 automation
one-shot 啟動與 completion authority。

## 為何仍需要 overlay

官方 `v1.4.196` 仍將 Antigravity 設為 `flag-prompt-interactive`，也沒有
`automation-one-shot-startup.ts`、`promptInjectionModeOverride` 或持久化的
`completionAuthority`。直接更新會讓 ATG 背景排程回到互動式 prompt，且 agent
狀態 `done` 可能早於真正 process exit，形成假 `completed`。

本相容層只在本機、非 Windows／WSL、非 SSH／remote、無 command override、prompt
非空且 agent 為 Cursor 或 Antigravity 時啟用 one-shot：

- Antigravity 改用原生 `--prompt`，拒絕既有 `-i`、`--prompt-interactive`、
  `--prompt` 衝突參數；
- Cursor 尾端固定加入原生 `--print`；
- POSIX 以 `exec sh -c` 讓 agent process 擁有 PTY lifetime；
- macOS one-shot 會送出一次性內部 marker，process owner 在 spawn 前先移除 marker，
  並只對該次 PTY 繞過無法轉送子程序狀態的 TCC `login(1)` wrapper；一般互動終端仍維持
  官方 TCC attribution，因此 one-shot 能取得真實 exit status，marker 也不會進入 agent 環境；
- completion authority 固定為 `process-exit`；只有 host 回報
  `TerminalExitCause.kind=exited` 且 cause 內的 exit code 為 0 才能 completed。
  operator close、signal、unknown、非零、quota、login、Trust 或沒有可驗 exit cause
  一律失敗；
- local main process 會把可信 exit cause 經 preload、PTY dispatcher 與 eager
  pre-handler buffer 傳到 renderer；即使 node-pty 的 legacy code 是 0，人工關閉、
  signal 或未知 cause 也不能被 renderer race 誤寫為 completed；
- operator-close 分類由 runtime 把 host cause 與精確 stop request 合併後回傳，避免
  orphan／kill-all 或 `stop_unverified` 被全域覆寫；reuse observer 會拆開
  `PtyExitContext`，不把 context 外殼誤當成 cause；
- Cursor 若以未知／需值 option 結尾（例如懸空 `--model`），會退回 agent-status，
  不讓尾接的 `--print` 被吃成 option value 而形成長時間卡住；
- Antigravity 同樣拒絕懸空需值 option，只允許已知的尾端 boolean option；
- daemon-backed local provider 也改用 runtime 融合後的 canonical cause 回傳 renderer，
  避免 main 與 renderer 在 stop／自然退出窄窗產生不同結論；
- early `done` 在 launch plan 尚未回傳時只作 pending evidence；若最終 authority 是
  process-exit，該 pending done 必須丟棄，避免 race 假完成；
- reuse／remote／不安全 shell 維持官方 agent-status 行為，fail closed 不強行 one-shot。

## 驗證契約

`manifest.json` 綁定官方 base、39 個允許路徑、zero-context full-index patch SHA-256
與完整 output tree SHA。required static-analysis 會先從官方 upstream 精確抓取
v1.4.192／v1.4.196 兩個 base commit，再逐份物化驗證；驗證器使用 temporary Git
index，不修改目前工作樹：

```bash
node config/scripts/verify-ktw-release-overlay.mjs \
  config/ktw-release-overlays/v1.4.196/manifest.json
```

本候選已以官方 v1.4.196 精確依賴通過：one-shot／completion／exit-cause 鏈路
15 個測試檔 305 項（包含官方 retained-PTY hydration／swap；large inventory fixture
為 150,000 sessions，涵蓋本機 32-session 規模）、typecheck、`build:unpack`。
打包候選 app.asar SHA-256 為
`c21b8c8065a95a8edb6d38f73000858a13aed6cd0d7fbc67fa1d747d7d1c8aa6`。

recipe 本身不安裝 App、不停止 daemon，也不讀寫 credential。正式換版仍須另案 Slack
核准，並以 preinstall 全部 `ptyId + incarnationId` 的 N/N continuity、原 daemon PID
不變、missing=0、orphan=0 與 retained terminal 可讀為硬 gate；任一不符立即回滾。
