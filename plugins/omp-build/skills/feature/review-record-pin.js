import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
export const INSTALLED_PLUGIN = PLUGIN

function flag(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function form(argv, name) {
  const found = argv.find((arg) => String(arg).startsWith(`${name}=`))
  return found === undefined ? undefined : String(found).slice(name.length + 1)
}

function toolingVariable(args) {
  if (args[2] !== 'OMP_BUILD_TOOLING_SHA' || flag(args, '--repo') !== 'Roxabi/roxabi-plugins') return null
  return `${pin.commit}\n`
}

function expressionOid(expression) {
  const split = expression.indexOf(':')
  if (split <= 0) return null
  try {
    return git(pin.root, ['rev-parse', `${expression.slice(0, split)}:${expression.slice(split + 1)}`])
  } catch {
    return null
  }
}

function toolingGraphql(args) {
  const query = form(args, 'query') ?? ''
  const fields = [...query.matchAll(/(?:(\w+)\s*:\s*)?\bobject\s*\(\s*expression\s*:\s*\$(\w+)\s*\)/g)]
  if (fields.length === 0) return null
  if (form(args, 'owner') !== 'Roxabi' || form(args, 'name') !== 'roxabi-plugins') return null
  const repository = {}
  for (const field of fields) {
    const oid = expressionOid(form(args, field[2]) ?? '')
    if (oid === null) {
      repository[field[1] ?? 'object'] = null
      continue
    }
    const bytes = execFileSync('git', ['-C', pin.root, 'cat-file', 'blob', oid])
    const text = bytes.toString('utf8')
    const isBinary = bytes.includes(0) || !Buffer.from(text).equals(bytes)
    repository[field[1] ?? 'object'] = {
      oid,
      byteSize: bytes.byteLength,
      isBinary,
      isTruncated: false,
      text: isBinary ? null : text,
    }
  }
  return `${JSON.stringify({ data: { repository } })}\n`
}

const BLOB = /^repos\/Roxabi\/roxabi-plugins\/git\/blobs\/[0-9a-f]{40}$/

function toolingBlob(args) {
  const blob = args.find((arg) => BLOB.test(String(arg)))
  if (args[0] !== 'api' || blob === undefined) return null
  const oid = String(blob).slice(String(blob).lastIndexOf('/') + 1)
  const bytes = execFileSync('git', ['-C', pin.root, 'cat-file', 'blob', oid])
  return `${JSON.stringify({
    sha: oid,
    size: bytes.byteLength,
    encoding: 'base64',
    content: bytes.toString('base64'),
  })}\n`
}

function toolingCommit(args) {
  const route = args.find((arg) => /^repos\/Roxabi\/roxabi-plugins\/git\/commits\/[0-9a-f]{40}$/.test(String(arg)))
  if (args[0] !== 'api' || route === undefined) return null
  const oid = String(route).slice(String(route).lastIndexOf('/') + 1)
  const sha = git(pin.root, ['rev-parse', `${oid}^{commit}`])
  return `${JSON.stringify({ sha })}\n`
}

/** Readonly tooling-pin answers. Null means this gh call is not a pin read. */
export function toolingGh(args) {
  if (args[0] === 'variable' && args[1] === 'get') return toolingVariable(args)
  if (args[0] === 'api' && args[1] === 'graphql') return toolingGraphql(args)
  return toolingBlob(args) ?? toolingCommit(args)
}
