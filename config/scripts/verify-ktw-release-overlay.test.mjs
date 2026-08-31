import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildPatchApplyArgs,
  extractFullIndexPreimages,
  extractPatchPaths,
  validateOverlayManifest,
  verifyKtwReleaseOverlay,
  verifyOverlayFiles
} from './verify-ktw-release-overlay.mjs'

const MANIFEST_PATH = 'config/ktw-release-overlays/v1.4.192/manifest.json'

describe('KTW release overlay verifier', () => {
  it('binds the checked-in patch hash and exact path allowlist', () => {
    const result = verifyOverlayFiles(MANIFEST_PATH)
    expect(result.patchPaths).toEqual(result.manifest.allowedPaths)
    expect(result.patchPaths).toHaveLength(31)
    expect(result.manifest.patchApplyMode).toBe('unidiff-zero')
  })

  it('only enables zero-context application when the manifest explicitly requests it', () => {
    expect(buildPatchApplyArgs({}, '/tmp/overlay.patch')).toEqual([
      'apply',
      '--cached',
      '--3way',
      '/tmp/overlay.patch'
    ])
    expect(buildPatchApplyArgs({ patchApplyMode: 'unidiff-zero' }, '/tmp/overlay.patch')).toEqual([
      'apply',
      '--cached',
      '--3way',
      '--unidiff-zero',
      '/tmp/overlay.patch'
    ])
  })

  it('requires one full-index preimage per zero-context file section', () => {
    const patch = readFileSync(
      'config/ktw-release-overlays/v1.4.192/0001-KTW-one-shot與completion相容層.patch',
      'utf8'
    )
    const preimages = extractFullIndexPreimages(patch)
    expect(preimages.size).toBe(31)
    expect([...preimages.values()].every((sha) => /^[0-9a-f]{40}$/.test(sha))).toBe(true)
    expect(() =>
      extractFullIndexPreimages('diff --git a/a.ts b/a.ts\nindex 1234..5678 100644\n')
    ).toThrow('zero-context patch needs one full-index line')
  })

  it('materializes the checked-in zero-context patch to the exact output tree', () => {
    const result = verifyKtwReleaseOverlay(process.cwd(), MANIFEST_PATH)
    expect(result.outputTreeSha).toBe('3b5777c6c7d29e09b52bd1d9e95b2da9164887f1')
  })

  it('rejects duplicate or unsorted allowed paths', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    expect(() => validateOverlayManifest({ ...manifest, allowedPaths: ['z.ts', 'a.ts'] })).toThrow(
      'allowedPaths must be sorted'
    )
    expect(() => validateOverlayManifest({ ...manifest, allowedPaths: ['a.ts', 'a.ts'] })).toThrow(
      'allowedPaths contains duplicates'
    )
  })

  it('rejects an unknown patch application mode', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    expect(() => validateOverlayManifest({ ...manifest, patchApplyMode: 'unsafe' })).toThrow(
      'unsupported patchApplyMode'
    )
  })

  it('rejects renamed patch sections', () => {
    expect(() => extractPatchPaths('diff --git a/a.ts b/b.ts\n')).toThrow(
      'renamed path is not allowed'
    )
  })
})
