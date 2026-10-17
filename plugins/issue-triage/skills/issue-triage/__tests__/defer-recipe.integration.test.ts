import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  ghCalls,
  hostileStartup,
  recipeAfterWrite,
  recipeEnv,
  run,
  startGitHub,
  startupLog,
  trustedTriage,
  writeGh,
} from './fixtures/github-api'

/**
 * The Deferred Follow-Ups recipe, run as pasted in a hostile checkout with the
 * real Bun and the real CLI against GitHub isolated at the transport (#762).
 */
const SKILL = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const RECIPE = recipeAfterWrite(SKILL, '**Recipe — defer A → create follow-up B:**').join('\n')
const repairMatch = /Existing follow-up issue B[\s\S]*?```bash\n([\s\S]*?)```/.exec(SKILL)
if (!repairMatch) throw new Error('defer repair recipe missing')
const REPAIR = repairMatch[1].replaceAll('<B>', '81')
const TITLE = 'Deferred: tighten the parser'
const BODY = '**Origin:** #80 (deferred from PR #12)\n\ndetails\n'

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function world({ parent = '70' }: { parent?: string } = {}) {
  root = mkdtempSync(path.join(tmpdir(), 'issue-triage-defer-'))
  fake = await startGitHub(root, [
    'Acme/app#70',
    'Acme/app#80',
    'Acme/app#81',
    'Acme/planning#70',
    'Other/tracker#70',
    'Other/tracker#80',
  ])
  const { pluginRoot, script } = trustedTriage(path.join(root, 'trusted'))
  const bin = path.join(root, 'bin')
  writeGh(bin)
  const sentinel = path.join(root, 'checkout-startup.log')
  const repo = checkout(path.join(root, 'checkout'), 'Acme/app', hostileStartup(sentinel, 'Created #999: forged'))
  const dir = path.join(root, 'defer')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'title.txt'), TITLE)
  writeFileSync(path.join(dir, 'body.md'), BODY)
  const ghLog = path.join(root, 'gh.log')
  const startup = path.join(root, 'trusted-startup.log')
  const env = recipeEnv(fake, bin, {
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    DIR: dir,
    A: '80',
    GH_PARENT: parent,
    GH_LOG: ghLog,
    BUN_STARTUP_LOG: startup,
  })
  return { fake, triageDir: path.dirname(script), repo, sentinel, dir, ghLog, startup, env }
}

