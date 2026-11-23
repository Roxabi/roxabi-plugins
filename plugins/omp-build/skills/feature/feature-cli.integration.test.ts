import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import {
  abandonment,
  branch,
  date,
  fixtures,
  invoke,
  pr,
  ref,
  repository,
  revoke,
  seedAuthority,
  world,
} from './feature-cli.fixture.ts'

const app = 17
const rules = [
  {
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'review', integration_id: app }] },
  },
]

it('runs through trusted Bun and reports strict usage without extra JSON or effects', () => {
  const run = (...args: string[]) =>
    spawnSync(
      'bash',
      [join(import.meta.dirname, 'trusted-bun.sh'), join(import.meta.dirname, 'feature-cli.ts'), ...args],
      { encoding: 'utf8' },
    )
  const help = run('--help')
  expect(help).toMatchObject({ status: 0, stderr: '' })
  expect(help.stdout).toContain('finish --pr <N>')
  const invalid = run('land', '--repo', repository, '--issue', '42', '--mandate', 'x', '--pr', '1', '--pr', '2')
  expect(invalid).toMatchObject({ status: 2, stdout: '' })
  expect(invalid.stderr).toContain('invalid command or arguments')
})

it('pushes the captured SHA despite a local branch move, and never follows annotated tags', async () => {
  const f = world()
  f.bare('update-ref', '-d', ref)
  git(f.box, f.cwd, ['config', 'push.followTags', 'true'])
  git(f.box, f.cwd, ['tag', '-am', 'do not publish', 'unexpected-tag', f.tip])
  let invoked = false
  const gitAtWrite: GitRunner = (at, args) => {
    if (args[0] === 'push') {
      invoked = true
      git(f.box, f.cwd, ['update-ref', ref, f.base])
    }
    return f.gitRunner(at, args)
  }
  expect(await invoke(f, 'push', ['--tip', f.tip], { git: gitAtWrite })).toMatchObject({
    code: 0,
    status: 'pushed',
    head: f.tip,
  })
  expect(invoked).toBe(true)
  expect(f.bare('rev-parse', ref)).toBe(f.tip)
  expect(f.bare('tag', '--list')).toBe('')
  git(f.box, f.cwd, ['update-ref', ref, f.tip])
  expect(await invoke(f, 'push', ['--tip', f.tip])).toMatchObject({ code: 0, status: 'already-published' })
})

