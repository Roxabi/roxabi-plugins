import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Context,
  isUnbound,
  ProtocolError,
  post,
  producerEnv,
  refusalText,
  run,
  type SemctxAcquisition,
  tool,
} from './proof-acquire-tools'
import { semctxInputs } from './proof-association'
import { findProofRecord, recordIntegrity } from './proof-records'
import {
  type SemctxExpected,
  type SemctxRecord,
  type Step,
  semctxSteps,
  stepExitAllowed,
} from './proof-semctx-protocol'
import { readSemctxRecord } from './proof-semctx-validation'
import { gitResult } from './workflow-runtime.js'

type SemctxInputs = Pick<SemctxExpected, 'base' | 'mergeBase' | 'contracts' | 'historicalContracts' | 'config'>

async function expectedSemctx(ctx: Context): Promise<{ expected: SemctxExpected; inputs: SemctxInputs }> {
  const inputs = await semctxInputs(ctx.facts, gitResult)
  if ('ok' in inputs) throw new ProtocolError(refusalText(inputs))
  return {
    inputs,
    expected: {
      repository: ctx.repository,
      pr: ctx.pr,
      candidate: ctx.candidate,
      ...inputs,
      changeFiles: ctx.facts.changeFiles,
    },
  }
}

function reusableSemctx(ctx: Context, expected: SemctxExpected): SemctxAcquisition | undefined {
  const found = findProofRecord(ctx.history, 'semctx', ctx.candidate)
  if (!('record' in found) || recordIntegrity(found.parts, 'semctx')) return
  const assessment = readSemctxRecord(found.record, expected)
  return isUnbound(assessment) ? undefined : { outcome: 'reused', assessment }
}

async function checkoutCandidate(ctx: Context, work: string, root: string): Promise<void> {
  const commands = [
    [work, ['clone', '-q', '--shared', '--no-checkout', '--', ctx.facts.toplevel, root]],
    [root, ['checkout', '-q', '--detach', ctx.candidate]],
  ] as const
  for (const [cwd, args] of commands) {
    const result = await gitResult(cwd, [...args])
    if (result.code !== 0)
      throw new ProtocolError(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
  }
}

async function cleanBefore(root: string, statusArgs: string[]): Promise<string> {
  const before = await gitResult(root, statusArgs)
  if (before.code !== 0 || before.stdout)
    throw new ProtocolError(`the private checkout is not clean before the run: ${before.stderr || before.stdout}`)
  return before.stdout
}

async function nativeSteps(
  path: string,
  work: string,
  root: string,
  contracts: string[],
  mergeBase: string,
  candidate: string,
): Promise<Step[]> {
  const native: Step[] = []
  for (const argv of semctxSteps(root, contracts, mergeBase, candidate)) {
    const result = await run([path, ...argv], { cwd: work, env: producerEnv() })
    if (!stepExitAllowed(argv).includes(result.code)) {
      throw new ProtocolError(
        `semctx ${argv.slice(2).join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim()}`,
      )
    }
    native.push({ argv, exit: result.code, stdout: result.stdout })
  }
  return native
}

async function finalStatus(root: string, statusArgs: string[]): Promise<{ after: string; ignored: string[] }> {
  const after = await gitResult(root, statusArgs)
  if (after.code !== 0) throw new ProtocolError(`git status failed after the run: ${after.stderr.trim()}`)
  const ignoredRun = await gitResult(root, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=all'])
  if (ignoredRun.code !== 0) throw new ProtocolError(`git status --ignored failed: ${ignoredRun.stderr.trim()}`)
  const ignored = ignoredRun.stdout
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
  return { after: after.stdout, ignored }
}

async function captureSemctx(ctx: Context, expected: SemctxExpected, inputs: SemctxInputs): Promise<SemctxAcquisition> {
  const semctx = await tool('semctx', null)
  const work = mkdtempSync(join(tmpdir(), 'omp-proof-'))
  try {
    const root = join(work, 'repo')
    await checkoutCandidate(ctx, work, root)
    const statusArgs = ['status', '--porcelain', '-z', '--untracked-files=all']
    const before = await cleanBefore(root, statusArgs)
    const native = await nativeSteps(semctx.path, work, root, inputs.contracts, inputs.mergeBase, ctx.candidate)
    const { after, ignored } = await finalStatus(root, statusArgs)
    const record: SemctxRecord = {
      producer: 'semctx',
      invocation: {
        repository: ctx.repository,
        pr: ctx.pr,
        candidate: ctx.candidate,
        base: ctx.base,
        mergeBase: inputs.mergeBase,
        contracts: inputs.contracts,
        root,
        config: inputs.config,
        tool: semctx,
        status: { before, after },
        ignored,
      },
      native,
    }
    const assessment = readSemctxRecord(record, expected)
    if (isUnbound(assessment))
      throw new ProtocolError(`the run does not bind to the candidate — ${refusalText(assessment)}`)
    await post(ctx, 'semctx', record)
    return { outcome: 'posted', assessment }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function acquireSemctx(ctx: Context): Promise<SemctxAcquisition> {
  const { expected, inputs } = await expectedSemctx(ctx)
  const reused = reusableSemctx(ctx, expected)
  return reused ?? captureSemctx(ctx, expected, inputs)
}
