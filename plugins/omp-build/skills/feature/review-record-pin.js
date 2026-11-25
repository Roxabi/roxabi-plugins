import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toolingGh as fixtureToolingGh } from '../../testing/review-gate-tooling-gh.ts'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REQUIRED = [
  'package.json',
  'GLOSSARY.md',
  'skills/dev-review/review-classes.yml',
  'skills/dev-review/chunker.py',
  'skills/dev-review/digest.py',
  'skills/dev-review/prepare_context.py',
  'skills/dev-review/evidence-policy.md',
  'skills/dev-review/root-causes.md',
  'skills/dev-review/review-smells.md',
  'skills/dev-review/review-blind-spots.md',
  ...readdirSync(path.join(PLUGIN, 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `agents/${name}`),
]

function git(cwd, args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    },
  ).trim()
}

function createPin() {
  const root = mkdtempSync(path.join(tmpdir(), 'omp-review-pin-'))
  git(root, ['init', '-q', '-b', 'main'])
  for (const file of REQUIRED) {
    const dest = path.join(root, 'plugins/omp-build', file)
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(path.join(PLUGIN, file), dest)
  }
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'installed tooling identity'])
  return { root, commit: git(root, ['rev-parse', 'HEAD']) }
}

const pin = createPin()
export const TOOLING_COMMIT = pin.commit

/** Readonly tooling-pin answers. Null means this gh call is not a pin read. */
export function toolingGh(args) {
  return fixtureToolingGh(args, pin.root) ?? null
}