it.each(['moved', 'deleted', 'created', 'created at the intended tip'] as const)(
  'refuses when the remote branch is %s at the lease boundary',
  async (race) => {
    const f = world()
    const created = race.startsWith('created')
    const other =
      race === 'created at the intended tip'
        ? f.tip
        : f.bare('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'concurrent update')
    if (created) f.bare('update-ref', '-d', ref)
    else f.bare('update-ref', ref, f.base)
    let invoked = false
    const gitAtWrite: GitRunner = (at, args) => {
      if (args[0] === 'push') {
        invoked = true
        if (race === 'deleted') f.bare('update-ref', '-d', ref)
        else f.bare('update-ref', ref, other)
      }
      return f.gitRunner(at, args)
    }
    const args = created ? ['--tip', f.tip] : ['--from', f.base, '--tip', f.tip]
    expect(await invoke(f, 'push', args, { git: gitAtWrite })).toMatchObject({
      code: 1,
      status: 'refused',
      reason: 'remote-lease-mismatch',
    })
    expect(invoked).toBe(true)
    expect(f.bare('for-each-ref', '--format=%(objectname)', ref)).toBe(race === 'deleted' ? '' : other)
  },
)

it.each(['multiple', 'wrong-repo'] as const)(
  'refuses %s effective push destinations before writing',
  async (scenario) => {
    const f = world()
    f.bare('update-ref', '-d', ref)
    const wrong = 'https://github.com/acme/other.git'
    writeSim(f.box, (state) => {
      state.repositoryUrls = { [wrong]: 'acme/other' }
    })
    git(f.box, f.cwd, ['remote', 'set-url', '--push', 'origin', wrong])
    if (scenario === 'multiple') git(f.box, f.cwd, ['remote', 'set-url', '--push', '--add', 'origin', f.box.origin])
    expect(await invoke(f, 'push', ['--tip', f.tip])).toMatchObject({
      code: 1,
      status: 'refused',
      reason: scenario === 'multiple' ? 'multiple-origin-push-urls' : 'origin-repository-mismatch',
    })
    expect(f.bare('for-each-ref', '--format=%(objectname)', ref)).toBe('')
  },
)

it.each([repository, 'file:///tmp/acme/app', '/tmp/acme/app'])('rejects a non-GitHub push URL: %s', async (url) => {
  const f = world()
  git(f.box, f.cwd, ['remote', 'set-url', '--push', 'origin', url])
  f.bare('update-ref', '-d', ref)
  let pushed = false
  const spoofRepoView: Gh = (cwd, args) =>
    args[0] === 'repo' && args[2] === url && args.at(-1) === 'nameWithOwner,url'
      ? Promise.resolve(JSON.stringify({ nameWithOwner: repository, url: `https://github.com/${repository}` }))
      : f.gh(cwd, args)
  const observePush: GitRunner = (cwd, args) => {
    if (args[0] === 'push') pushed = true
    return f.gitRunner(cwd, args)
  }
  expect(await invoke(f, 'push', ['--tip', f.tip], { gh: spoofRepoView, git: observePush })).toMatchObject({
    code: 1,
    reason: 'origin-unreadable',
  })
  expect(pushed).toBe(false)
})

it('rechecks the mandate when it is revoked after initial push admission', async () => {
  const f = world()
  f.bare('update-ref', '-d', ref)
  let revoked = false
  let pushed = false
  const gitDuringPush: GitRunner = (cwd, args) => {
    if (args[0] === 'merge-base') {
      revoke(f)
      revoked = true
    }
    if (args[0] === 'push') pushed = true
    return f.gitRunner(cwd, args)
  }
  expect(await invoke(f, 'push', ['--tip', f.tip], { git: gitDuringPush })).toMatchObject({
    code: 1,
    reason: 'exact-mandate-not-applicable',
  })
  expect(revoked).toBe(true)
  expect(pushed).toBe(false)
})

it('refuses to publish a leaf whose mandate base is not the default branch', async () => {
  const f = world(false, 'staging')
  f.bare('update-ref', '-d', ref)
  expect(await invoke(f, 'push', ['--tip', f.tip])).toMatchObject({ code: 1, reason: 'default-base-required' })
  expect(f.bare('for-each-ref', '--format=%(objectname)', ref)).toBe('')
  f.bare('update-ref', ref, f.tip)
  expect(await invoke(f, 'open-pr', ['--tip', f.tip])).toMatchObject({ code: 1, reason: 'default-base-required' })
  expect(readSim(f.box).prs).toEqual({})
})

it.each(['paused', 'abandoned', 'revoked', 'not-applicable'] as const)(
  'does not write under a %s mandate',
  async (reason) => {
    const f = world()
    f.bare('update-ref', '-d', ref)
    if (reason === 'paused') {
      const request = fixtures.pauseRequested(f.mandate)
      seedAuthority(f.box, [f.mandate, request, fixtures.pauseConfirmed(f.mandate, request)])
    }
    if (reason === 'abandoned') seedAuthority(f.box, [f.mandate, abandonment(f)])
    if (reason === 'revoked') revoke(f)
    const mandate = reason === 'not-applicable' ? 'not-current' : f.mandate.recordId
    expect(await invoke(f, 'push', ['--tip', f.tip], { mandate })).toMatchObject({
      code: 1,
      status: 'refused',
      reason: `exact-mandate-${reason === 'revoked' ? 'not-applicable' : reason}`,
    })
    expect(f.bare('for-each-ref', '--format=%(objectname)', ref)).toBe('')
  },
)

it('requires the bound PR and its current head for a correction push', async () => {
  const f = world(true)
  git(f.box, f.cwd, ['commit', '-qm', 'fix: correction', '--allow-empty'])
  const corrected = git(f.box, f.cwd, ['rev-parse', 'HEAD'])
  expect(await invoke(f, 'push', ['--from', f.tip, '--tip', corrected])).toMatchObject({
    code: 1,
    reason: 'push-pr-mismatch',
  })
  expect(await invoke(f, 'push', ['--pr', String(pr), '--from', f.base, '--tip', corrected])).toMatchObject({
    code: 1,
    reason: 'push-pr-head-mismatch',
  })
  expect(f.bare('rev-parse', ref)).toBe(f.tip)
  expect(await invoke(f, 'push', ['--pr', String(pr), '--from', f.tip, '--tip', corrected])).toMatchObject({
    code: 0,
    status: 'pushed',
    head: corrected,
    pr,
  })
  expect(f.bare('rev-parse', ref)).toBe(corrected)
})

it('creates and confirms one receipt-free PR, then readopts it without reposting', async () => {
  const f = world()
  const result = await invoke(f, 'open-pr', ['--tip', f.tip])
  const binding = `workflow-binding:${repository}#100:${f.mandate.recordId}`
  expect(result).toMatchObject({ code: 0, status: 'created', pr: 100, head: f.tip, binding })
  expect(await invoke(f, 'open-pr', ['--tip', f.tip])).toMatchObject({ code: 0, status: 'existing', pr: 100, binding })
  const state = readSim(f.box)
  expect(state.prs['100']?.body).toBe('UW #42')
  expect(
    state.calls.filter(
      (args) => args[0] === 'api' && args.includes('POST') && args.includes(`repos/${repository}/pulls`),
    ),
  ).toHaveLength(1)
})

it('ignores closed and merged PRs when reusing a unique open PR', async () => {
  const f = world(true)
  const gh: Gh = (cwd, args) =>
    args[0] === 'pr' && args[1] === 'list'
      ? Promise.resolve(
          JSON.stringify(
            [
              [pr, 'OPEN'],
              [pr + 1, 'CLOSED'],
              [pr + 2, 'MERGED'],
            ].map(([number, state]) => ({
              number,
              state,
              isCrossRepository: false,
              baseRefName: 'main',
            })),
          ),
        )
      : f.gh(cwd, args)
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { gh })).toMatchObject({ code: 0, status: 'existing', pr })
})

