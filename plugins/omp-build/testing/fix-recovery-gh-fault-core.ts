import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { githubPreparationKind } from '../host/preparation-gh-classifier.ts'
import {
  executeSimCommand,
  type SimCommandInput,
  type SimCommandResult,
} from '../skills/feature/testing/gh-simulator/sim-execution.ts'

function redactField(arg: string): string {
  const key = arg.split('=', 1)[0]
  if (key !== 'query') return `${key}=<redacted>`
  const document = arg.slice('query='.length)
  const operation = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(document)
  const sha256 = createHash('sha256').update(document, 'utf8').digest('hex')
  return `query=<${operation?.[1] ?? 'unknown'}:${operation?.[2] ?? 'anonymous'}:sha256=${sha256}>`
}

function traceArgument(arg: string, index: number, argv: string[]): string {
  if (index > 0 && ['-f', '-F', '--field', '--raw-field'].includes(argv[index - 1] ?? '')) {
    return redactField(arg)
  }
  if (index > 0 && ['-H', '--header', '--hostname'].includes(argv[index - 1] ?? '')) return '<redacted>'
  if (arg.startsWith('body=')) return 'body=<redacted>'
  return index < 2 || arg.startsWith('-') || /^(GET|POST|PATCH|PUT|DELETE|graphql)$/.test(arg) ? arg : '<redacted>'
}

// Fail only the first reconciliation page read after an accepted POST loses its response.
function failReconciliationRead(
  argv: string[],
  marker: string | undefined,
  env: NodeJS.ProcessEnv,
  callerPath: (path: string) => string,
): SimCommandResult | undefined {
  if (
    env.FIX_RECOVERY_FAIL_RECONCILE !== '1' ||
    !marker ||
    !existsSync(marker) ||
    !env.FIX_RECOVERY_FAULT_RELEASE ||
    !existsSync(callerPath(env.FIX_RECOVERY_FAULT_RELEASE))
  )
    return undefined

  const original = JSON.parse(readFileSync(marker, 'utf8')) as { kind?: string; before?: boolean; argv?: string[] }
  const endpoint = original.argv?.find((arg) => /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(arg))
  if (
    original.kind !== 'fix-request' ||
    original.before !== false ||
    !endpoint ||
    argv[0] !== 'api' ||
    argv[1] !== `${endpoint}?per_page=100&page=1` ||
    !argv.includes('--include')
  )
    return undefined

  try {
    writeFileSync(`${marker}.read-failed`, JSON.stringify({ endpoint: argv[1], operation: 'reconcile-page-one' }), {
      flag: 'wx',
    })
    return { status: 1, stdout: '', stderr: 'fixture: one reconciliation GET failed\n' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return undefined
}

// A fault may refuse a POST before dispatch or lose a response after simulator persistence.
// Its marker is transport evidence, never workflow authority.
export function executeFaultCommand(
  argv: string[],
  input: SimCommandInput,
): SimCommandResult & { awaitRelease?: string; awaitDeadline?: number } {
  const env = input.env ?? process.env
  const callerPath = (path: string) => (isAbsolute(path) ? path : `${input.cwd}/${path}`)
  if (env.RECOVERY_GH_TRACE) {
    const safe = argv.map(traceArgument)
    appendFileSync(
      callerPath(env.RECOVERY_GH_TRACE),
      `${JSON.stringify({ kind: githubPreparationKind(argv), argv: safe })}\n`,
    )
  }
  const kind = env.FIX_RECOVERY_FAULT_KIND
  const marker = env.FIX_RECOVERY_FAULT_MARKER && callerPath(env.FIX_RECOVERY_FAULT_MARKER)
  const before = env.FIX_RECOVERY_FAULT_BEFORE === '1'
  const body = argv.find((arg) => arg.startsWith('body='))?.slice(5) ?? ''
  const commentPost =
    argv.includes('POST') && argv.some((arg) => /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(arg))
  const matches = Boolean(marker && kind && commentPost && body.includes(`<!-- omp-build-record v=1 kind=${kind} `))

  const reconciliationFailure = failReconciliationRead(argv, marker, env, callerPath)
  if (reconciliationFailure) return reconciliationFailure

  function interrupt(): (SimCommandResult & { awaitRelease?: string; awaitDeadline?: number }) | undefined {
    if (!marker) return undefined
    // Publish a complete marker exclusively; readers may act immediately upon its existence.
    const staged = `${marker}.${input.pid ?? process.pid}.tmp`
    try {
      writeFileSync(staged, JSON.stringify({ kind, body, argv, before }))
      linkSync(staged, marker)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
      throw error
    } finally {
      rmSync(staged, { force: true })
    }
    return {
      status: 1,
      stdout: '',
      stderr: before
        ? 'fixture: POST refused before simulator dispatch\n'
        : 'fixture: response lost after accepted comment\n',
      ...(env.FIX_RECOVERY_FAULT_RELEASE
        ? { awaitRelease: env.FIX_RECOVERY_FAULT_RELEASE, awaitDeadline: Date.now() + 30_000 }
        : {}),
    }
  }

  if (matches && before) {
    const fault = interrupt()
    if (fault) return fault
  }
  const result = executeSimCommand(argv, input)
  if (result.status === 0 && matches && !before) return interrupt() ?? result
  return result
}
