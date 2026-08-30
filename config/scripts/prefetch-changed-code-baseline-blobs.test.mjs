import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  chunkObjectIds,
  collectChangedSourceBlobOids,
  prefetchChangedCodeBaselineBlobs
} from './prefetch-changed-code-baseline-blobs.mjs'

const BASELINE = 'b261f4005c1ff8dcb4a2ac2d1b552d375a5ce36b'
const FIRST_BLOB = '1111111111111111111111111111111111111111'
const SECOND_BLOB = '2222222222222222222222222222222222222222'
const PR_WORKFLOW = readFileSync('.github/workflows/pr.yml', 'utf8')

function createGitDouble() {
  return vi.fn((_root, args) => {
    if (args[0] === 'diff') {
      return 'src/main/a.ts\0src/main/new.ts\0docs/readme.md\0src/main/b.tsx\0'
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/a.ts') {
      return `100644 blob ${FIRST_BLOB}\tsrc/main/a.ts\0`
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/b.tsx') {
      return `100644 blob ${SECOND_BLOB}\tsrc/main/b.tsx\0`
    }
    if (args[0] === 'ls-tree') {
      return ''
    }
    if (args[0] === 'fetch') {
      return ''
    }
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  })
}

describe('changed-code baseline blob prefetch', () => {
  it('collects only baseline blobs for changed source files that already exist', () => {
    const git = createGitDouble()
    expect(collectChangedSourceBlobOids('/repo', BASELINE, git)).toEqual([FIRST_BLOB, SECOND_BLOB])
  })

  it('fetches exact blob ids from a trusted GitHub source without writing FETCH_HEAD', () => {
    const git = createGitDouble()
    expect(
      prefetchChangedCodeBaselineBlobs('/repo', BASELINE, 'https://github.com/stablyai/orca.git', {
        git
      })
    ).toBe(2)
    expect(git).toHaveBeenCalledWith(
      '/repo',
      [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'https://github.com/stablyai/orca.git',
        FIRST_BLOB,
        SECOND_BLOB
      ],
      { stdio: 'inherit' }
    )
  })

  it('rejects a baseline source outside GitHub', () => {
    expect(() =>
      prefetchChangedCodeBaselineBlobs('/repo', BASELINE, 'https://example.com/evil.git', {
        git: createGitDouble()
      })
    ).toThrow('Refusing untrusted baseline source URL')
  })

  it('chunks large object lists into bounded fetch requests', () => {
    expect(chunkObjectIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('prefetches from the verified baseline source before changed-code analysis', () => {
    expect(PR_WORKFLOW).toContain('source_url="https://github.com/${{ github.repository }}.git"')
    expect(PR_WORKFLOW).toContain('source_url="https://github.com/stablyai/orca.git"')
    const prefetch = PR_WORKFLOW.indexOf('name: Prefetch changed-code baseline blobs')
    const changedCode = PR_WORKFLOW.indexOf('name: Enforce changed-code quality')
    expect(prefetch).toBeGreaterThan(0)
    expect(changedCode).toBeGreaterThan(prefetch)
    expect(PR_WORKFLOW).toContain('steps.change_baseline.outputs.source_url')
  })
})