it('readopts the latest authenticated binding on a successor PR', async () => {
  const f = world(true)
  const { next, records } = revoke(f, branch)
  const binding = fixtures.workflowBinding({ repository, target: `${repository}#${pr}` }, next, branch, 'main')
  writeSim(f.box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error('Expected PR')
    pull.comments.push(
      ...fixtures
        .framedBodies([binding], 'operator', [fixtures.historyFrom(records)])
        .map((body, index) => ({ id: 200 + index, author: 'operator', body, createdAt: date, updatedAt: date })),
    )
  })
  const before = readSim(f.box).prs[String(pr)]?.comments
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { mandate: next.recordId })).toMatchObject({
    code: 0,
    status: 'existing',
    pr,
    binding: binding.recordId,
  })
  expect(readSim(f.box).prs[String(pr)]?.comments).toEqual(before)
})

it('refuses instead of adopting the least of several matching open PRs', async () => {
  const f = world()
  const gh: Gh = (cwd, args) =>
    args[0] === 'pr' && args[1] === 'list'
      ? Promise.resolve(
          JSON.stringify(
            [101, 100].map((number) => ({ number, isCrossRepository: false, state: 'OPEN', baseRefName: 'main' })),
          ),
        )
      : f.gh(cwd, args)
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { gh })).toMatchObject({ code: 1, reason: 'ambiguous-pr' })
  expect(readSim(f.box).prs).toEqual({})
})

