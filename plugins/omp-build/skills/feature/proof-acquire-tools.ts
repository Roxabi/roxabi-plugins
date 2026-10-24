import { realpathSync } from 'node:fs'
import { type DecodedHistory, publishGitHubRecord } from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import type { Gh, Producer, Refusal } from './proof-base'
import { isMap } from './proof-base'
import type { CandidateFacts } from './proof-candidate'
import { refreshSelectedBase } from './proof-candidate'
import { newProofRecord } from './proof-records'
import type { ChangeResult } from './proof-semctx-protocol'
import { gitResult } from './workflow-runtime.js'

export class ProtocolError extends Error {}

export type Outcome = 'not-applicable' | 'reused' | 'posted'
export type SemctxAcquisition = { outcome: 'reused' | 'posted'; assessment: ChangeResult[] | Refusal }
export type Context = {
  cwd: string
  pr: number
  candidate: string
  base: string
  baseTip: string
  repository: string
  history: DecodedHistory
  facts: CandidateFacts
}

export async function run(
  argv: string[],
  options: { cwd?: string; input?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input === undefined ? 'ignore' : new Blob([options.input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stdout, stderr }
}

export const gh: Gh = async (cwd, args) => {
  const result = await run(['gh', ...args], { cwd })
  if (result.code !== 0)
    throw new Error(`gh ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

/** The environment a producer runs in: no git redirection from a calling hook. */
export function producerEnv(): Record<string, string | undefined> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

export function refusalText(refusal: Refusal): string {
  return `${refusal.producer} ${refusal.reason}: ${refusal.error}`
}

/**
 * No reuse, absence report or publication switches the attempt's native coordinates:
 * the head, base name and OPEN state GitHub reports, and the base tip a fresh fetch
 * reads (`baseRefOid` does not follow the branch).
 */
export async function assertCurrent(ctx: Context): Promise<void> {
  const current: unknown = JSON.parse(
    await gh(ctx.cwd, ['pr', 'view', String(ctx.pr), '--json', 'headRefOid,baseRefName,state']),
  )
  const changed = `PR #${ctx.pr} coordinates changed during acquisition; re-enter with the current head and base`
  if (
    !isMap(current) ||
    current.state !== 'OPEN' ||
    current.headRefOid !== ctx.candidate ||
    current.baseRefName !== ctx.base
  ) {
    throw new ProtocolError(changed)
  }
  const fetched = await refreshSelectedBase(ctx.cwd, ctx.base, gitResult, gh)
  if (!fetched.ok) throw new ProtocolError(refusalText(fetched))
  if (fetched.tip !== ctx.baseTip) throw new ProtocolError(`${changed} (${ctx.base}@${ctx.baseTip} → ${fetched.tip})`)
}

/** The shared publisher owns multipart framing, acknowledgement and read-back. */
export async function post(ctx: Context, producer: Producer, data: unknown): Promise<void> {
  await assertCurrent(ctx)
  const published = await publishGitHubRecord(
    newProofRecord(ctx.repository, ctx.pr, producer, ctx.candidate, data),
    ctx.history,
    withRoxabiGitHubPolicy({ cwd: ctx.cwd, gh }),
    null,
  )
  if (published.status !== 'confirmed')
    throw new ProtocolError(
      `the ${producer} proof publication was ${published.status}: ${published.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
    )
  await assertCurrent(ctx)
}

export async function tool(name: string, local: string | null): Promise<{ path: string; version: string }> {
  const found = local ?? Bun.which(name)
  if (!found) throw new ProtocolError(`${name} is not installed: no ${name} on PATH`)
  const path = realpathSync(found)
  const version = await run([path, '--version'], { env: producerEnv() })
  if (version.code !== 0)
    throw new ProtocolError(`${path} --version failed (${version.code}): ${version.stderr.trim()}`)
  return { path, version: version.stdout.trim() }
}

/** A refusal saying the record does not bind or cannot be read — never a producer verdict. */
export function isUnbound(outcome: unknown): outcome is Refusal {
  return isMap(outcome) && outcome.ok === false && (outcome.reason === 'unbound' || outcome.reason === 'unreadable')
}
