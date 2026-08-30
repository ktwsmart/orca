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
const DELETED_BLOB = '3333333333333333333333333333333333333333'
const RENAMED_BLOB = '4444444444444444444444444444444444444444'
const PR_WORKFLOW = readFileSync('.github/workflows/pr.yml', 'utf8')

function createGitDouble() {
  return vi.fn((_root, args) => {
    if (args[0] === 'diff') {
      return [
        'src/main/a.ts',
        'src/main/new.ts',
        'src/main/deleted.ts',
        'src/main/renamed-old.ts',
        'src/main/renamed-new.ts',
        'docs/readme.md',
        'src/main/b.tsx',
        ''
      ].join('\0')
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/a.ts') {
      return `100644 blob ${FIRST_BLOB}\tsrc/main/a.ts\0`
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/b.tsx') {
      return `100644 blob ${SECOND_BLOB}\tsrc/main/b.tsx\0`
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/deleted.ts') {
      return `100644 blob ${DELETED_BLOB}\tsrc/main/deleted.ts\0`
    }
    if (args[0] === 'ls-tree' && args.at(-1) === 'src/main/renamed-old.ts') {
      return `100644 blob ${RENAMED_BLOB}\tsrc/main/renamed-old.ts\0`
    }
    if (args[0] === 'ls-tree') {
      return ''
    }
    if (args[0] === 'cat-file') {
      return [FIRST_BLOB, DELETED_BLOB, RENAMED_BLOB, SECOND_BLOB]
        .map((objectId) => `${objectId} blob`)
        .join('\n')
    }
    throw new Error(`Unexpected git call: ${args.join(' ')}`)
  })
}

describe('changed-code baseline blob prefetch', () => {
  it('collects only baseline blobs for changed source files that already exist', () => {
    const git = createGitDouble()
    expect(collectChangedSourceBlobOids('/repo', BASELINE, git)).toEqual([
      FIRST_BLOB,
      DELETED_BLOB,
      RENAMED_BLOB,
      SECOND_BLOB
    ])
    expect(git).toHaveBeenCalledWith('/repo', [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      BASELINE,
      'HEAD',
      '--'
    ])
  })

  it('hydrates exact blob ids through the partial-clone promisor transport', () => {
    const git = createGitDouble()
    expect(
      prefetchChangedCodeBaselineBlobs('/repo', BASELINE, 'https://github.com/stablyai/orca.git', {
        git
      })
    ).toBe(4)
    expect(git).toHaveBeenCalledWith(
      '/repo',
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { input: `${FIRST_BLOB}\n${DELETED_BLOB}\n${RENAMED_BLOB}\n${SECOND_BLOB}\n` }
    )
  })

  it('rejects a hydrated object that is missing or is not a blob', () => {
    const baselineGit = createGitDouble()
    const git = vi.fn((root, args, options) => {
      if (args[0] === 'cat-file') {
        return `${FIRST_BLOB} tree\n`
      }
      return baselineGit(root, args, options)
    })

    expect(() =>
      prefetchChangedCodeBaselineBlobs('/repo', BASELINE, 'https://github.com/stablyai/orca.git', {
        git
      })
    ).toThrow(`Failed to hydrate verified baseline blob ${FIRST_BLOB}`)
  })

  it('rejects a baseline source outside GitHub', () => {
    expect(() =>
      prefetchChangedCodeBaselineBlobs('/repo', BASELINE, 'https://example.com/evil.git', {
        git: createGitDouble()
      })
    ).toThrow('Refusing untrusted baseline source URL')
  })

  it('rejects an invalid baseline before running git', () => {
    const git = createGitDouble()
    expect(() => collectChangedSourceBlobOids('/repo', '--upload-pack=evil', git)).toThrow(
      'Invalid baseline object id'
    )
    expect(git).not.toHaveBeenCalled()
  })

  it('chunks large object lists into bounded fetch requests', () => {
    expect(chunkObjectIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('prefetches from the verified baseline source before changed-code analysis', () => {
    expect(PR_WORKFLOW).toContain('source_url="https://github.com/${{ github.repository }}.git"')
    expect(PR_WORKFLOW).toContain('source_url="https://github.com/stablyai/orca.git"')
    expect(PR_WORKFLOW).toMatch(
      /name: static analysis[\s\S]*?name: Checkout[\s\S]*?ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/
    )
    const prefetch = PR_WORKFLOW.indexOf('name: Prefetch changed-code baseline blobs')
    const changedCode = PR_WORKFLOW.indexOf('name: Enforce changed-code quality')
    expect(prefetch).toBeGreaterThan(0)
    expect(changedCode).toBeGreaterThan(prefetch)
    expect(PR_WORKFLOW).toContain('steps.change_baseline.outputs.source_url')
  })
})
