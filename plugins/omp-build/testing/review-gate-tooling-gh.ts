import { execFileSync } from 'node:child_process'

const VARIABLE = 'OMP_BUILD_TOOLING_SHA'
const REPOSITORY = 'Roxabi/roxabi-plugins'

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

function form(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  const found = argv.find((arg) => arg.startsWith(prefix))
  return found?.slice(prefix.length)
}

function requireTools(tools: string | undefined): string {
  if (tools === undefined || tools.length === 0) throw new Error('GATE_TOOLS is required')
  return tools
}

function blobOid(tools: string, expression: string): string | null {
  const split = expression.indexOf(':')
  if (split <= 0) return null
  try {
    return execFileSync(
      'git',
      ['-C', tools, 'rev-parse', `${expression.slice(0, split)}:${expression.slice(split + 1)}`],
      {
        encoding: 'utf8',
      },
    ).trim()
  } catch {
    return null
  }
}

function toolingVariable(argv: readonly string[], tools: string | undefined): string | undefined {
  if (argv[2] !== VARIABLE || flag(argv, '--repo') !== REPOSITORY) return undefined
  const sha = execFileSync('git', ['-C', requireTools(tools), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return `${sha}\n`
}

function toolingGraphql(argv: readonly string[], tools: string | undefined): string | undefined {
  const query = form(argv, 'query') ?? ''
  const fields = [...query.matchAll(/(?:(\w+)\s*:\s*)?\bobject\s*\(\s*expression\s*:\s*\$(\w+)\s*\)/g)]
  if (fields.length === 0) return undefined
  if (form(argv, 'owner') !== 'Roxabi' || form(argv, 'name') !== 'roxabi-plugins') return undefined
  const repository: Record<string, unknown> = {}
  for (const field of fields) {
    const oid = blobOid(requireTools(tools), form(argv, field[2] ?? '') ?? '')
    if (oid === null) {
      repository[field[1] ?? 'object'] = null
      continue
    }
    const bytes = execFileSync('git', ['-C', requireTools(tools), 'cat-file', 'blob', oid])
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

function toolingBlob(argv: readonly string[], tools: string | undefined): string | undefined {
  const blob = argv.find((arg) => BLOB.test(arg))
  if (argv[0] !== 'api' || blob === undefined) return undefined
  const oid = blob.slice(blob.lastIndexOf('/') + 1)
  const bytes = execFileSync('git', ['-C', requireTools(tools), 'cat-file', 'blob', oid])
  return `${JSON.stringify({
    sha: oid,
    size: bytes.byteLength,
    encoding: 'base64',
    content: bytes.toString('base64'),
  })}\n`
}

function toolingCommit(argv: readonly string[], tools: string | undefined): string | undefined {
  const route = argv.find((arg) => /^repos\/Roxabi\/roxabi-plugins\/git\/commits\/[0-9a-f]{40}$/.test(arg))
  if (argv[0] !== 'api' || route === undefined) return undefined
  const oid = route.slice(route.lastIndexOf('/') + 1)
  const sha = execFileSync('git', ['-C', requireTools(tools), 'rev-parse', `${oid}^{commit}`], {
    encoding: 'utf8',
  }).trim()
  return `${JSON.stringify({ sha })}\n`
}

/** Readonly answers for the approved tooling pin. Undefined means another gh command. */
export function toolingGh(argv: readonly string[], tools: string | undefined): string | undefined {
  if (argv[0] === 'variable' && argv[1] === 'get') return toolingVariable(argv, tools)
  if (argv[0] === 'api' && argv[1] === 'graphql') return toolingGraphql(argv, tools)
  return toolingBlob(argv, tools) ?? toolingCommit(argv, tools)
}
