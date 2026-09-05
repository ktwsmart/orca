# KTW Orca v1.4.197 最小相容發行層

施作者：Codex；更新時間：2026-09-05 09:42 +0800。

本 overlay 疊到官方 `v1.4.197` annotated tag `9a94a4e2d6849aba4795278f1b1bcc4ad88ecd2e`
所指向的 peeled exact commit `5ee4ace516080891731d100f843b074408a9ce0e`。本版以官方
v1.4.197 的重構結果為底重新移植，不直接套用 v1.4.196 patch。

## 為何仍需要 overlay

官方 v1.4.197 仍沒有 KTW 所需的 `automation-one-shot-startup`、持久化
`completionAuthority` 與 run-scoped 完成憑證。沒有這三層時：

- Antigravity／Cursor 背景排程可能回到互動式 prompt；
- terminal 消失或 host 沒回報真正 exit cause 時，run 可能長期留在 `dispatched`，或被
  legacy code 0 誤判成功；
- agent 只留下「等待背景任務完成」等中間訊息後乾淨退出，也可能被誤標 `completed`。

## v1.4.197 相容行為

- 保留官方 v1.4.197 的 terminal reattach／lost-contact 行為：沒有可證 exit 時保留
  tab 與 PTY 綁定，交由 main completion watcher 重接或以明確失聯原因結案；
- Antigravity 在安全的本機 POSIX 條件使用原生 `--prompt`，Cursor 固定使用原生
  `--print`；SSH、remote、Windows／WSL、custom command 或不安全參數全部 fail closed
  回到 `agent-status`；
- one-shot 使用 `exec sh -c` 與可信 `TerminalExitCause`，operator close、signal、unknown、
  非零、quota、login、Trust 或沒有可驗 exit cause 一律不得 completed；
- 每個 one-shot run 把 run ID 放進 `ORCA_AUTOMATION_COMPLETION_TOKEN` 環境變數，提示詞
  只包含變數名稱而不含 token 值；agent 必須等所有背景任務與驗證完成後，最後執行指定
  `printf` 產生 `ORCA_AUTOMATION_COMPLETE:<run-id>`；
- renderer 與 main runtime watcher 都同時驗證「可信 exit 0 + 該 run 專屬 marker」。只有
  exit 0、沒有 marker（包括只有背景等待訊息）會明確 `dispatch_failed`，不再假綠；
- renderer 對 marker 的判斷取 terminal 原始輸出與 assistant final message 聯集；即使
  user-facing snapshot 選用較乾淨的 assistant 結論，也不會蓋掉 terminal 已留下的憑證，
  因此與 main watcher 使用同一份可驗完成事證；
- 既有工作區 terminal 從 runtime surface 消失時，startup reconciliation 會重接；確認
  已無 terminal 後以明確 lost-terminal 失敗結案，不會永久卡在 `dispatched`。
- macOS one-shot 為取得 agent 子程序的真實 exit status，會針對該次啟動略過無法轉送
  子程序狀態的 TCC `login(1)` wrapper；一般互動終端仍維持官方 TCC attribution。

## 驗證契約

`manifest.json` 綁定官方 exact base、45 個允許來源路徑、zero-context full-index patch
SHA-256 與完整 output tree SHA。驗證器使用 temporary Git index，不修改目前工作樹：

```bash
node config/scripts/verify-ktw-release-overlay.mjs \
  config/ktw-release-overlays/v1.4.197/manifest.json
```

針對現場 MCP run 14 與文件 run 112 增加兩類回歸：terminal 消失／重啟重接不得永久
卡住，以及只輸出背景等待訊息但沒有 run-scoped marker 不得 completed。recipe 不安裝
App、不停止 daemon、不觸碰 OAuth、Token、cookie、auth.json 或 credential store。正式換版
仍須另案 Slack operational 核准與 preinstall／postinstall continuity gate。

本候選在官方 v1.4.197 精確依賴上通過完整 `typecheck`、整庫 `lint`、one-shot／
completion／exit-cause 關鍵路徑 12 檔 235 項、最終關聯重跑 8 檔 84 項；完整測試中
71,181 項通過，唯一失敗為未修改的 transcript filesystem-watcher timing 測試，
隔離重跑 2/2 通過。`build:unpack` 已成功完成，打包候選 app.asar SHA-256 為
`2b2454b475e03f997017764ef373591496794d3d17a8acea0112be2d73bf6dba`。
