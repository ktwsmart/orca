import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerEffect } from './orchestration-worker-topology'

// Why: the pane account registry records the CODEX_HOME actually baked into the PTY at spawn —
// the only evidence immune to a select→start ABA race. A receipt must never vouch for an account
// the worker did not launch under, so unprovable is a failure — and a fresh terminal that failed
// verification must not outlive the failed start.

export function assertManagedAccountRequestSupported(params: {
  managedAccount?: unknown
  terminal?: string
  agent: string | undefined
}): void {
  if (!params.managedAccount) {
    return
  }
  // Why: the pane registry is Codex-specific evidence; letting another agent carry a
  // managedAccount claim would vouch for an account nothing can attest to.
  if (params.agent !== 'codex') {
    throw new OrchestrationError(
      'invalid_argument',
      'managedAccount requires agent codex; no other agent has attestable launch-account evidence.'
    )
  }
  // Why: a reused terminal's registry record only proves the CODEX_HOME at PTY spawn, not the
  // account of an agent relaunched later with an overridden environment. Reused terminals are
  // also externally owned, so they must not be auto-closed on a failed verification. Require a
  // fresh Orca-created terminal instead.
  if (params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      'managedAccount cannot be combined with --terminal; account attestation requires a fresh Orca-created worker terminal.'
    )
  }
}

export async function verifyWorkerLaunchAccount(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  managedAccountId: string
  effects: WorkerEffect[]
}): Promise<void> {
  const launchAccount = args.runtime.getCodexTerminalLaunchAccount(args.terminalHandle)
  const verificationError = !launchAccount.known
    ? `Worker terminal ${args.terminalHandle} has no recorded Codex launch account, so the requested managed account ${args.managedAccountId} cannot be proven.`
    : launchAccount.accountId !== args.managedAccountId
      ? `Worker terminal ${args.terminalHandle} launched under Codex account ${launchAccount.accountId ?? 'system-default'}, not the requested managed account ${args.managedAccountId}.`
      : null
  if (!verificationError) {
    return
  }
  // The terminal is always Orca-created here (managedAccount rejects reused terminals), so
  // closing it leaves no unowned live worker behind.
  try {
    await args.runtime.closeTerminal(args.terminalHandle)
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'closed',
      id: args.terminalHandle
    })
  } catch {
    args.effects.push({
      kind: 'terminal',
      role: 'agent',
      action: 'close_failed',
      id: args.terminalHandle
    })
  }
  throw new Error(verificationError)
}
