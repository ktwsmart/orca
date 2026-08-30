import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { AutomationTerminalOwnership } from '@/lib/automation-terminal-ownership'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { AgentPromptInjectionMode } from '../../../shared/tui-agent-config'

export function resolveAutomationOneShotAgentArgs(agent: string, agentArgs: string): string {
  if (agent !== 'cursor' || /(^|\s)(?:-p|--print)(?=\s|$)/.test(agentArgs)) {
    return agentArgs
  }
  return `${agentArgs.trim()} --print`.trim()
}

export function automationPromptInjectionMode(
  agent: string,
  oneShot: boolean | undefined
): AgentPromptInjectionMode | undefined {
  return oneShot && agent === 'antigravity' ? 'flag-prompt' : undefined
}

export function wrapAutomationOneShotCommand(
  command: string,
  shell: AgentStartupShell
): { command: string; completionAuthority: 'agent-status' | 'process-exit' } {
  if (shell === 'posix') {
    return {
      command: `${command}; orca_status=$?; exit "$orca_status"`,
      completionAuthority: 'process-exit'
    }
  }
  if (shell === 'fish') {
    return {
      command: `${command}; set -l orca_status $status; exit $orca_status`,
      completionAuthority: 'process-exit'
    }
  }
  if (shell === 'powershell') {
    return {
      command: `& { ${command} }; $orcaSucceeded = $?; $orcaStatus = $LASTEXITCODE; if ($null -eq $orcaStatus) { $orcaStatus = if ($orcaSucceeded) { 0 } else { 1 } }; exit $orcaStatus`,
      completionAuthority: 'process-exit'
    }
  }
  // cmd.exe cannot safely preserve delayed ERRORLEVEL through arbitrary quoted commands.
  return { command, completionAuthority: 'agent-status' }
}

export function applyAutomationOneShotStartup(
  plan: AgentStartupPlan,
  enabled: boolean | undefined,
  platform: NodeJS.Platform,
  shell: AgentStartupShell | undefined
): 'agent-status' | 'process-exit' {
  if (!enabled) {
    return 'agent-status'
  }
  const wrapped = wrapAutomationOneShotCommand(plan.launchCommand, resolveStartupShell(platform, shell))
  plan.launchCommand = wrapped.command
  return wrapped.completionAuthority
}

export type LaunchAgentBackgroundSessionArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt?: string
  launchSource?: LaunchSource
  title?: string
  onData?: (chunk: string) => void
  onExit?: (ptyId: string, code: number) => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
  /** Automation-only native one-shot launch; interactive/reuse sessions omit this. */
  oneShot?: boolean
}

export type LaunchAgentBackgroundSessionResult = {
  tabId: string
  paneKey: string
  ptyId: string
  startupPlan: AgentStartupPlan
  terminalOwnership: AutomationTerminalOwnership | null
  completionAuthority: 'agent-status' | 'process-exit'
}