it('refuses an open PR targeting a different base even when another PR is closed', async () => {
  const f = world()
  const gh: Gh = (cwd, args) =>
    args[0] === 'pr' && args[1] === 'list'
      ? Promise.resolve(
          JSON.stringify([
            { number: 100, isCrossRepository: false, state: 'OPEN', baseRefName: 'staging' },
            { number: 101, isCrossRepository: false, state: 'CLOSED', baseRefName: 'main' },
          ]),
        )
      : f.gh(cwd, args)
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { gh })).toMatchObject({ code: 1, reason: 'conflicting-pr' })
  expect(readSim(f.box).prs).toEqual({})
})

it.each(['CLOSED', 'MERGED'])('does not replace a terminal %s PR on the same branch', async (state) => {
  const f = world(true)
  writeSim(f.box, (sim) => {
    const pull = sim.prs[String(pr)]
    if (!pull) throw new Error('Expected PR')
    pull.state = state
    if (state === 'MERGED') pull.comments = []
  })
  const before = readSim(f.box).prs
  expect(await invoke(f, 'open-pr', ['--tip', f.tip])).toMatchObject({ code: 1, reason: 'conflicting-pr' })
  expect(readSim(f.box).prs).toEqual(before)
})

it('refuses to land when the required review check is not pinned to a GitHub App', async () => {
  const f = world(true)
  const gh: Gh = (cwd, args) =>
    args[1] === `repos/${repository}/rules/branches/main`
      ? Promise.resolve(
          JSON.stringify([
            { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review' }] } },
          ]),
        )
      : f.gh(cwd, args)
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip], { gh })).toMatchObject({
    code: 1,
    reason: 'no-verdict-lock',
  })
  expect(readSim(f.box).calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})

it('refuses to land without an enforced review check rule', async () => {
  const f = world(true)
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip])).toMatchObject({
    code: 1,
    reason: 'no-verdict-lock',
  })
  expect(readSim(f.box).prs[String(pr)]?.state).toBe('OPEN')
})

it('refuses to land a PR on a base with a merge queue', async () => {
  const f = world(true)
  const gh: Gh = (cwd, args) =>
    args[1] === `repos/${repository}/rules/branches/main`
      ? Promise.resolve(JSON.stringify([...rules, { type: 'merge_queue' }]))
      : f.gh(cwd, args)
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip], { gh })).toMatchObject({
    code: 1,
    reason: 'merge-queue',
  })
  expect(readSim(f.box).calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})

it('refuses to land when the base changes during the final mandate read', async () => {
  const f = world(true)
  f.bare('update-ref', 'refs/heads/staging', f.base)
  let checkedRules = false
  let retargeted = false
  const gh: Gh = (cwd, args) => {
    if (args[1] === `repos/${repository}/rules/branches/main`) {
      checkedRules = true
      return Promise.resolve(JSON.stringify(rules))
    }
    return f.gh(cwd, args)
  }
  const duringRefresh: GitRunner = (cwd, args) => {
    if (checkedRules && args[0] === 'symbolic-ref') {
      retargeted = true
      writeSim(f.box, (state) => {
        const pull = state.prs[String(pr)]
        if (pull) pull.baseRefName = 'staging'
      })
    }
    return f.gitRunner(cwd, args)
  }
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip], { gh, git: duringRefresh })).toMatchObject({
    code: 1,
    reason: 'pr-coordinates-mismatch',
  })
  expect(retargeted).toBe(true)
  expect(readSim(f.box).calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})

