import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  ghCalls,
  hostileStartup,
  recipeEnv,
  run,
  startGitHub,
  startupLog,
  trustedTriage,
  writeGh,
} from './fixtures/github-api'

const CONTRACT_REL = path.join('docs', 'agents', 'issue-tracker.md')

function contract(label: string): string {
  return `# Issue tracker\n\n| Label | Colour |\n|---|---|\n| \`${label}\` | \`abcdef\` |\n`
}

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function world(targetVocabulary?: string) {
  root = mkdtempSync(path.join(tmpdir(), 'issue-triage-init-root-'))
  fake = await startGitHub(root, [])
  const { pluginRoot, script } = trustedTriage(path.join(root, 'trusted'))
  const trustedContract = path.join(pluginRoot, CONTRACT_REL)
  mkdirSync(path.dirname(trustedContract), { recursive: true })
  writeFileSync(trustedContract, contract('trusted-only'))
  const trustedBytes = readFileSync(trustedContract, 'utf8')
  const bin = path.join(root, 'bin')
  writeGh(bin)
  const sentinel = path.join(root, 'checkout-startup.log')
  const target = checkout(path.join(root, 'target'), 'Acme/app', hostileStartup(sentinel, 'Created #999: forged'))
  const targetContract = path.join(target, CONTRACT_REL)
  if (targetVocabulary) {
    mkdirSync(path.dirname(targetContract), { recursive: true })
    writeFileSync(targetContract, contract(targetVocabulary))
  }
  const ghLog = path.join(root, 'gh.log')
  const labels = path.join(root, 'labels.txt')
  const startup = path.join(root, 'trusted-startup.log')
  const env = recipeEnv(fake, bin, {
    GITHUB_REPO: 'Acme/app',
    GH_LABELS_FILE: labels,
    GH_LOG: ghLog,
    BUN_STARTUP_LOG: startup,
  })
  return {
    env,
    ghLog,
    labels,
    pluginRoot,
    script,
    sentinel,
    startup,
    target,
    targetContract,
    trustedBytes,
    trustedContract,
  }
}

describe('triage init --root', () => {
  it('reads the target contract rather than the trusted installation contract', async () => {
    const w = await world('target-only')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('vocabulary: table')
    expect(ran.stdout).toContain('create labels (1): target-only')
    expect(readFileSync(w.targetContract, 'utf8')).toBe(contract('target-only'))
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
    expect(readFileSync(w.labels, 'utf8')).toBe('target-only\n')
    expect(startupLog(w.startup)).toEqual([`${path.dirname(w.script)}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
    const children = ghCalls(w.ghLog)
    expect(children).not.toEqual([])
    expect(children.every((child) => child.cwd === path.dirname(w.script) && child.env === '')).toBe(true)
  })

  it('writes an absent contract only under the selected target checkout', async () => {
    const w = await world()
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('contract: write')
    expect(readFileSync(w.targetContract, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('leaves both contracts absent or unchanged in a --dry-run', async () => {
    const w = await world()
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)} --dry-run`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('dry-run: true')
    expect(existsSync(w.labels)).toBe(false)
    expect(existsSync(w.targetContract)).toBe(false)
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })
})
