import type { CodexManagedAccountSummary } from '../shared/types'
import type { OrchestrationMessageSummary } from '../shared/orchestration-check-output'
import type { OrchestrationWorkerReadResult } from '../shared/orchestration-worker-output'
import type { GitStatusResult } from '../shared/git-status-types'

export type CodexAccountSelector = Pick<
  CodexManagedAccountSummary,
  'id' | 'email' | 'workspaceLabel'
>

export function parseAccountOrder(
  raw: string | undefined,
  accounts: CodexAccountSelector[]
): string[] {
  if (raw) {
    const requested = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (requested.length === 0) {
      throw new Error('--accounts must contain at least one account selector')
    }
    return requested
  }

  const numbered = accounts
    .flatMap((account) => {
      const match = account.workspaceLabel?.match(/(?:^|\s)#(\d+)(?:\s|$|｜|\|)/)
      return match ? [{ selector: `#${match[1]}`, order: Number(match[1]) }] : []
    })
    .sort((left, right) => right.order - left.order)
    .map((entry) => entry.selector)

  if (numbered.length === 0) {
    throw new Error(
      'No numbered Codex accounts were found. Pass --accounts with exact IDs, emails, labels, or #numbers.'
    )
  }
  return numbered
}

export function resolveCodexAccount(
  accounts: CodexAccountSelector[],
  selector: string
): CodexAccountSelector {
  const byId = accounts.filter((account) => account.id === selector)
  if (byId.length === 1) {
    return byId[0]!
  }

  const byLabel = accounts.filter((account) => account.workspaceLabel === selector)
  if (byLabel.length === 1) {
    return byLabel[0]!
  }

  const byEmail = accounts.filter((account) => account.email === selector)
  if (byEmail.length === 1) {
    return byEmail[0]!
  }

  const number = selector.match(/^#(\d+)$/)?.[1]
  const byNumber = number
    ? accounts.filter((account) =>
        account.workspaceLabel?.match(new RegExp(`(?:^|\\s)#${number}(?:\\s|$|｜|\\|)`))
      )
    : []
  if (byNumber.length === 1) {
    return byNumber[0]!
  }

  const matches = [...byId, ...byLabel, ...byEmail, ...byNumber]
  if (matches.length > 1) {
    throw new Error(`Codex account selector "${selector}" is ambiguous; use the exact account ID.`)
  }
  throw new Error(`Codex account selector "${selector}" did not match a managed account.`)
}

const QUOTA_LINES = [
  /^usage limit reached\.?$/i,
  /^you(?:'ve| have) hit your usage limit\.?$/i,
  /^you(?:'ve| have) (?:run out of|used all) (?:your )?(?:codex )?(?:credits|usage)\.?$/i,
  /^your (?:codex )?(?:usage|credit) limit has been reached\.?$/i
]

export function isCodexQuotaExhaustedText(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => QUOTA_LINES.some((pattern) => pattern.test(line)))
}

export function isCodexQuotaExhaustedRead(result: OrchestrationWorkerReadResult): boolean {
  if (result.source !== 'transcript') {
    // Why: terminal tails have no author identity. A prompt or echoed command could contain the
    // same words, so unstructured terminal text is never sufficient evidence to switch accounts.
    return false
  }
  return result.transcript.messages.some(
    (message) =>
      (message.role === 'assistant' || message.role === 'system') &&
      message.blocks.some((block) => block.type === 'text' && isCodexQuotaExhaustedText(block.text))
  )
}

export function lifecycleMessageForDispatch(
  messages: OrchestrationMessageSummary[],
  dispatchId: string
): OrchestrationMessageSummary | undefined {
  return messages.find((message) => {
    if (!['worker_done', 'question', 'escalation'].includes(message.type ?? '')) {
      return false
    }
    if (!message.payload) {
      return false
    }
    try {
      const payload = JSON.parse(message.payload) as { dispatchId?: unknown }
      return payload.dispatchId === dispatchId
    } catch {
      return false
    }
  })
}

export function buildAcceptancePayload(input: {
  taskId: string
  dispatchId: string
  evidence: string
  accountId?: string
  accountLabel?: string | null
  worktreeCloseable: boolean
  worktreeReason: string
}): string {
  return JSON.stringify({
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    outcome: 'accepted',
    evidence: input.evidence,
    accountId: input.accountId ?? null,
    accountLabel: input.accountLabel ?? null,
    worktree: {
      closeable: input.worktreeCloseable,
      reason: input.worktreeReason,
      removed: false
    }
  })
}

export function evaluateWorktreeClosure(status: GitStatusResult): {
  closeable: boolean
  reason: string
} {
  if (status.didHitLimit) {
    return { closeable: false, reason: 'git status was truncated' }
  }
  if (status.entries.length > 0) {
    return {
      closeable: false,
      reason: `worktree has ${status.entries.length} uncommitted change(s)`
    }
  }
  return {
    closeable: true,
    reason: 'git worktree is clean; coordinator may archive or remove it explicitly'
  }
}
