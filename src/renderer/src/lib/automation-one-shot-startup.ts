import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { getClientLoginShell } from '@/lib/client-login-shell'
import type { AgentPromptInjectionMode } from '../../../shared/tui-agent-config'
import {
  resolveLoginShellStartupDialect,
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { isPrintModeHeadlessOneShotCommand } from '../../../shared/print-mode-headless-command'

export type AutomationOneShotStartupPlan = {
  enabled: boolean
  agentArgs: string
  shell: AgentStartupShell
  promptInjectionMode: AgentPromptInjectionMode | undefined
}

export function planAutomationOneShotStartup(args: {
  requested: boolean | undefined
  agent: TuiAgent
  agentArgs: string
  hasCommandOverride: boolean
  hasPrompt: boolean
  clientPlatform?: NodeJS.Platform
  platform: NodeJS.Platform
  startupShell: AgentStartupShell | undefined
  hasConnection: boolean
  isEnvironment: boolean
  isWsl: boolean
}): AutomationOneShotStartupPlan {
  const fallbackShell = resolveStartupShell(args.platform, args.startupShell)
  const eligible =
    args.requested === true &&
    (args.agent === 'cursor' || args.agent === 'antigravity') &&
    !args.hasCommandOverride &&
    args.hasPrompt &&
    !args.hasConnection &&
    !args.isEnvironment &&
    !args.isWsl &&
    args.platform !== 'win32' &&
    (args.clientPlatform ?? CLIENT_PLATFORM) !== 'win32'
  if (!eligible) {
    return {
      enabled: false,
      agentArgs: args.agentArgs,
      shell: fallbackShell,
      promptInjectionMode: undefined
    }
  }

  const shell = resolveLoginShellStartupDialect(getClientLoginShell())
  if (args.agent === 'antigravity') {
    return { enabled: true, agentArgs: args.agentArgs, shell, promptInjectionMode: 'flag-prompt' }
  }
  const tokenized = tokenizeStartupCommand(args.agentArgs, shell)
  if (!tokenized.ok || tokenized.tokens.includes('--')) {
    return {
      enabled: false,
      agentArgs: args.agentArgs,
      shell: fallbackShell,
      promptInjectionMode: undefined
    }
  }
  const hasPrint = isPrintModeHeadlessOneShotCommand(['cursor-agent', ...tokenized.tokens])
  const agentArgs = hasPrint ? args.agentArgs : `${args.agentArgs.trim()} --print`.trim()
  return { enabled: true, agentArgs, shell, promptInjectionMode: undefined }
}

export function applyAutomationOneShotCommand(
  plan: AgentStartupPlan,
  oneShot: AutomationOneShotStartupPlan
): 'agent-status' | 'process-exit' {
  if (!oneShot.enabled) {
    return 'agent-status'
  }
  plan.launchCommand =
    oneShot.shell === 'fish'
      ? `${plan.launchCommand}; set -l orca_status $status; exit $orca_status`
      : `${plan.launchCommand}; orca_status=$?; exit "$orca_status"`
  return 'process-exit'
}

export function buildAutomationBackgroundStartup(args: {
  agent: TuiAgent
  prompt: string | undefined
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentArgs: string
  agentEnv: Record<string, string>
  launchHost: { platform: NodeJS.Platform; isRemote: boolean; connectionId?: string | null }
  runtimeKind: 'local' | 'environment'
  worktreePath: string
  terminalWindowsShell: Parameters<
    typeof resolveLocalWindowsAgentStartupShell
  >[0]['terminalWindowsShell']
  oneShotRequested: boolean | undefined
}): {
  plan: AgentStartupPlan
  oneShot: AutomationOneShotStartupPlan
  trimmedPrompt: string
  hasPrompt: boolean
  isFollowupPath: boolean
  pasteDraftAfterLaunch: string | null
  completionAuthority: 'agent-status' | 'process-exit'
} | null {
  const startupShell = resolveLocalWindowsAgentStartupShell({
    platform: args.launchHost.platform,
    isRemote: args.launchHost.isRemote,
    terminalWindowsShell: args.terminalWindowsShell
  })
  const trimmedPrompt = args.prompt?.trim() ?? ''
  const hasPrompt = trimmedPrompt.length > 0
  const oneShot = planAutomationOneShotStartup({
    requested: args.oneShotRequested,
    agent: args.agent,
    agentArgs: args.agentArgs,
    hasCommandOverride: Boolean(args.cmdOverrides[args.agent]?.trim()),
    hasPrompt,
    platform: args.launchHost.platform,
    startupShell,
    hasConnection: Boolean(args.launchHost.connectionId),
    isEnvironment: args.runtimeKind === 'environment',
    isWsl: isWslUncPath(args.worktreePath)
  })
  const isFollowupPath = TUI_AGENT_CONFIG[args.agent].promptInjectionMode === 'stdin-after-start'
  const plan = buildAgentStartupPlan({
    agent: args.agent,
    prompt: hasPrompt && !isFollowupPath ? trimmedPrompt : '',
    cmdOverrides: args.cmdOverrides,
    agentArgs: oneShot.agentArgs,
    agentEnv: args.agentEnv,
    platform: args.launchHost.platform,
    shell: oneShot.shell,
    promptInjectionModeOverride: oneShot.promptInjectionMode,
    isRemote: args.launchHost.isRemote,
    allowEmptyPromptLaunch: !hasPrompt || isFollowupPath
  })
  if (!plan) {
    return null
  }
  return {
    plan,
    oneShot,
    trimmedPrompt,
    hasPrompt,
    isFollowupPath,
    pasteDraftAfterLaunch: hasPrompt && isFollowupPath ? trimmedPrompt : null,
    completionAuthority: applyAutomationOneShotCommand(plan, oneShot)
  }
}
