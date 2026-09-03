# KTW Orca v1.4.196 最小相容發行層

施作者：Codex；更新時間：2026-09-03 12:30 +0800。

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
- completion authority 固定為 `process-exit`，exit 0 才能 completed，非零、quota、
  login、Trust 或沒有可驗 exit code 一律失敗；
- early `done` 在 launch plan 尚未回傳時只作 pending evidence；若最終 authority 是
  process-exit，該 pending done 必須丟棄，避免 race 假完成；
- reuse／remote／不安全 shell 維持官方 agent-status 行為，fail closed 不強行 one-shot。

## 驗證契約

`manifest.json` 綁定官方 base、17 個允許路徑、zero-context full-index patch SHA-256
與完整 output tree SHA。驗證器使用 temporary Git index，不修改目前工作樹：

```bash
node config/scripts/verify-ktw-release-overlay.mjs \
  config/ktw-release-overlays/v1.4.196/manifest.json
```

本候選已以官方 v1.4.196 精確依賴通過：one-shot／completion 核心 7 個測試檔
149 項，加上官方 retained-PTY hydration／swap 2 個測試檔 35 項（large inventory
fixture 為 150,000 sessions，涵蓋本機 32-session 規模）、typecheck、`build:unpack`。
打包候選 app.asar SHA-256 為
`3603089e38f809fc7e96cb3d6a053a86dc34f22e4409fec6204cd25a44888204`。

recipe 本身不安裝 App、不停止 daemon，也不讀寫 credential。正式換版仍須另案 Slack
核准，並以 preinstall 全部 `ptyId + incarnationId` 的 N/N continuity、原 daemon PID
不變、missing=0、orphan=0 與 retained terminal 可讀為硬 gate；任一不符立即回滾。
