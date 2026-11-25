import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent'
import { expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import * as pluginPin from '../../omp/host-plugin-pin.ts'
import ompBuildExtension from '../../omp/index.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { git, readSim, worktree, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'
import { branch, invoke, ref, repository, seedLandingChecks, world } from './feature-cli.fixture.ts'

const app = 17
const verdictScript = fileURLToPath(new URL('../../../../scripts/review-verdict.sh', import.meta.url))

type Comment = { id: number; updated_at: string; body: string }

async function selectFeature(box: Box, cwd: string) {
  type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>
  const commands = new Map<string, Command>()
  const messages: string[] = []
  const terminal: string[] = []
  const exec = vi.fn(async () => {
    throw new Error('Ordinary delivery must not request host-side preparation')
  })
  const procedurePorts = vi.fn(() => {
    throw new Error('Ordinary delivery must not open a framing procedure')
  })
  const host = createExtensionApiStub({
    registerCommand: (name, command) => {
      commands.set(name, command.handler)
    },
    sendUserMessage: async (message) => {
      messages.push(String(message))
    },
    sendMessage: (message) => {
      terminal.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
    exec,
  })
  const artifacts = join(box.root, 'session-artifacts')
  const ctx = {
    cwd,
    hasUI: false,
    agent: { kind: 'main', id: 'Main', depth: 0 },
    sessionManager: {
      getSessionId: () => 'feature-delivery',
      getSessionFile: () => undefined,
      getArtifactsDir: () => artifacts,
      getCwd: () => cwd,
    },
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  } as unknown as ExtensionCommandContext
  const resolvePin = vi.spyOn(pluginPin, 'hostPluginPin')
  try {
    // Exercise the installed native operations against the sandbox, not an injected workflow.
    vi.stubEnv('PATH', box.env.PATH)
    vi.stubEnv('GH_SIM_STATE', box.stateFile)
    vi.stubEnv('HOME', box.env.HOME)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', box.env.GIT_CONFIG_NOSYSTEM)
    ompBuildExtension(host, { framing: { procedurePorts } })
    const feature = commands.get('feature')
    if (!feature) throw new Error('Expected the installed /feature command')
    await feature(`${repository}#42`, ctx)
    expect(resolvePin).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(procedurePorts).not.toHaveBeenCalled()
  } finally {
    resolvePin.mockRestore()
    vi.unstubAllEnvs()
  }
  expect(terminal).toEqual([])
  expect(messages).toHaveLength(1)
  return messages[0]?.split('\n## Feature context\n')[1] ?? ''
}

it.each(['approval', 'correction'] as const)('composes delivery after %s without an action dossier', async (flow) => {
  const f = world()
  const gitDir = git(f.box, f.cwd, ['rev-parse', '--absolute-git-dir'])
  const issueComments = readSim(f.box).issues['42']?.comments
  const context = await selectFeature(f.box, f.cwd)
  expect(context).toContain(
    [
      `repository: ${repository}`,
      'issue: 42',
      `mandate: ${f.mandate.recordId}`,
      `branch: ${branch}`,
      'base: main',
      `worktree: ${f.cwd}`,
      '',
      '## Accepted Spec',
    ].join('\n'),
  )
  const mandate = /^mandate: (.+)$/m.exec(context)?.[1]
  const digest = /^spec: ([a-f0-9]{64})$/m.exec(context)?.[1]
  if (!mandate || !digest) throw new Error('Expected mandate and Accepted Spec digest from /feature')
  const pr = '100'
  const comments = `repos/${repository}/issues/${pr}/comments`
  const gh: Gh = async (cwd, args) => {
    // Bridge the REST endpoints not implemented by the shared GitHub simulator.
    const head = args[1]?.match(/\/commits\/([0-9a-f]{40})\/check-runs\?check_name=review&per_page=100$/)?.[1]
    if (args[0] === 'api' && head !== undefined) {
      const checkRuns = (readSim(f.box).checks[head] ?? [])
        .filter((check) => check.name === 'review')
        .map((check) => ({
          id: 7,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          app: { id: check.appId },
          head_sha: head,
        }))
      return JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns })
    }
    if (args[0] === 'api' && args[2] === 'PATCH' && args[3] === `repos/${repository}/issues/42`) {
      expect(args.slice(4)).toEqual(['--raw-field', 'state=closed', '--raw-field', 'state_reason=completed'])
      writeSim(f.box, (state) => Object.assign(state.issues['42'] ?? {}, { state: 'CLOSED', stateReason: 'COMPLETED' }))
      return '{}'
    }
    return f.gh(cwd, args)
  }
  const delivery = (command: string, args: string[]) => invoke(f, command, args, { gh, mandate })

  // Exercise the real push and binding publication without seeding a PR or an action history.
  f.bare('update-ref', '-d', ref)
  expect(await delivery('push', ['--tip', f.tip])).toMatchObject({ code: 0, status: 'pushed', head: f.tip })
  expect(await delivery('open-pr', ['--tip', f.tip])).toMatchObject({ code: 0, status: 'created', pr: 100 })
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
    expect(await delivery('push', ['--from', f.tip, '--tip', head, '--pr', pr])).toMatchObject({
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
  const published: Comment[] = JSON.parse(await gh(f.cwd, ['api', comments]))
  const persistedVerdict = published.at(-1)
  expect(persistedVerdict).toMatchObject(verdict)
  const persistedApproval = published.find(({ id }) => id === approval.id)
  expect(persistedApproval).toMatchObject(approval)
  if (!persistedVerdict || !persistedApproval) throw new Error('Expected published review and verdict')
  const verdictFile = join(f.box.root, 'verdict.txt')
  writeFileSync(verdictFile, persistedVerdict.body)
  // Model the GitHub App check from the persisted comment using the real verdict parser.
  const reviewed = execFileSync('bash', [verdictScript, 'verdict', verdictFile, 'open', f.bare('rev-parse', ref)], {
    cwd: f.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
  expect(reviewed).toBe(evidence)
  seedLandingChecks(f.box, 'main', head, app)
  const specInReview = persistedApproval.body.split('\n')[0]?.split(' spec ')[1] ?? ''
  const landed = await delivery('land', ['--pr', pr, '--head', head, '--spec', specInReview])
  const mergeCommit = f.bare('rev-parse', 'main')
  expect(landed).toMatchObject({
    code: 0,
    status: 'merged',
    head,
    mergeCommit,
  })
  expect(f.bare('show', '-s', '--format=%P', 'main')).toBe(`${f.base} ${head}`)
  const merged = readSim(f.box)
  expect(merged.prs[pr]).toMatchObject({
    state: 'MERGED',
    baseRefName: 'main',
    headRefOid: head,
    mergeCommit: { oid: mergeCommit, parents: [f.base, head] },
  })
  expect(merged.calls.filter(([command, sub]) => command === 'pr' && sub === 'merge')).toEqual([
    ['pr', 'merge', pr, '--repo', repository, '--merge', '--match-head-commit', head],
  ])
  expect(merged.issues['42']?.state).toBe('OPEN')
  expect(await delivery('finish', ['--pr', pr])).toMatchObject({ code: 0, status: 'finished', head })

  const final = readSim(f.box)
  expect(final.issues['42']).toMatchObject({ state: 'CLOSED', stateReason: 'COMPLETED', comments: issueComments })
  expect(final.prs[pr]?.comments.map(({ body }) => body)).toEqual([...(bindingComments ?? []), ...posted])
  expect(existsSync(join(f.cwd, 'artifacts', 'local', 'omp-build', 'actions'))).toBe(false)
  expect(existsSync(join(gitDir, 'omp-build', 'actions'))).toBe(false)
})
