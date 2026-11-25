import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { resolveAcceptedSpec, resolveSpecEffective } from '../../dist/contracts.js'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { featureSpecDigest } from '../../roxabi/feature-spec-digest.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, sandbox, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'
import { runFeatureCli } from './feature-cli.ts'

const exec = promisify(execFile)
const roots: string[] = []
export const fixtures = roxabiWorkflowFixtures()
export const repository = 'acme/app'
const scope = { repository, target: `${repository}#42` }
export const branch = 'feat/42-save'
export const ref = `refs/heads/${branch}`
export const date = '2026-01-01T00:00:00Z'
export const pr = 142

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

export function seedAuthority(box: Box, records: CanonicalRecord[]) {
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Expected issue')
    issue.comments = fixtures.framedBodies(records, 'operator').map((body, index) => ({
      id: index + 1,
      author: 'operator',
      body,
      createdAt: date,
      updatedAt: date,
    }))
  })
}

export function world(bound = false, baseBranch = 'main', config?: MandateRecord['payload']['config']) {
  const box = sandbox({
    base: { '.dev/stack.yml': 'release:\n  model: trunk\n', 'README.md': 'base\n' },
    branches: [
      ...(baseBranch === 'main' ? [] : [{ name: baseBranch, from: 'main', commits: [] }]),
      { name: branch, from: baseBranch, commits: [{ message: 'feat: UW #42', files: { 'README.md': 'work\n' } }] },
    ],
    issues: [{ number: 42, title: 'Deliver the change', labels: ['size:S'] }],
    prs: bound
      ? [{ number: pr, branch, base: baseBranch, title: 'Deliver the change', body: 'UW #42', closes: [] }]
      : [],
  })
  roots.push(box.root)
  git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const cwd = join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, branch])
  const tip = git(box, cwd, ['rev-parse', 'HEAD'])
  const base = git(box, cwd, ['rev-parse', 'main'])
  const spec = nativeFeatureSpec(scope, 'Deliver the change')
  const mandate = fixtures.featureMandate(scope, {
    body: spec.body,
    ownSpec: spec.ownSpec,
    branch,
    base: baseBranch,
    lineageHead: base,
    ...(config === undefined ? {} : { config }),
  })
  seedAuthority(box, [mandate])
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Expected issue')
    issue.body = spec.body
    const pull = state.prs[String(pr)]
    if (pull) {
      const binding = fixtures.workflowBinding(
        { repository, target: `${repository}#${pr}` },
        mandate,
        branch,
        baseBranch,
      )
      pull.comments = fixtures
        .framedBodies([binding], 'operator', [fixtures.historyFrom([mandate])])
        .map((body, index) => ({ id: 100 + index, author: 'operator', body, createdAt: date, updatedAt: date }))
    }
  })
  const bare = (...args: string[]) => git(box, cwd, ['--git-dir', box.origin, ...args])
  const gitRunner: GitRunner = async (at, args) => {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd: at, env: { ...box.env, LC_ALL: 'C' } })
      if (args[0] === 'remote' && args[1] === 'get-url' && stdout.trim() === box.origin) {
        // Expose the configured URL to admission; real Git still uses the sandbox's local transport rewrite.
        const configured = git(box, at, ['config', '--get-all', 'remote.origin.url'])
        const push = args.includes('--push')
          ? await exec('git', ['config', '--get-all', 'remote.origin.pushurl'], { cwd: at, env: box.env }).then(
              (result) => result.stdout,
              () => null,
            )
          : null
        return { code: 0, stdout: push ?? `${configured}\n`, stderr }
      }
      return { code: 0, stdout, stderr }
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string }
      return {
        code: typeof result.code === 'number' ? result.code : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      }
    }
  }
  const gh: Gh = async (at, args) => {
    if (args[0] === 'repo' && args[2] === `https://github.com/${repository}`)
      return JSON.stringify({ nameWithOwner: repository, url: `https://github.com/${repository}` })
    const { stdout } = await exec('gh', args, { cwd: at, env: box.env })
    if (args[0] === 'pr' && args[1] === 'view' && args.at(-1)?.includes(',url,'))
      return JSON.stringify({ ...JSON.parse(stdout), url: `https://github.com/${repository}/pull/${args[2]}` })
    return stdout
  }
  return { box, cwd, tip, base, bare, gitRunner, gh, mandate, spec }
}

type Simulation = ReturnType<typeof world>

export function acceptedDigest(f: Simulation, records: CanonicalRecord[] = [f.mandate]): string {
  const histories = [fixtures.historyFrom(records)]
  const accepted = resolveAcceptedSpec(f.mandate, histories)
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.evidence))
  const { ref, inheritedOwnSpecRefs } = accepted.spec
  const effective = resolveSpecEffective({
    mode: 'historical',
    own: ref,
    versionVector: [ref, ...inheritedOwnSpecRefs],
    histories,
  })
  if (!effective.ok) throw new Error(JSON.stringify(effective.diagnostics))
  return featureSpecDigest(effective.value)
}

export async function invoke(
  f: Simulation,
  command: string,
  args: string[],
  options: { cwd?: string; gh?: Gh; git?: GitRunner; mandate?: string } = {},
) {
  const result = await runFeatureCli(
    [command, '--repo', repository, '--issue', '42', '--mandate', options.mandate ?? f.mandate.recordId, ...args],
    { cwd: options.cwd ?? f.cwd, gh: options.gh ?? f.gh, git: options.git ?? f.gitRunner },
  )
  if (result.text === undefined) throw new Error(result.error)
  return { code: result.code, ...JSON.parse(result.text) }
}

export function abandonment(f: Simulation): CanonicalRecord {
  const draft = buildRecord({
    version: 1,
    repository,
    target: scope.target,
    recordId: 'abandon-1',
    runId: f.mandate.runId,
    operationId: 'op-abandon-1',
    kind: 'operator-control',
    payload: { control: 'abandon', controlId: 'abandon-1', mandate: fixtures.mandateRef(f.mandate), predecessor: null },
  })
  if (!draft.ok) throw new Error(JSON.stringify(draft.diagnostics))
  return draft.value
}

export function revoke(f: Simulation, nextBranch = 'feat/42-next') {
  const predecessor = fixtures.mandateRef(f.mandate)
  const next = fixtures.featureMandate(scope, {
    body: f.spec.body,
    ownSpec: f.spec.ownSpec,
    recordId: 'mandate-next',
    runId: 'run00002',
    run: 'run00002',
    operationId: 'op-mandate-next',
    antecedent: predecessor,
    branch: nextBranch,
    lineageHead: f.base,
  })
  const successor = fixtures.mandateRef(next)
  const draft = buildRecord({
    version: 1,
    repository,
    target: scope.target,
    recordId: 'select-next-mandate',
    runId: next.runId,
    operationId: 'op-select-next-mandate',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-next-mandate',
      mandate: predecessor,
      predecessor,
      successor,
    },
  })
  if (!draft.ok) throw new Error(JSON.stringify(draft.diagnostics))
  const records = [f.mandate, abandonment(f), next, draft.value]
  seedAuthority(f.box, records)
  return { next, records }
}
