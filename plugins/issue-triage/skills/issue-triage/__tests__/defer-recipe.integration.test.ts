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

async function world() {
  root = mkdtempSync(path.join(tmpdir(), 'issue-triage-defer-'))
  fake = await startGitHub(root, ['Acme/app#70', 'Acme/app#80'])
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
    GH_PARENT: '70',
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
    expect(ran.stdout.trim().split('\n')).toEqual([`Created #101: ${TITLE}`, 'Parent=#70 #101', 'BlockedBy=#80 #101'])
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
    const [resolve, parent, ...rest] = ghCalls(w.ghLog)
    expect(resolve).toEqual({ cwd: w.repo, env: '', args: 'repo view --json nameWithOwner --jq .nameWithOwner' })
    expect(parent.cwd).toBe(w.repo)
    expect(parent.args).toContain('repository(owner:"Acme",name:"app"){issue(number:80)')
    expect(rest).toEqual([])
  })

  it('keeps a failed create a failure, and keeps its files', async () => {
    const w = await world()
    w.fake.fail.add('addBlockedBy')
    const ran = await run(RECIPE, w.repo, w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.stdout.trim().split('\n')).toEqual([`Created #101: ${TITLE}`, 'Parent=#70 #101'])
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
