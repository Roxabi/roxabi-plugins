import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { actionInputDigest } from '../../engine/action-input.ts'
import { ACTION_BINDING_FORMAT, ACTION_INPUT_FORMAT, type ActionInputs } from '../../engine/action-input-schema.ts'
import { unframedParserSchema } from '../../engine/issue-spec-analysis-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { registerHostActionBinding } from '../../omp/review-runtime/action-registry.ts'
import type { PreparedUwAction } from '../uw-action-contract.ts'
import { sealActionSnapshot } from '../uw-action-snapshot.ts'
import type { NormalizationProposalRequest } from '../uw-contract.ts'
import { normalizationSourceDigest } from '../uw-normalization-proposal.ts'
import type { GitRunner } from '../workflow-checkout.ts'

export const observedHead = 'c'.repeat(40)
const login = 'normalization-fixture'
const pluginCommit = 'b'.repeat(40)
const configDigest = 'd'.repeat(64)

type Gh = (cwd: string, args: string[]) => Promise<string>

let restoreViewer: (() => void) | null = null

export function observationalGit(): GitRunner {
  return async (_cwd, args) => {
    if (args[0] === 'rev-parse' && args.includes('--verify') && args.some((arg) => arg.startsWith('HEAD'))) {
      return { code: 0, stdout: `${observedHead}\n`, stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unobserved git ${args.join(' ')}` }
  }
}

/** In-memory issue comments. Publication uses the real encoder; this only stores and returns those bodies. */
export function observationalGh(): Gh {
  const comments: Array<{
    id: number
    body: string
    user: { login: string }
    created_at: string
    updated_at: string
  }> = []
  let nextId = 1
  return async (_cwd, args) => {
    if (args[0] === 'api' && args[1] === 'user') return `${login}\n`
    const command = args.join(' ')
    if (args.includes('--method') && args.includes('POST') && command.includes('/comments')) {
      const body = args.find((arg) => arg.startsWith('body='))?.slice('body='.length) ?? ''
      const posted = {
        id: nextId,
        body,
        user: { login },
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T00:00:00Z',
      }
      nextId += 1
      comments.push(posted)
      return JSON.stringify(posted)
    }
    if (args[0] === 'api' && command.includes('/comments?')) {
      const page = Number(
        new URL(`http://local/${args.find((arg) => arg.includes('/comments?')) ?? ''}`).searchParams.get('page') ?? '1',
      )
      return JSON.stringify(page === 1 ? comments : [])
    }
    throw new Error(`unobserved gh ${command}`)
  }
}

/** Isolates the process-wide GitHub viewer cache from the operator token. */
export function isolateViewerToken(): void {
  restoreViewer?.()
  const token = process.env.GH_TOKEN
  const github = process.env.GITHUB_TOKEN
  const fixture = `normalization-${randomUUID()}`
  process.env.GH_TOKEN = fixture
  process.env.GITHUB_TOKEN = fixture
  restoreViewer = () => {
    if (token === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = token
    if (github === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = github
    restoreViewer = null
  }
}

export function releaseViewerToken(): void {
  restoreViewer?.()
}

export function preparedNormalization(request: NormalizationProposalRequest, pinProfile = false): PreparedUwAction {
  const uw: Scope = request.uw
  const parsed = request.parsed
  const spec =
    parsed.status === 'conformant'
      ? { kind: 'proposed' as const, uw, snapshot: parsed.snapshot }
      : {
          kind: 'unframed' as const,
          uw,
          source: parsed.raw,
          parser: unframedParserSchema.parse({
            status: parsed.status,
            diagnostics: [],
            analysis: parsed.analysis,
            draft: parsed.status === 'draft' ? parsed.draft : null,
          }),
        }
  if (
    normalizationSourceDigest(request) !==
    (spec.kind === 'proposed' ? spec.snapshot.raw.bodySha256 : spec.source.bodySha256)
  ) {
    throw new Error('normalize fixture digest does not match the request source')
  }
  const profile = pinProfile ? readFileSync(new URL('../../agents/R-uw-normalize.md', import.meta.url)) : null
  const manifest = {
    format: ACTION_INPUT_FORMAT,
    purpose: 'normalize' as const,
    subject: { kind: 'uw' as const, uw, pullRequest: null, binding: null },
    spec,
    code: { repository: uw.repository, base: observedHead, head: observedHead, referenceCommit: observedHead },
    acceptedSources: [],
    deliveryData: [],
    repositoryReferences: [],
    plugin: {
      name: 'omp-build' as const,
      version: '0.15.0',
      repository: 'Roxabi/roxabi-plugins',
      commit: pluginCommit,
      root: 'plugins/omp-build',
      files:
        profile === null
          ? []
          : [
              {
                source: 'git-file' as const,
                repository: 'Roxabi/roxabi-plugins',
                commit: pluginCommit,
                path: 'plugins/omp-build/agents/R-uw-normalize.md',
                digest: createHash('sha256').update(profile).digest('hex'),
              },
            ],
    },
    configuration: { version: '0.15.0', digest: configDigest, serialized: 'normalization-fixture' },
    expandedContext: [],
  }
  const inputs: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest,
    fingerprint: actionInputDigest(manifest),
    stageSources: [],
  }
  const directory = join(tmpdir(), `omp-normalize-${randomUUID()}`)
  mkdirSync(directory)
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const bytes = new TextEncoder().encode(`# ${uw.target}\n`)
  const indexPath = join(directory, 'index.md')
  writeFileSync(indexPath, bytes)
  if (profile !== null) {
    mkdirSync(join(directory, 'plugin', 'agents'), { recursive: true })
    writeFileSync(join(directory, 'plugin', 'agents', 'R-uw-normalize.md'), profile)
  }
  const sealed = sealActionSnapshot(
    { id: indexPath, actionId: uw.target, manifestDigest: inputs.fingerprint, indexPath, location: 'local' },
    [
      { path: 'index.md', bytes },
      ...(profile === null ? [] : [{ path: 'plugin/agents/R-uw-normalize.md', bytes: profile }]),
    ],
  )
  if (!sealed.ok) throw new Error(sealed.diagnostics.map((item) => item.code).join(','))
  if (profile !== null) registerHostActionBinding(sealed.value, inputs)
  return { inputs, snapshot: sealed.value }
}