it('refuses an exact merge when the named mandate is superseded before the write', async () => {
  const f = world(true)
  const gh: Gh = (cwd, args) => {
    if (args[1] === `repos/${repository}/rules/branches/main`) {
      revoke(f)
      return Promise.resolve(JSON.stringify(rules))
    }
    return f.gh(cwd, args)
  }
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip], { gh })).toMatchObject({
    code: 1,
    status: 'refused',
  })
  expect(readSim(f.box).calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})

it('requests one exact-head merge, and closes only after an exact-head review check succeeds', async () => {
  const f = world(true)
  let mergeCalls = 0
  let reviewedHead = f.base
  let reviewedApp = app
  let conclusion = 'success'
  let reviewStatus = 'completed'
  let reviewRules: unknown = rules
  let completedAt = '2026-01-01T00:00:01Z'
  let closeCalls = 0
  const gh: Gh = async (cwd, args) => {
    if (args[1] === `repos/${repository}/rules/branches/main`) return JSON.stringify(reviewRules)
    if (args[1] === `repos/${repository}/commits/${f.tip}/check-runs?check_name=review&per_page=100`)
      return JSON.stringify({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            name: 'review',
            status: reviewStatus,
            conclusion,
            app: { id: reviewedApp },
            head_sha: reviewedHead,
            completed_at: completedAt,
          },
        ],
      })
    if (args[0] === 'pr' && args[1] === 'merge') {
      mergeCalls++
      expect(args).toEqual(['pr', 'merge', String(pr), '--repo', repository, '--merge', '--match-head-commit', f.tip])
      git(f.box, f.box.principal, ['merge', '--no-ff', '-qm', 'Merge PR', f.tip])
      const merged = git(f.box, f.box.principal, ['rev-parse', 'HEAD'])
      git(f.box, f.box.principal, ['push', '-q', 'origin', 'main'])
      writeSim(f.box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('Expected PR')
        pull.state = 'MERGED'
        pull.mergeCommit = { oid: merged, parents: [f.base, f.tip] }
      })
      return ''
    }
    if (args[0] === 'api' && args[2] === 'PATCH' && args[3] === `repos/${repository}/issues/42`) {
      closeCalls++
      expect(args.slice(4)).toEqual(['--raw-field', 'state=closed', '--raw-field', 'state_reason=completed'])
      writeSim(f.box, (state) => Object.assign(state.issues['42'] ?? {}, { state: 'CLOSED', stateReason: 'COMPLETED' }))
      return '{}'
    }
    return f.gh(cwd, args)
  }
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip], { gh })).toMatchObject({
    code: 0,
    status: 'merged',
  })
  expect(mergeCalls).toBe(1)
  expect(await invoke(f, 'finish', ['--pr', String(pr)], { gh })).toMatchObject({
    code: 1,
    reason: 'close-linked-completion-unavailable',
  })
  expect(closeCalls).toBe(0)
  reviewedHead = f.tip
  reviewedApp = 42
  const expectRefusal = async () =>
    expect(await invoke(f, 'finish', ['--pr', String(pr)], { gh })).toMatchObject({
      code: 1,
      reason: 'close-linked-completion-unavailable',
    })
  await expectRefusal()
  reviewedApp = app
  reviewStatus = 'in_progress'
  await expectRefusal()
  reviewStatus = 'completed'
  conclusion = 'failure'
  await expectRefusal()
  conclusion = 'success'
  reviewRules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'review' }] } }]
  await expectRefusal()
  expect(closeCalls).toBe(0)
  reviewRules = rules
  completedAt = '2025-12-31T23:59:59Z'
  await expectRefusal()
  expect(closeCalls).toBe(0)
  completedAt = date
  f.bare('update-ref', '-d', ref)
  expect(await invoke(f, 'finish', ['--pr', String(pr)], { gh, cwd: f.box.principal })).toMatchObject({
    code: 0,
    status: 'finished',
    head: f.tip,
  })
  expect(readSim(f.box).issues['42']).toMatchObject({ state: 'CLOSED', stateReason: 'COMPLETED' })
  expect(closeCalls).toBe(1)
})
