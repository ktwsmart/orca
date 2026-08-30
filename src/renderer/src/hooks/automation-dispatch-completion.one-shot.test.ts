import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../shared/automations-types'
import type { Worktree } from '../../../shared/worktree/types'
import { createAutomationDispatchCompletion } from './automation-dispatch-completion'

function createCompletion() {
  const markDispatchResult = vi.fn(async () => undefined)
  const releaseTerminalOwnership = vi.fn()
  const finalizeTerminalOwnership = vi.fn(() => true)
  const completion = createAutomationDispatchCompletion({
    run: { id: 'run-1' } as AutomationRun,
    worktree: { id: 'wt-1', displayName: 'Automation workspace' } as Worktree,
    precheckResult: null,
    markDispatchResult,
    releaseTerminalOwnership,
    finalizeTerminalOwnership
  })
  return {
    completion,
    finalizeTerminalOwnership,
    markDispatchResult,
    releaseTerminalOwnership
  }
}

describe('automation one-shot completion authority', () => {
  it('clears an early agent done and completes only from zero process exit', async () => {
    const { completion, finalizeTerminalOwnership, markDispatchResult, releaseTerminalOwnership } =
      createCompletion()

    completion.handleAgentDone()
    completion.setCompletionAuthority('process-exit')
    await completion.settlePendingAfterDispatch()

    expect(markDispatchResult).not.toHaveBeenCalled()
    completion.handleAgentDone()
    expect(markDispatchResult).not.toHaveBeenCalled()

    completion.handleExit(0)
    await vi.waitFor(() => expect(finalizeTerminalOwnership).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'completed', error: null })
    )
    expect(releaseTerminalOwnership).not.toHaveBeenCalled()
  })

  it('records a nonzero process exit as dispatch_failed and releases ownership', async () => {
    const { completion, finalizeTerminalOwnership, markDispatchResult, releaseTerminalOwnership } =
      createCompletion()

    completion.setCompletionAuthority('process-exit')
    await completion.settlePendingAfterDispatch()
    completion.handleExit(9)

    await vi.waitFor(() => expect(releaseTerminalOwnership).toHaveBeenCalledOnce())
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: 'Automation process exited with code 9.'
      })
    )
    expect(finalizeTerminalOwnership).not.toHaveBeenCalled()
  })
})
