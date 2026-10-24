import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  type Context,
  isUnbound,
  type Outcome,
  ProtocolError,
  post,
  producerEnv,
  refusalText,
  run,
  tool,
} from './proof-acquire-tools'
import { type AssertledgerRecord, readAssertledgerRecord } from './proof-assertledger'
import { findProofRecord, recordIntegrity } from './proof-records'
import { gitResult } from './workflow-runtime.js'

export async function acquireAssertledger(ctx: Context, manifestPath: string | undefined): Promise<Outcome> {
  const treeArgs = ['rev-parse', `${ctx.candidate}^{tree}`]
  const treeRun = await gitResult(ctx.facts.toplevel, treeArgs)
  if (treeRun.code !== 0) throw new ProtocolError(`git ${treeArgs.join(' ')} failed: ${treeRun.stderr.trim()}`)
  const expected = { repository: ctx.repository, pr: ctx.pr, candidate: ctx.candidate, tree: treeRun.stdout.trim() }
  const found = findProofRecord(ctx.history, 'assertledger', ctx.candidate)
  if (manifestPath === undefined) {
    if (
      'record' in found &&
      !recordIntegrity(found.parts, 'assertledger') &&
      !isUnbound(readAssertledgerRecord(found.record, expected))
    ) {
      return 'reused'
    }
    throw new ProtocolError(
      `assertledger applies to PR #${ctx.pr} (fix ticket with an adapter) and no record binds ${ctx.candidate}: run \`assertledger check . --after ${ctx.candidate} …\` and pass its manifest with --assertledger-manifest`,
    )
  }
  // Capture before the first producer await. The exporter is not the replay input.
  const bytes = readFileSync(resolve(manifestPath))
  const manifest = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const work = mkdtempSync(join(tmpdir(), 'omp-proof-manifest-'))
  try {
    const path = join(work, 'manifest.json')
    writeFileSync(path, bytes, { mode: 0o400 })
    const local = join(ctx.facts.toplevel, 'node_modules', '.bin', 'assertledger')
    const assertledger = await tool('assertledger', existsSync(local) ? local : null)
    const argv = ['replay', path, '--json']
    const replay = await run([assertledger.path, ...argv], { cwd: ctx.facts.toplevel, env: producerEnv() })
    const record: AssertledgerRecord = {
      producer: 'assertledger',
      invocation: {
        repository: ctx.repository,
        pr: ctx.pr,
        candidate: ctx.candidate,
        manifest: path,
        tool: assertledger,
      },
      native: { manifest, replay: { argv, exit: replay.code, stdout: replay.stdout } },
    }
    const read = readAssertledgerRecord(record, expected)
    if (isUnbound(read)) throw new ProtocolError(`the manifest does not bind to the candidate — ${refusalText(read)}`)
    await post(ctx, 'assertledger', record)
    return 'posted'
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
