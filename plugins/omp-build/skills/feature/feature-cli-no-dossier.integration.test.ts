import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import { featureSpecDigest } from '../../roxabi/feature-spec-digest.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { git, readSim, worktree, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { branch, date, invoke, ref, repository, world } from './feature-cli.fixture.ts'

const app = 17
const rules = [{ context: 'review', integration_id: app }, { context: 'ci' }]
const verdictScript = fileURLToPath(new URL('../../../../scripts/review-verdict.sh', import.meta.url))

type Comment = { id: number; updated_at: string; body: string }

it.each(['approval', 'correction'] as const)('composes delivery after %s without an action dossier', async (flow) => {
  const f = world()
  const gitDir = git(f.box, f.cwd, ['rev-parse', '--absolute-git-dir'])
  const issueComments = readSim(f.box).issues['42']?.comments
  const verdicts = new Map<string, string>()
  const pr = '100'
  const comments = `repos/${repository}/issues/${pr}/comments`
  const gh: Gh = async (cwd, args) => {
    const endpoint = args[1]
    if (args[0] === 'api' && endpoint === `repos/${repository}/rules/branches/main`)
      return JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: rules } }])
    if (args[0] === 'api' && endpoint?.endsWith('/check-runs?check_name=review&per_page=100'))
      return reviewChecks(endpoint)
    if (args[0] === 'pr' && args[1] === 'merge') return merge(args)
    if (args[0] === 'api' && args[2] === 'PATCH' && args[3] === `repos/${repository}/issues/42`) {
      expect(args.slice(4)).toEqual(['--raw-field', 'state=closed', '--raw-field', 'state_reason=completed'])
      writeSim(f.box, (state) => Object.assign(state.issues['42'] ?? {}, { state: 'CLOSED', stateReason: 'COMPLETED' }))
      return '{}'
    }
    return f.gh(cwd, args)
  }
  function reviewChecks(endpoint: string): string {
    const head = endpoint.match(/\/commits\/([0-9a-f]{40})\/check-runs\?check_name=review&per_page=100$/)?.[1]
    if (head === undefined) throw new Error(`Unexpected check endpoint: ${endpoint}`)
    const checkRuns = verdicts.has(head)
      ? [{ id: 7, name: 'review', status: 'completed', conclusion: 'success', app: { id: app }, head_sha: head }]
      : []
    return JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns })
  }
  function merge(args: string[]): string {
    const head = f.bare('rev-parse', ref)
    expect(args).toEqual(['pr', 'merge', pr, '--repo', repository, '--merge', '--match-head-commit', head])
    const ciPassed = readSim(f.box).checks[head]?.some(
      (check) => check.name === 'ci' && check.status === 'completed' && check.conclusion === 'success',
    )
    if (!verdicts.has(head) || !ciPassed) throw new Error('required status check is pending')
    git(f.box, f.box.principal, ['merge', '--no-ff', '-qm', 'Merge PR', head])
    const merged = git(f.box, f.box.principal, ['rev-parse', 'HEAD'])
    git(f.box, f.box.principal, ['push', '-q', 'origin', 'main'])
    writeSim(f.box, (next) => {
      const pull = next.prs[pr]
      if (!pull) throw new Error('Expected a bound PR')
      pull.state = 'MERGED'
      pull.mergeCommit = { oid: merged, parents: [f.base, head] }
    })
    return ''
  }
  const uw = await createInstalledUwOperations({
    cwd: f.cwd,
    gh,
    operator: {
      async executeConfirmed() {
        throw new Error('Composed delivery must not ask for new authority')
      },
    },
  })
  const admitted = await admitFeature({
    cwd: f.cwd,
    reference: `${repository}#42`,
    control: 'select',
    principal: false,
    gh,
    git: f.gitRunner,
    uw,
  })
  expect(admitted, JSON.stringify(admitted)).toMatchObject({
    kind: 'ready',
    mandate: f.mandate.recordId,
    branch,
    base: 'main',
  })
  if (admitted.kind !== 'ready') throw new Error('Expected admitted feature context')
  const digest = featureSpecDigest(admitted.acceptedSpec)

  // Exercise the real push and binding publication without seeding a PR or an action history.
  f.bare('update-ref', '-d', ref)
  expect(await invoke(f, 'push', ['--tip', f.tip], { gh })).toMatchObject({ code: 0, status: 'pushed', head: f.tip })
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { gh })).toMatchObject({ code: 0, status: 'created', pr: 100 })
  const bindingComments = readSim(f.box).prs[pr]?.comments.map(({ body }) => body)
  expect(bindingComments).toHaveLength(1)

  // /dev-review and /dev-fix are session procedures, not executable agents. Supply their
  // documented wire artifacts, passing them through the same PR the CLI actually bound.
  const posted: string[] = []
  async function comment(body: string): Promise<Comment> {
    const value = JSON.parse(await gh(f.cwd, ['api', '--method', 'POST', comments, '-f', `body=${body}`]))
    expect(value).toMatchObject({ id: expect.any(Number), updated_at: expect.any(String), body })
    posted.push(body)
    return value
  }
  async function review(head: string, verdict: 'approve' | 'request changes', content: string): Promise<Comment> {
    const live = JSON.parse(
      await gh(f.cwd, ['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,baseRefName,state']),
    )
    expect(live).toMatchObject({ headRefOid: head, baseRefName: 'main', state: 'OPEN' })
    const detached = worktree(f.box, `review-${head}`, live.headRefOid)
    try {
      expect(git(f.box, detached, ['show', 'HEAD:README.md'])).toBe(content)
      const findings = verdict === 'approve' ? 'No blocking findings.' : 'README.md:1 — blocking: clarify the result.'
      return await comment(`## Review — head ${head} base main spec ${digest}\n\n${findings}\n\nVerdict: ${verdict}`)
    } finally {
      git(f.box, f.box.principal, ['worktree', 'remove', detached])
    }
  }

  let head = f.tip
  if (flow === 'correction') {
    const finding = await review(f.tip, 'request changes', 'work')
    const published: Comment[] = JSON.parse(await gh(f.cwd, ['api', comments]))
    expect(published.at(-1)).toMatchObject({ id: finding.id, updated_at: finding.updated_at, body: finding.body })
    expect(finding.body).toMatch(/Verdict: request changes$/)
    writeFileSync(join(f.cwd, 'README.md'), 'clarified result\n')
    git(f.box, f.cwd, [
      'commit',
      '-qam',
      `fix: clarify the result\n\nReview-Id: ${finding.id}\nReview-Updated-At: ${finding.updated_at}`,
    ])
    head = git(f.box, f.cwd, ['rev-parse', 'HEAD'])
    expect(await invoke(f, 'push', ['--from', f.tip, '--tip', head, '--pr', pr], { gh })).toMatchObject({
      code: 0,
      status: 'pushed',
      head,
      pr: 100,
    })
    expect(f.bare('rev-parse', ref)).toBe(head)
    await comment(`## Fixes — head ${head}\n\nAnswered review ${finding.id}: clarified README.md:1 in ${head}.`)
  }

  const approval = await review(head, 'approve', flow === 'correction' ? 'clarified result' : 'work')
  const evidence = `https://github.com/${repository}/pull/${pr}#issuecomment-${approval.id}`
  const verdict = await comment(`review-verdict v1 head=${head} approve evidence=${evidence}`)
  const verdictFile = join(f.box.root, 'verdict.txt')
  writeFileSync(verdictFile, verdict.body)
  // Model the GitHub App check from the persisted comment using the real verdict parser.
  const reviewed = execFileSync('bash', [verdictScript, 'verdict', verdictFile, 'open', f.bare('rev-parse', ref)], {
    cwd: f.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
  expect(reviewed).toBe(evidence)
  verdicts.set(head, reviewed)
  writeSim(f.box, (state) => {
    state.checks[head] = [
      { name: 'ci', status: 'completed', conclusion: 'success', workflowName: 'ci', startedAt: date },
    ]
  })
  const specInReview = approval.body.split('\n')[0]?.split(' spec ')[1] ?? ''
  expect(await invoke(f, 'land', ['--pr', pr, '--head', head, '--spec', specInReview], { gh })).toMatchObject({
    code: 0,
    status: 'merged',
    head,
  })
  expect(f.bare('rev-parse', 'main^2')).toBe(head)
  expect(readSim(f.box).issues['42']?.state).toBe('OPEN')
  expect(await invoke(f, 'finish', ['--pr', pr], { gh })).toMatchObject({ code: 0, status: 'finished', head })

  const final = readSim(f.box)
  expect(final.issues['42']).toMatchObject({ state: 'CLOSED', stateReason: 'COMPLETED', comments: issueComments })
  expect(final.prs[pr]?.comments.map(({ body }) => body)).toEqual([...(bindingComments ?? []), ...posted])
  expect(existsSync(join(f.cwd, 'artifacts', 'local', 'omp-build', 'actions'))).toBe(false)
  expect(existsSync(join(gitDir, 'omp-build', 'actions'))).toBe(false)
})
