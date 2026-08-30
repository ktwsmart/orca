import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAutomationOneShotCommand,
  planAutomationOneShotStartup
} from './automation-one-shot-startup'

const { mockGetClientLoginShell } = vi.hoisted(() => ({
  mockGetClientLoginShell: vi.fn(() => '/bin/zsh')
}))
vi.mock('@/lib/client-login-shell', () => ({ getClientLoginShell: mockGetClientLoginShell }))

const base = {
  requested: true,
  agent: 'cursor' as const,
  agentArgs: '--trust --model grok',
  hasCommandOverride: false,
  hasPrompt: true,
  platform: 'darwin' as const,
  startupShell: undefined,
  hasConnection: false,
  isEnvironment: false,
  isWsl: false
}

describe('automation one-shot startup', () => {
  beforeEach(() => mockGetClientLoginShell.mockReturnValue('/bin/zsh'))

  it('appends a final Cursor print flag without guessing whether earlier tokens are values', () => {
    expect(planAutomationOneShotStartup(base)).toMatchObject({
      enabled: true,
      agentArgs: '--trust --model grok --print',
      shell: 'posix'
    })
    expect(planAutomationOneShotStartup({ ...base, agentArgs: '--trust -p' }).agentArgs).toBe(
      '--trust -p --print'
    )
    expect(
      planAutomationOneShotStartup({ ...base, agentArgs: "--model 'name -p'" }).agentArgs
    ).toBe("--model 'name -p' --print")
    expect(planAutomationOneShotStartup({ ...base, agentArgs: '--print=json' }).agentArgs).toBe(
      '--print=json --print'
    )
    expect(
      planAutomationOneShotStartup({ ...base, agentArgs: '--output-format json' }).agentArgs
    ).toBe('--output-format json --print')
  })

  it('uses Antigravity native one-shot prompt mode', () => {
    expect(planAutomationOneShotStartup({ ...base, agent: 'antigravity' })).toMatchObject({
      enabled: true,
      promptInjectionMode: 'flag-prompt'
    })
    expect(
      planAutomationOneShotStartup({
        ...base,
        agent: 'antigravity',
        agentArgs: '-- --model x'
      }).enabled
    ).toBe(false)
    expect(
      planAutomationOneShotStartup({
        ...base,
        agent: 'antigravity',
        agentArgs: '--prompt-interactive'
      }).enabled
    ).toBe(false)
    expect(
      planAutomationOneShotStartup({
        ...base,
        agent: 'antigravity',
        agentArgs: '--prompt-interactive=true'
      }).enabled
    ).toBe(false)
    expect(
      planAutomationOneShotStartup({
        ...base,
        agent: 'antigravity',
        agentArgs: '--prompt existing'
      }).enabled
    ).toBe(false)
  })

  it.each([
    ['custom command', { hasCommandOverride: true }],
    ['SSH', { hasConnection: true }],
    ['environment', { isEnvironment: true }],
    ['WSL', { isWsl: true }],
    ['Windows', { platform: 'win32' as const }],
    ['Windows client with Linux launch preference', { clientPlatform: 'win32' as const }],
    ['blank prompt', { hasPrompt: false }],
    ['other agent', { agent: 'claude' as const }]
  ])('fails closed for %s', (_label, override) => {
    expect(planAutomationOneShotStartup({ ...base, ...override }).enabled).toBe(false)
  })

  it('fails closed when Cursor args cannot be tokenized', () => {
    expect(
      planAutomationOneShotStartup({ ...base, agentArgs: '--model "unterminated' }).enabled
    ).toBe(false)
  })

  it('fails closed when an option terminator makes appended print a prompt token', () => {
    expect(planAutomationOneShotStartup({ ...base, agentArgs: '-- -p' }).enabled).toBe(false)
  })

  it('fails closed when an unpaired trailing escape could swallow appended print', () => {
    expect(planAutomationOneShotStartup({ ...base, agentArgs: '--trust \\' }).enabled).toBe(false)
  })

  it('uses the real fish dialect and preserves process exit status', () => {
    mockGetClientLoginShell.mockReturnValue('/opt/homebrew/bin/fish')
    const oneShot = planAutomationOneShotStartup(base)
    const plan = { launchCommand: 'cursor-agent --print task' } as never

    expect(oneShot.shell).toBe('fish')
    expect(applyAutomationOneShotCommand(plan, oneShot)).toBe('process-exit')
    expect((plan as { launchCommand: string }).launchCommand).toBe(
      'cursor-agent --print task; set -l orca_status $status; exit $orca_status'
    )
  })

  it('uses an agent SHELL override because the local PTY uses the same environment', () => {
    const oneShot = planAutomationOneShotStartup({ ...base, loginShell: '/opt/homebrew/bin/fish' })

    expect(oneShot.shell).toBe('fish')
  })

  it('leaves fallback plans untouched and agent-status authoritative', () => {
    const oneShot = planAutomationOneShotStartup({ ...base, isWsl: true })
    const plan = { launchCommand: 'cursor-agent task' } as never

    expect(applyAutomationOneShotCommand(plan, oneShot)).toBe('agent-status')
    expect((plan as { launchCommand: string }).launchCommand).toBe('cursor-agent task')
  })
})
