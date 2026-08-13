import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { ORCHESTRATION_WORKER_MANAGED_ACCOUNT_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
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
        return Promise.reject(new Error('socket closed before the response arrived'))
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
})
