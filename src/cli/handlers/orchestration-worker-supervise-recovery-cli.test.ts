import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { quotaScenarioMock } from './orchestration-worker-supervise-test-mocks'

// worker-supervise 的 lost-reply／精確重放（recovery）契約測試。
describe('orchestration worker-supervise recovery contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('start 回覆遺失＝attempt 連同 startRequestId 留存，指引精確重放', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        // production transport 型別：timeout＝結果未知，必須給 recovery 指令。
        return Promise.reject(
          new RuntimeClientError(
            'runtime_timeout',
            'Timed out waiting for the Orca runtime to respond.'
          )
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "start_outcome_unknown"'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"startRequestId"'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('--retry-start-request 讓第一個 attempt 重用原 mutation id（同 payload 命中原回執）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation(quotaScenarioMock({}))
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator'],
        ['retry-start-request', 'recover-original-start-id']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const starts = callMock.mock.calls.filter(([method]) => method === 'orchestration.workerStart')
    expect(starts[0]?.[2]).toEqual({ orchestrationRequestId: 'recover-original-start-id' })
    // 第二 attempt（遞補）必須換新 id，不得沿用恢復 id。
    expect(starts[1]?.[2]).not.toEqual({ orchestrationRequestId: 'recover-original-start-id' })
    logSpy.mockRestore()
  })

  it('server 明確錯誤（request_mismatch 等）不得當 lost reply 重放', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockImplementation((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' }
              ],
              activeAccountId: 'account-3'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: 'account-3' } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.reject(
          new RuntimeClientError(
            'request_mismatch',
            'Mutation request recover-1 was already used with different input.'
          )
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"state": "start_failed"'))
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('recoveryCommand'))
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('第二 attempt 回覆遺失＝recovery 指令帶剩餘帳號與 retryOf 血緣', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let startCount = 0
    callMock.mockImplementation(
      (method: string, params: { dispatch?: string; accountId?: string }) => {
        if (method === 'status.get') {
          return Promise.resolve({
            result: { capabilities: [ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY] }
          })
        }
        if (method === 'accounts.list') {
          return Promise.resolve({
            result: {
              codex: {
                accounts: [
                  { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                  { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
                ],
                activeAccountId: 'account-3'
              }
            }
          })
        }
        if (method === 'accounts.selectCodex') {
          return Promise.resolve({
            result: { accounts: [], activeAccountId: params.accountId }
          })
        }
        if (method === 'orchestration.workerStart') {
          startCount += 1
          if (startCount === 1) {
            // #3 啟動時即回額度錯誤 → 遞補。
            return Promise.resolve({
              result: {
                runId: 'run-1',
                taskId: 'task-1',
                dispatchId: 'dispatch-3',
                state: 'failed',
                lastError: 'Usage limit reached.'
              }
            })
          }
          return Promise.reject(new Error('socket closed before the response arrived'))
        }
        if (method === 'orchestration.workerRelease') {
          return Promise.resolve({ result: { state: 'released' } })
        }
        throw new Error(`Unexpected method ${method}`)
      }
    )

    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: new Map([
        ['task', 'task-1'],
        ['accounts', '#3,#2'],
        ['from', 'term-coordinator']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    // recovery 指令必須從失敗的帳號開始、且帶前一輪的 dispatch 血緣，重放才是同 payload。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--accounts \\"#2\\"'))
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('--retry-start-retry-of dispatch-3')
    )
    expect(process.exitCode).toBe(1)
    logSpy.mockRestore()
  })

  it('recovery 指令 round-trip 全部旗標：重放的 workerStart params 與原呼叫位元組一致', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const makeMock = () => {
      let startCount = 0
      return (method: string, params: { dispatch?: string; accountId?: string }) => {
        if (method === 'status.get') {
          return Promise.resolve({
            result: {
              capabilities: [
                ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY,
                ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
              ]
            }
          })
        }
        if (method === 'accounts.list') {
          return Promise.resolve({
            result: {
              codex: {
                accounts: [
                  { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                  { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
                ],
                activeAccountId: 'account-3'
              }
            }
          })
        }
        if (method === 'accounts.selectCodex') {
          return Promise.resolve({ result: { accounts: [], activeAccountId: params.accountId } })
        }
        if (method === 'orchestration.workerStart') {
          startCount += 1
          if (startCount === 1) {
            return Promise.resolve({
              result: {
                runId: 'run-1',
                taskId: 'task-1',
                dispatchId: 'dispatch-3',
                state: 'failed',
                lastError: 'Usage limit reached.'
              }
            })
          }
          return Promise.reject(
            new RuntimeClientError('runtime_unavailable', 'socket closed mid-flight')
          )
        }
        if (method === 'orchestration.workerRelease') {
          return Promise.resolve({ result: { state: 'released' } })
        }
        throw new Error(`Unexpected method ${method}`)
      }
    }

    const originalFlags = new Map<string, string | boolean>([
      ['task', 'task-1'],
      ['accounts', '#3,#2'],
      ['worktree', 'current'],
      ['name', 'release audit worker'],
      ['model', 'gpt-5.3-codex'],
      ['effort', 'high'],
      ['timeout-ms', '90000'],
      ['run', 'run-1'],
      ['from', 'term-coordinator']
    ])
    callMock.mockImplementation(makeMock())
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: originalFlags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    // 從輸出撈 recoveryCommand 與原第二次 workerStart 呼叫。
    const output = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((t) => t.includes('recoveryCommand'))
    expect(output).toBeDefined()
    const { recoveryCommand } = (JSON.parse(output!) as { result: { recoveryCommand: string } })
      .result
    const originalStarts = callMock.mock.calls.filter(
      ([method]) => method === 'orchestration.workerStart'
    )
    const lostCall = originalStarts[1]

    // 解析 recoveryCommand 為旗標（尊重 JSON 引號）。
    const parsedFlags = new Map<string, string | boolean>()
    const matcher = /--([a-z-]+)(?: (?:"((?:[^"\\]|\\.)*)"|(\S+)))?/g
    for (const match of recoveryCommand.matchAll(matcher)) {
      const [, flag, quoted, bare] = match
      if (flag === 'json') {
        continue
      }
      parsedFlags.set(flag!, quoted !== undefined ? JSON.parse(`"${quoted}"`) : bare!)
    }

    // 以 recovery 旗標重跑（模擬使用者照指令執行）。
    callMock.mockClear()
    callMock.mockImplementation((method: string, params: { accountId?: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          result: {
            capabilities: [
              ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
            ]
          }
        })
      }
      if (method === 'accounts.list') {
        return Promise.resolve({
          result: {
            codex: {
              accounts: [
                { id: 'account-3', email: 'three@example.com', workspaceLabel: 'Codex #3' },
                { id: 'account-2', email: 'two@example.com', workspaceLabel: 'Codex #2' }
              ],
              activeAccountId: 'account-2'
            }
          }
        })
      }
      if (method === 'accounts.selectCodex') {
        return Promise.resolve({ result: { accounts: [], activeAccountId: params.accountId } })
      }
      if (method === 'orchestration.workerStart') {
        return Promise.reject(
          new RuntimeClientError('runtime_timeout', 'still timing out — capture params only')
        )
      }
      throw new Error(`Unexpected method ${method}`)
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-supervise']({
      flags: parsedFlags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    const replayStart = callMock.mock.calls.find(
      ([method]) => method === 'orchestration.workerStart'
    )
    // 深度比對：params 與 mutation id 必須與遺失的原呼叫完全一致。
    expect(replayStart?.[1]).toEqual(lostCall?.[1])
    expect(replayStart?.[2]).toEqual(lostCall?.[2])
    logSpy.mockRestore()
  })
})
