# KTW Orca v1.4.192 相容發行層

施作者：Codex；更新時間：2026-08-31 10:19 +0800。

這個 overlay 只把 KTW 的 one-shot 啟動與實際 completion authority 疊到官方
`v1.4.192` tag（exact `ce4df07736baa38d742613bd68d5a3d845f79d25`）。它刻意不帶入
該 tag 之後的 upstream main structured-session runtime 與 inventory authority 後續改寫，
避免既有 daemon terminals 在本機更新時從 inventory 消失。官方 tag 本身既有的
`session-tabs.authoritative-inventory` capability 保持不變。

## 驗證契約

`manifest.json` 同時綁定：

- 官方 base commit 與版本；
- patch SHA-256；
- 允許變更的 35 個檔案；
- 套用後完整 Git tree SHA。

本版 manifest 明示 `patchApplyMode: unidiff-zero`。patch 由 exact official base 的
temporary index 產生 zero-context diff，避免版本化 patch 內的 context-only 空白行
反過來污染 `git diff --check`；verifier 只在 manifest 明示這個 enum 時加入固定
`--unidiff-zero`，未知值一律 fail-closed。official base、patch SHA、path allowlist
與 output tree 的四重綁定仍全部必須成立。
此外，每個 zero-context file section 都必須帶 full-index preimage SHA；verifier 會把
它逐檔與 official base tree 比對，新檔則必須是全零 preimage。這讓純插入 hunk
即使沒有 context，也不能靠錯誤行號落到另一份 base 內容。

執行：

```bash
node config/scripts/verify-ktw-release-overlay.mjs \
  config/ktw-release-overlays/v1.4.192/manifest.json
```

驗證器只使用 temporary Git index 執行 `git apply --cached --3way`，不修改目前工作樹。
任何 conflict、缺 object、hash、版本、路徑或 output tree 漂移都會以非零狀態停止。

## 建立候選

通過上述 verifier 後，另在一次性工作樹 checkout `officialBaseSha`，再執行：

```bash
git apply --3way config/ktw-release-overlays/v1.4.192/0001-KTW-one-shot與completion相容層.patch
```

候選必須重新通過 typecheck、相關測試、`build:unpack`、獨立 exact-head 審查與
26-terminal continuity 驗收。這份 recipe 本身不安裝 App、不停止 daemon，也不讀寫憑證。

## retained PTY 啟動相容橋接

2026-08-31 的 live 安裝驗收發現：官方 `v1.4.192` UI 在仍由舊 daemon 持有
26 個 PTY 時，第一次 `terminal.list` 只看見 1 個；立即回復 `v1.4.191` 後，
相同 `ptyId + incarnationId` 的 26 個 session 全部恢復。加入 memory hydration 後的
第二次 live 驗收，preinstall 已增為 28 個，但候選仍只回 1 個；回滾後 28/28 恢復。
這證明 memory registry hydration 不是唯一 authority，overlay 因此同時 backport：

- upstream `3457acb6476af0b71e8d66b3664cf468a89aa4c3` 的 retained-PTY memory hydration；
- upstream `4cb013c0a9251275fa3d20ea33b45429e07aa6be` 的 daemon swap-window
  presence authority 修補，禁止尚未取得 PTY 所有權的 provider 回答 authoritative false。

相容橋接的契約如下：

- 先等待 `localPtyProviderStartupReady`，再開放 headless runtime；
- handler 註冊後必須等待 daemon registry hydration，不能讓 CLI／診斷先讀空清冊；
- hydration 只有完整成功後才鎖定完成；失敗、逾時或 concurrent call 可安全重試；
- 未知 repo、SSH repo、已移除 worktree 仍 fail-closed，不得生成幽靈 terminal。
- `pty:hasPty` 與 `pty:inspectProcess` 對本機 restored daemon PTY 必須等 provider
  startup barrier；同步 runtime `hasPty` 在 barrier 未 settled 前只能回 `null`
  （不可驗證），不得回 `false` 觸發 terminal removal。
- KTW regression 以本次實機數量 28 個 retained PTY 驗證：barrier 前 28/28
  均不可回答不存在，真正 owning provider 落地後才 28/28 回答存在。

這個 backport 只處理啟動排序與 retained PTY hydration，不帶入官方 tag 之後的
structured-session runtime。實際部署仍以 preinstall 全數 `N/N` 的
`ptyId + incarnationId` continuity、daemon PID 不變與 orphan=0 為硬 gate。

本版本的 POSIX one-shot 命令使用 `exec sh -c ...`：`exec` 讓 interactive login shell
被 wrapper 取代，agent 結束才會形成真正 PTY exit；裸 `sh -c` 不符合此契約。
