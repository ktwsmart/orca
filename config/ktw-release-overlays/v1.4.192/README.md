# KTW Orca v1.4.192 相容發行層

施作者：Codex；建立時間：2026-08-31 07:30 +0800。

這個 overlay 只把 KTW 的 one-shot 啟動與實際 completion authority 疊到官方
`v1.4.192` tag（exact `ce4df07736baa38d742613bd68d5a3d845f79d25`）。它刻意不帶入
該 tag 之後的 upstream main structured-session runtime 與 inventory authority 後續改寫，
避免既有 daemon terminals 在本機更新時從 inventory 消失。官方 tag 本身既有的
`session-tabs.authoritative-inventory` capability 保持不變。

## 驗證契約

`manifest.json` 同時綁定：

- 官方 base commit 與版本；
- patch SHA-256；
- 允許變更的 16 個檔案；
- 套用後完整 Git tree SHA。

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

本版本的 POSIX one-shot 命令使用 `exec sh -c ...`：`exec` 讓 interactive login shell
被 wrapper 取代，agent 結束才會形成真正 PTY exit；裸 `sh -c` 不符合此契約。
