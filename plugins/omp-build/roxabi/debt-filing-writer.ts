import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Json } from '../dist/contracts.js'
import { triageCli, triageDirectory } from '../triage-runtime.ts'
import type { DebtFiling, DebtFilingInput, ProcessResult, ProcessRunner, Source } from './debt-filing-contract.ts'
import { failure, REPOSITORY } from './debt-filing-contract.ts'
import { obligationBody } from './debt-filing-decision.ts'
import {
  discoveredIssues,
  discoveryQuery,
  expectedAuthor,
  mismatch,
  missingMetadata,
  readIssue,
  relationshipConflict,
} from './debt-filing-readback.ts'
import { graph, refText, resolveSource } from './debt-filing-source.ts'
import type { FixActionResult } from './fix-contract.ts'

const execFileAsync = promisify(execFile)

export function defaultRunner(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }))
    .catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      exitCode: typeof error.code === 'number' ? error.code : 1,
    }))
}

type FilingResult = FixActionResult<{ target: string; raw: Json }>
type FilingRuntime = {
  runner: ProcessRunner
  triage: string
  cwd: string
  env: NodeJS.ProcessEnv
  files: string
}

function filingFailure(diagnostic: string, detail?: string): { result: FilingResult } {
  return { result: detail === undefined ? failure(diagnostic) : failure(diagnostic, detail) }
}

async function resolveDebtIssueNumber(
  input: DebtFilingInput,
  runtime: FilingRuntime,
  source: Source,
  author: string,
  content: { title: string; body: string },
): Promise<{ number: number } | { result: FilingResult }> {
  const marker = `omp-build-debt-receipt:${input.receiptId}`
  const discovery = discoveredIssues(
    await graph(runtime.runner, discoveryQuery(input.target.repository, marker), runtime.cwd, runtime.env),
  )
  if (discovery === null) return filingFailure('issue-triage-existing-receipt-uncertain')
  if (discovery.length > 1) return filingFailure('issue-triage-existing-receipt-ambiguous')
  const existing = discovery[0]
  if (existing !== undefined) {
    return mismatch(existing, { ...content, author }).length === 0
      ? { number: existing.number }
      : filingFailure('issue-triage-existing-receipt-untrusted')
  }
  return createDebtIssue(source, content, runtime)
}

async function createDebtIssue(
  source: Source,
  content: { title: string; body: string },
  runtime: FilingRuntime,
): Promise<{ number: number } | { result: FilingResult }> {
  const titleFile = join(runtime.files, 'title.txt')
  const bodyFile = join(runtime.files, 'body.md')
  writeFileSync(titleFile, content.title)
  writeFileSync(bodyFile, content.body)
  const args = [
    '--no-env-file',
    runtime.triage,
    'create',
    '--title-file',
    titleFile,
    '--body-file',
    bodyFile,
    '--type',
    'fix',
    '--size',
    source.size,
  ]
  if (source.parent !== null) args.push('--parent', refText(source.parent))
  if (source.issue !== null) args.push('--blocked-by', refText(source.issue))
  const result = await runtime.runner('bun', args, { cwd: runtime.cwd, env: runtime.env })
  const created = /(?:^|\n)Created #([1-9][0-9]*)\b/m.exec(result.stdout)?.[1]
  return created === undefined
    ? filingFailure('issue-triage-create-unconfirmed', result.stderr || result.stdout)
    : { number: Number(created) }
}

async function verifyDebtIssue(
  input: DebtFilingInput,
  number: number,
  source: Source,
  author: string,
  content: { title: string; body: string },
  runtime: FilingRuntime,
): Promise<FilingResult | null> {
  const firstRead = await readIssue(input.target.repository, number, runtime.runner, runtime.cwd, runtime.env)
  if (firstRead === null) return failure('issue-triage-readback-unavailable')
  const immutable = mismatch(firstRead, { ...content, author })
  const conflict = relationshipConflict(firstRead, source)
  if (immutable.length > 0 || conflict.length > 0)
    return failure(`issue-triage-readback-mismatch:${[...immutable, ...conflict].join(',')}`)
  const missing = missingMetadata(firstRead, source)
  if (missing.length === 0) return null
  const repair = await runtime.runner('bun', ['--no-env-file', runtime.triage, 'set', String(number), ...missing], {
    cwd: runtime.cwd,
    env: runtime.env,
  })
  if ((repair.exitCode ?? 0) !== 0) return failure('issue-triage-repair-failed', repair.stderr || repair.stdout)
  const repaired = await readIssue(input.target.repository, number, runtime.runner, runtime.cwd, runtime.env)
  if (repaired === null) return failure('issue-triage-readback-unavailable')
  const repairedProblems = [
    ...mismatch(repaired, { ...content, author }),
    ...relationshipConflict(repaired, source),
    ...missingMetadata(repaired, source),
  ]
  return repairedProblems.length === 0 ? null : failure(`issue-triage-readback-mismatch:${repairedProblems.join(',')}`)
}

/**
 * The sole debt issue writer. It resolves the receipt's canonical decision through
 * the common GitHub codec, then treats search as discovery only and accepts a native
 * issue only after a complete identity/body/relationship read-back.
 */
export function createTrustedDebtFiling(runner: ProcessRunner = defaultRunner): DebtFiling {
  const triage = existsSync(triageCli) ? triageCli : null
  return {
    async file(input) {
      if (triage === null) return failure('issue-triage-unavailable')
      if (!REPOSITORY.test(input.target.repository)) return failure('issue-triage-repository-invalid')
      const runtime = {
        runner,
        triage,
        cwd: triageDirectory,
        env: { ...process.env, GITHUB_REPO: input.target.repository },
        files: mkdtempSync(join(tmpdir(), 'omp-build-fix-debt-')),
      }
      try {
        const source = await resolveSource(input, runner, runtime.cwd, runtime.env)
        const canonical = await expectedAuthor(input, runner, runtime.cwd, runtime.env)
        const content = obligationBody(input, canonical.decision, source)
        const resolved = await resolveDebtIssueNumber(input, runtime, source, canonical.author, content)
        if ('result' in resolved) return resolved.result
        const verification = await verifyDebtIssue(input, resolved.number, source, canonical.author, content, runtime)
        if (verification !== null) return verification
        return {
          ok: true,
          value: {
            target: `${input.target.repository}#${resolved.number}`,
            raw: { receiptId: input.receiptId, source: source.origin, size: source.size },
          },
        }
      } catch (error) {
        return failure(`issue-triage-file-failed:${error instanceof Error ? error.message : String(error)}`)
      } finally {
        rmSync(runtime.files, { recursive: true, force: true })
      }
    },
  }
}
