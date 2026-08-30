import { buildAgentStartupPlan, type AgentStartupPlan } from '@/lib/tui-agent-startup'
import { getClientLoginShell } from '@/lib/client-login-shell'
import type { AgentPromptInjectionMode } from '../../../shared/tui-agent-config'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/tui-agent'
import { requireTuiAgentConfig } from '../../../shared/require-tui-agent-config'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { optionName } from '../../../shared/print-mode-headless-command'

export type AutomationOneShotStartupPlan = {
  enabled: boolean
  agentArgs: string
  shell: AgentStartupShell
  exitShell: 'posix' | 'fish'
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
  loginShell?: string
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
      exitShell: 'posix',
      promptInjectionMode: undefined
    }
  }

  const loginShell = args.loginShell?.trim() || getClientLoginShell()
  const shell = resolveStartupShell(args.platform, args.startupShell)
  const exitShell = /(?:^|\/)fish$/.test(loginShell) ? 'fish' : 'posix'
  const normalizedAgentArgs = args.agentArgs.trim()
  const tokenized = tokenizeStartupCommand(normalizedAgentArgs, shell)
  if (
    !tokenized.ok ||
    tokenized.tokens.includes('--') ||
    tokenized.spans.some((span) => span.divergesFromShell)
  ) {
    return {
      enabled: false,
      agentArgs: args.agentArgs,
      shell: fallbackShell,
      exitShell: 'posix',
      promptInjectionMode: undefined
    }
  }
  if (args.agent === 'antigravity') {
    if (
      tokenized.tokens.some((token) => {
        const name = optionName(token)
        return name === '-i' || name === '--prompt-interactive' || name === '--prompt'
      })
    ) {
      return {
        enabled: false,
        agentArgs: args.agentArgs,
        shell: fallbackShell,
        exitShell: 'posix',
        promptInjectionMode: undefined
      }
    }
    return {
      enabled: true,
      agentArgs: normalizedAgentArgs,
      shell,
      exitShell,
      promptInjectionMode: 'flag-prompt'
    }
  }
  // Always append a final native print flag. A print-looking token may actually be
  // another option's value, while duplicate boolean flags are accepted by Cursor.
  const agentArgs = `${normalizedAgentArgs} --print`.trim()
  return { enabled: true, agentArgs, shell, exitShell, promptInjectionMode: undefined }
}

export function applyAutomationOneShotCommand(
  plan: AgentStartupPlan,
  oneShot: AutomationOneShotStartupPlan
): 'agent-status' | 'process-exit' {
  if (!oneShot.enabled) {
    return 'agent-status'
  }
  plan.launchCommand =
    oneShot.exitShell === 'fish'
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
    isWsl: isWslUncPath(args.worktreePath),
    loginShell: args.agentEnv.SHELL
  })
  const isFollowupPath =
    requireTuiAgentConfig(args.agent).promptInjectionMode === 'stdin-after-start'
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
