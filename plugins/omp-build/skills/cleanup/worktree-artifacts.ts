import type { ArtifactKind, IgnoredEntry } from './worktree-shared'

type Recognized = Exclude<ArtifactKind, 'protected'>
type Match = { start: number; end: number; kind: Recognized }

// Measured, finite, case-sensitive allowlist; there is no repository override. Names classify an ignored entry, they do
// not prove that its content can be regenerated. A directory rule matches a contiguous run of path segments that Git
// reports as a directory (trailing slash) or as an ancestor of a reported path, so a file or symlink named
// `node_modules` is not a dependency tree.
const directoryRules: readonly { segments: readonly string[]; kind: Recognized }[] = [
  { segments: ['node_modules'], kind: 'dependency' },
  { segments: ['.venv'], kind: 'dependency' },
  { segments: ['__pycache__'], kind: 'cache' },
  { segments: ['.pytest_cache'], kind: 'cache' },
  { segments: ['.ruff_cache'], kind: 'cache' },
  { segments: ['.cache', 'trufflehog'], kind: 'cache' },
  { segments: ['.astro'], kind: 'build-output' },
  { segments: ['dist'], kind: 'build-output' },
  { segments: ['test-results'], kind: 'build-output' },
]
const cacheFileSuffix = '.tsbuildinfo'
// Defense in depth, not a complete detector: a name that Git exposes below a recognized directory and that looks like a
// secret or state keeps the worktree. Children of a directory Git reports as one entry are never listed here.
const sensitiveNames = [
  /^\.env(?:\..*)?$/i,
  /^\.(?:envrc|netrc|npmrc|pypirc|git-credentials|htpasswd)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|crt|cer|der|p12|pfx|jks|keystore|kdbx|gpg|asc|tfstate|tfvars|db|sqlite3?|db-wal|db-shm|sql|dump)$/i,
  /secret|credential/i,
]

function directoryMatches(segments: string[], directory: boolean): Match[] {
  const matches: Match[] = []
  for (let start = 0; start < segments.length; start++) {
    for (const rule of directoryRules) {
      const end = start + rule.segments.length
      if (end > segments.length || (end === segments.length && !directory)) continue
      if (rule.segments.every((name, offset) => segments[start + offset] === name))
        matches.push({ start, end, kind: rule.kind })
    }
  }
  return matches
}
function recognize(segments: string[], directory: boolean): Recognized | null {
  const matches = directoryMatches(segments, directory)
  const exposed = matches.length ? segments.slice(matches[0].start + 1) : []
  if (exposed.some((name) => sensitiveNames.some((pattern) => pattern.test(name)))) return null
  // Git reports the recognized directory itself as ignored.
  const self = matches.find((match) => match.end === segments.length)
  if (self) return self.kind
  // Tool-owned dependency and cache directories may expose individually ignored children. Build output may not: a build
  // directory that Git does not ignore as a whole can hold anything.
  const namespace = matches.filter((match) => match.kind !== 'build-output').at(-1)
  if (namespace) return namespace.kind
  const name = segments[segments.length - 1]
  if (!directory && name.length > cacheFileSuffix.length && name.endsWith(cacheFileSuffix)) return 'cache'
  return null
}
// Maps the worktree-relative paths of one `git status --ignored=matching` pass to the ignored-entry manifest, one entry
// per exact reported path. Only a directory that Git reports as one entry is a whole subtree; its file contents are
// never read. The manifest is sorted by code point, so it is stable for the inventory token while Git reports the same
// paths. Filesystem types are verified separately, before removal can become eligible.
function classifyIgnored(paths: readonly string[]): IgnoredEntry[] {
  const manifest = new Map<string, IgnoredEntry>()
  for (const path of paths) {
    const directory = path.endsWith('/')
    const segments = (directory ? path.slice(0, -1) : path).split('/')
    const kind = segments.includes('.git') ? null : recognize(segments, directory)
    manifest.set(path, { path, kind: kind ?? 'protected' })
  }
  return [...manifest.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export { classifyIgnored }
