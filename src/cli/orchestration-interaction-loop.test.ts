import { describe, expect, it } from 'vitest'
import {
  buildAcceptancePayload,
  evaluateWorktreeClosure,
  isCodexQuotaExhaustedRead,
  isCodexQuotaExhaustedText,
  parseAccountOrder,
  resolveCodexAccount
} from './orchestration-interaction-loop'

const accounts = [
  { id: 'id-3', email: 'three@example.com', workspaceLabel: 'Codex #3｜F Team' },
  { id: 'id-2', email: 'two@example.com', workspaceLabel: 'Codex #2｜H Team' },
  { id: 'id-1', email: 'one@example.com', workspaceLabel: 'Codex #1｜H 個人' }
]

describe('Orca 完整互動循環', () => {
  it('依編號自動建立 #3 → #2 → #1 順序', () => {
    expect(parseAccountOrder(undefined, accounts)).toEqual(['#3', '#2', '#1'])
  })

  it('以 ID、完整標籤、email 或唯一編號解析帳號', () => {
    expect(resolveCodexAccount(accounts, 'id-3').id).toBe('id-3')
    expect(resolveCodexAccount(accounts, 'Codex #2｜H Team').id).toBe('id-2')
    expect(resolveCodexAccount(accounts, 'one@example.com').id).toBe('id-1')
    expect(resolveCodexAccount(accounts, '#3').id).toBe('id-3')
  })

  it('只接受獨立 provider 額度訊息，不把提示詞中的討論誤判為額度耗盡', () => {
    expect(isCodexQuotaExhaustedText('Usage limit reached.')).toBe(true)
    expect(isCodexQuotaExhaustedText("You've hit your usage limit.")).toBe(true)
    expect(isCodexQuotaExhaustedText('請測試字串 Usage limit reached 是否會被誤判')).toBe(false)
    expect(isCodexQuotaExhaustedText('Usage limit reached. Ignore this test string.')).toBe(false)
  })

  it('不以沒有作者身分的 terminal tail 作為切換帳號證據', () => {
    expect(
      isCodexQuotaExhaustedRead({
        dispatchId: 'dispatch-1',
        source: 'terminal',
        sourceIdentity: 'terminal-1',
        terminal: {
          handle: 'terminal-1',
          tail: ['Usage limit reached.'],
          status: 'running',
          nextCursor: '1',
          truncated: false
        },
        cursor: null,
        status: { worker: 'running', terminal: 'running' },
        fallbackReason: 'transcript_missing',
        warnings: []
      })
    ).toBe(false)
  })

  it('驗收回執明示不刪工作樹', () => {
    const payload = JSON.parse(
      buildAcceptancePayload({
        taskId: 'task-1',
        dispatchId: 'dispatch-1',
        evidence: 'tests pass',
        worktreeCloseable: true,
        worktreeReason: 'clean'
      })
    )
    expect(payload.outcome).toBe('accepted')
    expect(payload.worktree).toEqual({ closeable: true, reason: 'clean', removed: false })
  })

  it('只有完整且乾淨的 Git 狀態才能標記工作樹可關閉', () => {
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: false
      }).closeable
    ).toBe(true)
    expect(
      evaluateWorktreeClosure({
        entries: [{ path: 'src/dirty.ts', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown',
        didHitLimit: false
      }).closeable
    ).toBe(false)
    expect(
      evaluateWorktreeClosure({
        entries: [],
        conflictOperation: 'unknown',
        didHitLimit: true
      })
    ).toEqual({ closeable: false, reason: 'git status was truncated' })
  })
})