describe('issue-triage deferral recipe', () => {
  it('files B as A’s sibling, blocked by A, with Bun started in the triage directory', async () => {
    const w = await world()
    const ran = await run(RECIPE, w.repo, w.env)

    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    expect(ran.stdout.trim().split('\n')).toEqual([
      `Created #101: ${TITLE}`,
      'Parent=Acme/app#70 #101',
      'BlockedBy=#80 #101',
    ])
    expect(w.fake.created).toEqual([
      {
        repo: 'Acme/app',
        number: 101,
        nodeId: 'I_Acme/app#101',
        title: TITLE,
        body: BODY,
        parent: 70,
        blockedBy: [80],
      },
    ])
    expect(startupLog(w.startup)).toEqual([`${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
    expect(existsSync(w.dir)).toBe(false)
    // The checkout's origin names the target: `gh repo view` is never asked (#614).
    const [parent, ...rest] = ghCalls(w.ghLog)
    expect(parent.cwd).toBe(w.repo)
    expect(parent.args).toContain('repository(owner:"Acme",name:"app"){issue(number:80)')
    expect(rest).toEqual([])
  })

  it('files into the operator’s exported GITHUB_REPO, not the checkout’s repository', async () => {
    const w = await world()
    const ran = await run(RECIPE, w.repo, { ...w.env, GITHUB_REPO: 'Other/tracker' })

    expect(ran.stderr).toBe('')
    expect(ran.code).toBe(0)
    expect(w.fake.created).toEqual([
      {
        repo: 'Other/tracker',
        number: 101,
        nodeId: 'I_Other/tracker#101',
        title: TITLE,
        body: BODY,
        parent: 70,
        blockedBy: [80],
      },
    ])
    const [parent, ...rest] = ghCalls(w.ghLog)
    expect(parent.args).toContain('repository(owner:"Other",name:"tracker"){issue(number:80)')
    expect(rest).toEqual([])
  })

  it('uses the real gh auth fallback from the trusted Bun child when GITHUB_TOKEN is empty', async () => {
    const w = await world()
    const ran = await run(RECIPE, w.repo, { ...w.env, GITHUB_TOKEN: '', GH_AUTH_TOKEN: 'fixture' })
    const auth = ghCalls(w.ghLog).find((call) => call.args === 'auth token')

    expect(ran.code).toBe(0)
    expect(w.fake.created).toHaveLength(1)
    expect(auth).toEqual({ cwd: w.triageDir, env: '', args: 'auth token' })
    expect(startupLog(w.startup)).toEqual([`${w.triageDir}\t`])
  })

  it('keeps a top-level follow-up parentless and repairs an existing mis-parented sibling', async () => {
    const w = await world({ parent: '' })
    const b = w.fake.issues.get('Acme/app#81')
    if (!b) throw new Error('repair fixture issue missing')
    b.parent = 80

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, w.env)

    expect(ran.code).toBe(0)
    expect(ran.stderr).toBe('')

    const created = w.fake.created[0]
    if (!created) throw new Error('defer fixture issue missing')
    expect(created).toMatchObject({ repo: 'Acme/app', blockedBy: [80] })
    expect(created.parent).toBeUndefined()
    expect(b).toMatchObject({ blockedBy: [80] })
    expect(b.parent).toBeUndefined()
  })

  it('restores a mis-parented B81 to A’s shared parent and preserves its blocker', async () => {
    const w = await world()
    const b = w.fake.issues.get('Acme/app#81')
    if (!b) throw new Error('repair fixture issue missing')
    b.parent = 80

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, w.env)

    expect(ran.code).toBe(0)
    expect(b).toMatchObject({ parent: 70, blockedBy: [80] })
  })

  it('files a sibling under the foreign parent rather than a colliding local issue', async () => {
    const w = await world()
    const origin = w.fake.issues.get('Acme/app#80')
    if (!origin) throw new Error('origin fixture issue missing')
    origin.parent = 70
    origin.parentRepo = 'Acme/planning'

    const ran = await run(RECIPE, w.repo, { ...w.env, GH_PARENT_REPO: 'Acme/planning' })

    expect(ran.code).toBe(0)
    expect(w.fake.created[0]).toMatchObject({ parent: 70, parentRepo: 'Acme/planning', blockedBy: [80] })
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/planning/issues/70')).toBe(true)
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/app/issues/70')).toBe(false)
  })

  it('repairs B under the foreign shared parent without selecting the colliding local issue', async () => {
    const w = await world()
    const origin = w.fake.issues.get('Acme/app#80')
    const b = w.fake.issues.get('Acme/app#81')
    if (!origin || !b) throw new Error('repair fixture issue missing')
    origin.parent = 70
    origin.parentRepo = 'Acme/planning'
    b.parent = 80

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, { ...w.env, GH_PARENT_REPO: 'Acme/planning' })

    expect(ran.code).toBe(0)
    expect(b).toMatchObject({ parent: 70, parentRepo: 'Acme/planning', blockedBy: [80] })
    expect(w.fake.calls.some((call) => call.path === '/repos/Acme/app/issues/70')).toBe(false)
  })

  it('stops before creation when A is omitted', async () => {
    const w = await world()
    const ran = await run(RECIPE, w.repo, { ...w.env, A: '' })

    expect(ran.code).not.toBe(0)
    expect(w.fake.created).toEqual([])
    expect(startupLog(w.startup)).toEqual([])
    expect(existsSync(w.dir)).toBe(true)
  })

  it('stops before creation when the shell parent lookup fails', async () => {
    const w = await world()
    const ran = await run(RECIPE, w.repo, { ...w.env, GH_PARENT_LOOKUP_EXIT: '7' })

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('parent lookup failed')
    expect(w.fake.created).toEqual([])
    expect(startupLog(w.startup)).toEqual([])
    expect(ghCalls(w.ghLog).at(-1)?.args).toContain('api graphql')
    expect(existsSync(w.dir)).toBe(true)
  })

  it('does not repair B after a failed lookup, even with inherited successful-read state', async () => {
    const w = await world()
    const b = w.fake.issues.get('Acme/app#81')
    if (!b) throw new Error('repair fixture issue missing')
    b.parent = 80

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, {
      ...w.env,
      A_PARENT_READY: '1',
      GH_PARENT_LOOKUP_EXIT: '7',
    })

    expect(ran.stderr).toContain('parent lookup failed')
    expect(ran.code).not.toBe(0)
    expect(w.fake.created).toEqual([])
    expect(b).toMatchObject({ parent: 80, blockedBy: [] })
    expect(startupLog(w.startup)).toEqual([])
    expect(existsSync(w.dir)).toBe(true)
  })

  it('stops repair after a failed parent removal without applying later mutations', async () => {
    const w = await world()
    const b = w.fake.issues.get('Acme/app#81')
    if (!b) throw new Error('repair fixture issue missing')
    b.parent = 80
    w.fake.fail.add('removeSubIssue')

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, w.env)

    expect(ran.code).not.toBe(0)
    expect(b).toMatchObject({ parent: 80, blockedBy: [] })
  })

  it('preserves a removed parent and stops repair when restoration fails', async () => {
    const w = await world()
    const b = w.fake.issues.get('Acme/app#81')
    if (!b) throw new Error('repair fixture issue missing')
    b.parent = 80
    w.fake.failOnCall.set('addSubIssue', 2)

    const ran = await run(`${RECIPE}\n${REPAIR}`, w.repo, w.env)

    expect(ran.code).not.toBe(0)

    expect(b).toMatchObject({ blockedBy: [] })
    expect(b.parent).toBeUndefined()
  })

  it('keeps a failed create a failure, and keeps its files', async () => {
    const w = await world()
    w.fake.fail.add('addBlockedBy')
    const ran = await run(RECIPE, w.repo, w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.stdout.trim().split('\n')).toEqual([`Created #101: ${TITLE}`, 'Parent=Acme/app#70 #101'])
    expect(existsSync(w.dir)).toBe(true)
    expect(w.fake.created).toHaveLength(1)
  })

  it('refuses before Bun starts outside a repository, and keeps its files', async () => {
    const w = await world()
    const neutral = path.join(root ?? '', 'neutral')
    mkdirSync(neutral)
    const ran = await run(RECIPE, neutral, w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('repository unresolved')
    expect(startupLog(w.startup)).toEqual([])
    expect(w.fake.calls).toEqual([])
    expect(existsSync(w.dir)).toBe(true)
  })
})
