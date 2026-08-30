import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function fail(message) {
  throw new Error(`KTW release overlay invalid: ${message}`)
}

function assertStringArray(value, field, pattern = null) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} must be a non-empty array`)
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || (pattern && !pattern.test(entry))) {
      fail(`${field} contains an invalid value`)
    }
  }
  if (new Set(value).size !== value.length) {
    fail(`${field} contains duplicates`)
  }
}

export function validateOverlayManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('manifest must be an object')
  }
  if (value.schemaVersion !== 1) {
    fail('unsupported schemaVersion')
  }
  for (const field of ['name', 'officialVersion', 'patchFile']) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0) {
      fail(`${field} must be a non-empty string`)
    }
  }
  if (!SHA_PATTERN.test(value.officialBaseSha ?? '')) {
    fail('officialBaseSha must be a full SHA-1')
  }
  if (!SHA256_PATTERN.test(value.patchSha256 ?? '')) {
    fail('patchSha256 must be a SHA-256')
  }
  if (!SHA_PATTERN.test(value.outputTreeSha ?? '')) {
    fail('outputTreeSha must be a full SHA-1')
  }
  assertStringArray(value.sourceCommits, 'sourceCommits', SHA_PATTERN)
  assertStringArray(value.allowedPaths, 'allowedPaths')
  const sortedPaths = [...value.allowedPaths].sort()
  if (JSON.stringify(sortedPaths) !== JSON.stringify(value.allowedPaths)) {
    fail('allowedPaths must be sorted')
  }
  return value
}

export function extractPatchPaths(patchText) {
  const paths = []
  const matcher = /^diff --git a\/([^\n]+) b\/([^\n]+)$/gm
  for (const match of patchText.matchAll(matcher)) {
    if (match[1] !== match[2]) {
      fail(`renamed path is not allowed: ${match[1]} -> ${match[2]}`)
    }
    paths.push(match[1])
  }
  if (paths.length === 0) {
    fail('patch contains no file changes')
  }
  if (new Set(paths).size !== paths.length) {
    fail('patch contains duplicate file sections')
  }
  return paths.sort()
}

function resolveContainedRegularFile(parent, child) {
  const candidate = resolve(parent, child)
  const parentReal = realpathSync(parent)
  const candidateStats = lstatSync(candidate)
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    fail('patchFile must be a regular file')
  }
  const candidateReal = realpathSync(candidate)
  const relativePath = relative(parentReal, candidateReal)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
    fail('patchFile escapes its overlay directory')
  }
  return candidateReal
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function verifyOverlayFiles(manifestPath) {
  const resolvedManifest = realpathSync(manifestPath)
  const manifest = validateOverlayManifest(JSON.parse(readFileSync(resolvedManifest, 'utf8')))
  const patchPath = resolveContainedRegularFile(dirname(resolvedManifest), manifest.patchFile)
  const patchBuffer = readFileSync(patchPath)
  if (sha256(patchBuffer) !== manifest.patchSha256) {
    fail('patch SHA-256 does not match manifest')
  }
  const patchPaths = extractPatchPaths(patchBuffer.toString('utf8'))
  if (JSON.stringify(patchPaths) !== JSON.stringify(manifest.allowedPaths)) {
    fail('patch paths do not exactly match allowedPaths')
  }
  return { manifest, patchPath, patchPaths }
}

function runGit(repoRoot, args, env = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  }).trim()
}

export function verifyKtwReleaseOverlay(repoRoot, manifestPath, git = runGit) {
  const { manifest, patchPath, patchPaths } = verifyOverlayFiles(manifestPath)
  git(repoRoot, ['cat-file', '-e', `${manifest.officialBaseSha}^{commit}`])
  for (const commit of manifest.sourceCommits) {
    git(repoRoot, ['cat-file', '-e', `${commit}^{commit}`])
  }
  const basePackage = JSON.parse(
    git(repoRoot, ['show', `${manifest.officialBaseSha}:package.json`])
  )
  if (basePackage.version !== manifest.officialVersion) {
    fail(`official base version is ${String(basePackage.version)}`)
  }

  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'ktw-release-overlay-'))
  const indexFile = resolve(temporaryDirectory, 'index')
  const indexEnv = { GIT_INDEX_FILE: indexFile }
  try {
    git(repoRoot, ['read-tree', manifest.officialBaseSha], indexEnv)
    git(repoRoot, ['apply', '--cached', '--3way', patchPath], indexEnv)
    if (git(repoRoot, ['ls-files', '-u'], indexEnv).length > 0) {
      fail('patch left unmerged index entries')
    }
    const changedPaths = git(
      repoRoot,
      ['diff', '--cached', '--name-only', '-z', manifest.officialBaseSha, '--'],
      indexEnv
    )
      .split('\0')
      .filter(Boolean)
      .sort()
    if (JSON.stringify(changedPaths) !== JSON.stringify(patchPaths)) {
      fail('temporary index changed paths differ from manifest')
    }
    const outputTreeSha = git(repoRoot, ['write-tree'], indexEnv)
    if (outputTreeSha !== manifest.outputTreeSha) {
      fail(`output tree is ${outputTreeSha}`)
    }
    return {
      officialBaseSha: manifest.officialBaseSha,
      officialVersion: manifest.officialVersion,
      patchSha256: manifest.patchSha256,
      changedPaths,
      outputTreeSha
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

export function main(args = process.argv.slice(2), repoRoot = process.cwd()) {
  if (args.length !== 1) {
    throw new Error('Usage: verify-ktw-release-overlay.mjs <manifest.json>')
  }
  const result = verifyKtwReleaseOverlay(repoRoot, resolve(repoRoot, args[0]))
  console.log(JSON.stringify({ ok: true, ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
