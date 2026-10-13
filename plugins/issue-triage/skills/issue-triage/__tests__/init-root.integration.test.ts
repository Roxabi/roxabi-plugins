import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('refuses an explicit --root without a value before every write', async () => {
    const w = await world()
    const ran = await run(`bun --no-env-file ${JSON.stringify(w.script)} init --root`, path.dirname(w.script), w.env)

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: --root needs a checkout path')
    expect(existsSync(w.targetContract)).toBe(false)
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
  })

  it('refuses --root followed by another option before every write', async () => {
    const w = await world()
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root --dry-run`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: --root needs a checkout path')
    expect(existsSync(w.targetContract)).toBe(false)
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
  })

  it('follows a contract symlink that resolves inside the selected checkout', async () => {
    const w = await world()
    const internal = path.join(w.target, 'internal-contract.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(internal, w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('contract: write')
    expect(readFileSync(internal, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it.each(['existing', 'missing'])('writes through a trailing-slash internal %s directory ancestor', async (state) => {
    const w = await world()
    const physicalDocs = path.join(w.target, 'physical-docs')
    if (state === 'existing') mkdirSync(physicalDocs)
    symlinkSync('physical-docs/', path.join(w.target, 'docs'), 'dir')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(existsSync(path.join(physicalDocs, 'agents', 'issue-tracker.md'))).toBe(true)
    expect(readFileSync(w.targetContract, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses a dangling contract symlink before every write', async () => {
    const w = await world()
    const outside = path.join(root!, 'outside')
    mkdirSync(outside)
    const external = path.join(outside, 'issue-tracker.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(external, w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink resolves outside the selected checkout')
    expect(existsSync(external)).toBe(false)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses an ancestor directory symlink before every write', async () => {
    const w = await world()
    const outside = path.join(root!, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, path.join(w.target, 'docs'), 'dir')
    const external = path.join(outside, 'agents', 'issue-tracker.md')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink resolves outside the selected checkout')
    expect(existsSync(external)).toBe(false)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
  })

  it('refuses a lexical in-checkout link whose existing prefix is outside', async () => {
    const w = await world()
    const outside = path.join(root!, 'outside')
    mkdirSync(path.join(w.target, 'docs/agents'), { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, path.join(w.target, 'docs/agents/escape'), 'dir')
    symlinkSync(path.join(w.target, 'docs/agents/escape/issue-tracker.md'), w.targetContract)
    const external = path.join(outside, 'issue-tracker.md')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink resolves outside the selected checkout')
    expect(existsSync(external)).toBe(false)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
  })

  it('refuses a final internal symlink chain that ends at an absent external contract', async () => {
    const w = await world()
    const outside = path.join(path.dirname(w.target), 'outside')
    const external = path.join(outside, 'issue-tracker.md')
    const internal = path.join(w.target, 'internal-contract.md')
    mkdirSync(outside)
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(internal, w.targetContract)
    symlinkSync(external, internal)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(existsSync(external)).toBe(false)
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toMatch(/contract.*symlink|symlink.*contract/i)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('writes through a final internal symlink chain to the physical contract target', async () => {
    const w = await world()
    const internal = path.join(w.target, 'internal-contract.md')
    const rendered = path.join(w.target, 'contracts', 'rendered-issue-tracker.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    mkdirSync(path.dirname(rendered), { recursive: true })
    symlinkSync(internal, w.targetContract)
    symlinkSync(rendered, internal)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('contract: write')
    expect(readFileSync(rendered, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('creates a missing internal symlink target with its full intended suffix', async () => {
    const w = await world()
    const intended = path.join(w.target, 'generated', 'contracts', 'issue-tracker.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(intended, w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('contract: write')
    expect(readFileSync(intended, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses a self-referential contract symlink without timing out or mutating GitHub', async () => {
    const w = await world()
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(w.targetContract, w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
      1_000,
    )

    expect(ran.signal).not.toBe('SIGKILL')
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toMatch(/contract.*symlink|symlink.*contract/i)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses mutually referential contract symlinks without timing out or mutating GitHub', async () => {
    const w = await world()
    const first = path.join(w.target, 'first-contract.md')
    const second = path.join(w.target, 'second-contract.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(first, w.targetContract)
    symlinkSync(second, first)
    symlinkSync(first, second)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
      1_000,
    )

    expect(ran.signal).not.toBe('SIGKILL')
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toMatch(/contract.*symlink|symlink.*contract/i)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses an expanding contract symlink path without timing out or mutating GitHub', async () => {
    const w = await world()
    const expanding = path.join(w.target, 'expanding')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync(path.join(expanding, 'issue-tracker.md'), w.targetContract)
    symlinkSync(path.join(expanding, 'expanding'), expanding, 'dir')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
      1_000,
    )

    expect(ran.signal).not.toBe('SIGKILL')
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toMatch(/contract.*symlink|symlink.*contract/i)
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses a trailing-slash symlink target before creating a stripped file', async () => {
    const w = await world()
    const stripped = path.join(path.dirname(w.targetContract), 'generated-contract.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync('generated-contract.md/', w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(existsSync(stripped)).toBe(false)
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink target is not a file')
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('refuses a directory-required dot suffix before creating a stripped file', async () => {
    const w = await world()
    const stripped = path.join(path.dirname(w.targetContract), 'generated-contract.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    symlinkSync('generated-contract.md/.', w.targetContract)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(existsSync(stripped)).toBe(false)
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink target is not a file')
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('reads an internal relative ancestor that returns through the checkout parent', async () => {
    const w = await world()
    const physical = path.join(w.target, 'physical-docs/agents/issue-tracker.md')
    mkdirSync(path.dirname(physical), { recursive: true })
    writeFileSync(physical, contract('target-only'))
    symlinkSync(path.join('..', path.basename(w.target), 'physical-docs'), path.join(w.target, 'docs'), 'dir')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('vocabulary: table')
    expect(readFileSync(w.labels, 'utf8')).toBe('target-only\n')
    expect(readFileSync(physical, 'utf8')).toBe(contract('target-only'))
    expect(readFileSync(w.targetContract, 'utf8')).toBe(contract('target-only'))
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('writes through an internal relative ancestor that returns through the checkout parent', async () => {
    const w = await world()
    const physical = path.join(w.target, 'physical-docs/agents/issue-tracker.md')
    symlinkSync(path.join('..', path.basename(w.target), 'physical-docs'), path.join(w.target, 'docs'), 'dir')
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(ran.code).toBe(0)
    expect(ran.stdout).toContain('contract: write')
    expect(readFileSync(physical, 'utf8')).toContain('Acme/app')
    expect(readFileSync(w.targetContract, 'utf8')).toBe(readFileSync(physical, 'utf8'))
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('preserves a non-UTF-8 symlink target before creating a substituted file', async () => {
    const w = await world()
    const substituted = path.join(w.target, 'generated-\uFFFD.md')
    mkdirSync(path.dirname(w.targetContract), { recursive: true })
    const linked = spawnSync(
      'python3',
      [
        '-c',
        'import os,sys; os.symlink(bytes([int(item) for item in sys.argv[1].split(",")]), sys.argv[2])',
        '255',
        w.targetContract,
      ],
      { encoding: 'utf8' },
    )
    expect(linked.status, linked.stderr).toBe(0)
    const ran = await run(
      `bun --no-env-file ${JSON.stringify(w.script)} init --root ${JSON.stringify(w.target)}`,
      path.dirname(w.script),
      w.env,
    )

    expect(existsSync(substituted)).toBe(false)
    expect(ran.code).not.toBe(0)
    expect(ran.stderr).toContain('init: contract symlink target is not valid text')
    expect(existsSync(w.labels)).toBe(false)
    expect(ghCalls(w.ghLog)).toEqual([])
    expect(fake?.calls ?? []).toEqual([])
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })
})
