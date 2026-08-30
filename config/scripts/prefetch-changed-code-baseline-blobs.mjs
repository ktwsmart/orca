import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/
const FETCH_CHUNK_SIZE = 64

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(options.stdio ? { stdio: options.stdio } : {})
  })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

export function collectChangedSourceBlobOids(root, baseline, git = runGit) {
  if (!OBJECT_ID_PATTERN.test(baseline)) {
    throw new Error(`Invalid baseline object id: ${baseline}`)
  }
  const files = splitNullDelimited(
    git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUB', baseline, 'HEAD', '--'])
  ).filter((file) => SOURCE_FILE_PATTERN.test(file))
  const blobOids = new Set()
  for (const file of files) {
    const entry = git(root, ['ls-tree', '-z', baseline, '--', file])
    if (!entry) {
      continue
    }
    const header = entry.slice(0, entry.indexOf('\t'))
    const [, type, oid] = header.split(' ')
    if (type === 'blob' && OBJECT_ID_PATTERN.test(oid)) {
      blobOids.add(oid)
    }
  }
  return [...blobOids]
}

export function chunkObjectIds(objectIds, size = FETCH_CHUNK_SIZE) {
  const chunks = []
  for (let offset = 0; offset < objectIds.length; offset += size) {
    chunks.push(objectIds.slice(offset, offset + size))
  }
  return chunks
}

export function prefetchChangedCodeBaselineBlobs(root, baseline, sourceUrl, { git = runGit } = {}) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(sourceUrl)) {
    throw new Error(`Refusing untrusted baseline source URL: ${sourceUrl}`)
  }
  const objectIds = collectChangedSourceBlobOids(root, baseline, git)
  for (const chunk of chunkObjectIds(objectIds)) {
    git(root, ['fetch', '--no-tags', '--no-write-fetch-head', sourceUrl, ...chunk], {
      stdio: 'inherit'
    })
  }
  console.log(`Prefetched ${objectIds.length} changed-source baseline blob(s).`)
  return objectIds.length
}

export function main(root = process.cwd(), args = process.argv.slice(2)) {
  const [baseline, sourceUrl] = args
  if (!baseline || !sourceUrl) {
    throw new Error('Usage: prefetch-changed-code-baseline-blobs.mjs <baseline-sha> <source-url>')
  }
  prefetchChangedCodeBaselineBlobs(root, baseline, sourceUrl)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
