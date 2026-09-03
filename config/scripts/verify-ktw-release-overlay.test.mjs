import { execFileSync } from 'node:child_process'
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

const OVERLAYS = [
  {
    manifestPath: 'config/ktw-release-overlays/v1.4.192/manifest.json',
    patchPath:
      'config/ktw-release-overlays/v1.4.192/0001-KTW-one-shot與completion相容層.patch',
    officialBaseSha: 'ce4df07736baa38d742613bd68d5a3d845f79d25',
    pathCount: 35,
    outputTreeSha: '7f210723c73b233665058e49c72d60f3e903835e'
  },
  {
    manifestPath: 'config/ktw-release-overlays/v1.4.196/manifest.json',
    patchPath:
      'config/ktw-release-overlays/v1.4.196/0001-KTW-one-shot與completion相容層.patch',
    officialBaseSha: 'aad4ae42ea5e555f25fdec679ebbcd18cc1e8911',
    pathCount: 39,
    outputTreeSha: '4a36d3fdcc24df51732e256ca344d46422c3f399'
  }
].map((overlay) => ({
  ...overlay,
  hasOfficialBase: (() => {
    try {
      execFileSync('git', ['cat-file', '-e', `${overlay.officialBaseSha}^{commit}`], {
        stdio: 'ignore'
      })
      return true
    } catch {
      return false
    }
  })()
}))

const MANIFEST_PATH = OVERLAYS.at(-1).manifestPath

describe('KTW release overlay verifier', () => {
  for (const overlay of OVERLAYS) {
    it(`binds ${overlay.manifestPath} to its patch hash and exact path allowlist`, () => {
      const result = verifyOverlayFiles(overlay.manifestPath)
      expect(result.patchPaths).toEqual(result.manifest.allowedPaths)
      expect(result.patchPaths).toHaveLength(overlay.pathCount)
      expect(result.manifest.patchApplyMode).toBe('unidiff-zero')
    })

    it(`requires one full-index preimage per section in ${overlay.patchPath}`, () => {
      const patch = readFileSync(overlay.patchPath, 'utf8')
      const preimages = extractFullIndexPreimages(patch)
      expect(preimages.size).toBe(overlay.pathCount)
      expect([...preimages.values()].every((sha) => /^[0-9a-f]{40}$/.test(sha))).toBe(true)
    })

    // Required static analysis fetches both exact official base commits before
    // running both manifests. Shallow unit shards still run every pure contract
    // test and skip only this duplicate local materialization when an object is absent.
    it.skipIf(!overlay.hasOfficialBase)(
      `materializes ${overlay.manifestPath} to its exact output tree`,
      () => {
        const result = verifyKtwReleaseOverlay(process.cwd(), overlay.manifestPath)
        expect(result.outputTreeSha).toBe(overlay.outputTreeSha)
      }
    )
  }

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

  it('rejects a zero-context file section without one full-index preimage', () => {
    expect(() =>
      extractFullIndexPreimages('diff --git a/a.ts b/a.ts\nindex 1234..5678 100644\n')
    ).toThrow('zero-context patch needs one full-index line')
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
