import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../adapters/github/transport.ts'
import { parseRecord } from '../engine/record-construction.ts'
import { selectWorkflowBinding } from '../engine/workflow-pr-binding.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { readSim, sandbox, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import { confirmWorkflowBinding } from './feature-admission.ts'

const exec = promisify(execFile)
const root = { repository: 'acme/app', target: 'acme/app#42' }
const pull = { repository: 'acme/app', target: 'acme/app#7' }
const branch = 'feature/42-work'
const roots = new Set<string>()
const fixtures = roxabiWorkflowFixtures()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it.each(['valid', 'branch', 'base', 'branchless', 'existing-branch'] as const)(
  'confirms or refuses the %s mandate through the public binding producer',
  async (scenario) => {
    const spec = nativeFeatureSpec(root, 'deliver the change')
    const box = sandbox({
      base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
      branches: [{ name: branch, from: 'main', commits: [] }],
      issues: [{ number: 42, title: 'work', labels: ['size:S'] }],
      prs: [{ number: 7, branch, title: 'work', body: 'Closes #42', closes: [42] }],
    })
    roots.add(box.root)
    const seed = fixtures.featureMandate(root, {
      body: spec.body,
      ownSpec: spec.ownSpec,
      branch,
      base: 'main',
      recordId: 'root-mandate',
    })
    const parsed = parseRecord({
      ...seed,
      payload: {
        ...seed.payload,
        branch:
          scenario === 'branchless'
            ? null
            : scenario === 'branch' || scenario === 'existing-branch'
              ? 'feature/other'
              : branch,
        base: scenario === 'base' ? 'other-base' : 'main',
      },
    })
    if (!parsed.ok || parsed.value.kind !== 'mandate') throw new Error('invalid mandate fixture')
    const mandate = parsed.value
    const home = fixtures.historyFrom([mandate], 'operator', 'operator')
    const binding = fixtures.workflowBinding(pull, mandate, branch, 'main')
    writeSim(box, (state) => {
      const issue = state.issues['42']
      const pr = state.prs['7']
      if (!issue || !pr) throw new Error('missing native fixture')
      issue.body = spec.body
      issue.comments = fixtures.framedBodies([mandate], 'operator').map((body) => ({ author: 'operator', body }))
      if (scenario === 'existing-branch')
        pr.comments = fixtures.framedBodies([binding], 'operator', [home]).map((body) => ({ author: 'operator', body }))
    })
    const gh = async (cwd: string, args: string[]) => (await exec('gh', args, { cwd, env: box.env })).stdout
    const before = readSim(box).prs['7']?.comments.map(({ author, body }) => ({ author, body }))
    const result = await confirmWorkflowBinding({ cwd: box.principal, issue: 42, pr: 7, branch, base: 'main', gh })
    const state = readSim(box)
    const posts = state.calls.filter(
      (args) =>
        args[0] === 'api' &&
        args.includes('--method') &&
        args.includes('POST') &&
        args.some((arg) => arg === 'repos/acme/app/issues/7/comments'),
    )
    if (scenario !== 'valid') {
      expect(result).toEqual({ ok: false, reason: 'mandate-metadata-mismatch' })
      expect(posts).toEqual([])
      expect(state.prs['7']?.comments.map(({ author, body }) => ({ author, body }))).toEqual(before)
      return
    }
    expect(result).toMatchObject({ ok: true, recordId: `workflow-binding:${pull.target}:${mandate.recordId}` })
    expect(posts.length).toBeGreaterThan(0)
    const observed = decodeHistory(await readGitHubHistory(pull, { cwd: box.principal, gh, readAuthor: 'operator' }))
    expect(
      selectWorkflowBinding({ pullRequest: pull, histories: [observed, home], native: { branch, base: 'main' } }),
    ).toMatchObject({ status: 'bound', mandate: fixtures.mandateRef(mandate) })
  },
)
