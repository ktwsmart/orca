import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  extractPatchPaths,
  validateOverlayManifest,
  verifyOverlayFiles
} from './verify-ktw-release-overlay.mjs'

const MANIFEST_PATH = 'config/ktw-release-overlays/v1.4.192/manifest.json'

describe('KTW release overlay verifier', () => {
  it('binds the checked-in patch hash and exact path allowlist', () => {
    const result = verifyOverlayFiles(MANIFEST_PATH)
    expect(result.patchPaths).toEqual(result.manifest.allowedPaths)
    expect(result.patchPaths).toHaveLength(16)
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

  it('rejects renamed patch sections', () => {
    expect(() => extractPatchPaths('diff --git a/a.ts b/b.ts\n')).toThrow(
      'renamed path is not allowed'
    )
  })
})
