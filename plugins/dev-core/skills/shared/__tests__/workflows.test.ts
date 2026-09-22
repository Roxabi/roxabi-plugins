import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyTestRunner,
  generateAutoMergeYml,
  generateCiYml,
  generateContextLintYml,
  generateDeployYml,
  generatePrTitleYml,
  workflowOptsFromStack,
} from '../workflows/workflow-generators'
import { ACTION_PINS } from '../workflows/workflow-pins'
import { writeWorkflows } from '../workflows/workflow-push'
import { normalizeWorkflowOpts, resolveRelease, triggerBranches } from '../workflows/workflow-types'
import {
  generateDependabotAutomergeYml,
  generateDependabotYml,
  generateMergeOnGreenYml,
  generateSecretScanYml,
} from '../workflows/workflows-fleet'

describe('generateAutoMergeYml', () => {
  it('emits the App token mint step (no secrets.PAT)', () => {
    const yml = generateAutoMergeYml()
    expect(yml).toContain(ACTION_PINS.createAppToken)
    expect(yml).toContain('vars.ROXABI_CI_APP_ID')
    expect(yml).toContain('secrets.ROXABI_CI_APP_PRIVATE_KEY')
    expect(yml).not.toContain('secrets.PAT')
  })

  it('uses steps.app.outputs.token (not PAT) for all GH_TOKEN references', () => {
    const yml = generateAutoMergeYml()
    const ghTokenMatches = [...yml.matchAll(/GH_TOKEN:\s*\$\{\{[^}]+\}\}/g)].map((m) => m[0])
    expect(ghTokenMatches.length).toBeGreaterThan(0)
    for (const match of ghTokenMatches) {
      expect(match).toContain('steps.app.outputs.token')
    }
  })

  it('emits SHA-pinned github-script for close-linked-issues', () => {
    const yml = generateAutoMergeYml()
    expect(yml).toContain(ACTION_PINS.githubScript)
    expect(yml).not.toContain('actions/github-script@v8')
  })

  it('blocks semver-major via fetch-metadata, not the dead title regex', () => {
    const yml = generateAutoMergeYml()
    // The title regex never fired on grouped PRs (no versions in the title) and
    // could misread SHA-pinned action bumps — #342 replaced it with metadata.
    expect(yml).not.toContain('BASH_REMATCH')
    expect(yml).not.toContain('PR_TITLE')
    expect(yml).toContain(ACTION_PINS.dependabotFetchMetadata)

    // Derive the reference from the declared id — a rename of `id:` that forgets
    // to update the block's `if:` must fail this, not just an equality check.
    const fetchIdMatch = yml.match(/- name: Fetch dependabot metadata\s*\n\s*id: (\S+)/)
    if (!fetchIdMatch) throw new Error('Fetch dependabot metadata step id not found')
    const fetchId = fetchIdMatch[1]

    const blockStart = yml.indexOf('- name: Block dependabot semver-major')
    expect(blockStart).toBeGreaterThan(-1)
    const nextStepOffset = yml.slice(blockStart + 1).search(/\n\s*- name: /)
    const blockRegion =
      nextStepOffset === -1 ? yml.slice(blockStart) : yml.slice(blockStart, blockStart + 1 + nextStepOffset)

    expect(blockRegion).toContain(`steps.${fetchId}.outputs.update-type == 'version-update:semver-major'`)
    // Scoped to the Block step only — the whole YAML also has a legitimate
    // `exit 0` elsewhere (update-behind-prs' empty-PR-list check).
    expect(blockRegion).toContain('exit 1')
  })
  it('documents native auto-merge, not a merge queue', () => {
    const yml = generateAutoMergeYml()
    expect(yml).toContain('native auto-merge')
    expect(yml).toContain('gh pr merge --auto --merge')
    expect(yml).not.toContain('merge queue')
  })
})

const trunkOpts = {
  stack: 'bun' as const,
  test: 'vitest' as const,
  deploy: 'none' as const,
  release: { model: 'trunk' as const, component: 'x' },
}

describe('triggerBranches', () => {
  it('defaults to staging-train', () => {
    expect(triggerBranches()).toBe('[main, staging]')
    expect(triggerBranches({ release: { model: 'staging-train', component: 'x' } })).toBe('[main, staging]')
  })

  it('emits [main] for trunk', () => {
    expect(triggerBranches({ release: { model: 'trunk', component: 'x' } })).toBe('[main]')
  })

  it('interpolates into every trigger workflow', () => {
    const staging = [
      generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' }),
      generatePrTitleYml(),
      generateContextLintYml(),
      generateSecretScanYml(),
      generateAutoMergeYml(),
    ]
    for (const yml of staging) {
      expect(yml).toContain('branches: [main, staging]')
    }
    const trunk = [
      generateCiYml(trunkOpts),
      generatePrTitleYml(trunkOpts),
      generateContextLintYml(trunkOpts),
      generateSecretScanYml(trunkOpts),
      generateAutoMergeYml(trunkOpts),
    ]
    for (const yml of trunk) {
      expect(yml).toContain('branches: [main]\n')
      expect(yml).not.toContain('branches: [main, staging]')
      expect(yml).not.toContain('branches: [staging, main]')
    }
  })
})

describe('resolveRelease', () => {
  it('defaults to staging-train', () => {
    expect(resolveRelease()).toEqual({ model: 'staging-train', component: '' })
    expect(resolveRelease({ model: '' }, null)).toEqual({ model: 'staging-train', component: '' })
  })

  it('takes trunk from stack when no flag', () => {
    expect(resolveRelease(undefined, { model: 'trunk', component: 'x' })).toEqual({
      model: 'trunk',
      component: 'x',
    })
  })

  it('lets the flag override stack', () => {
    expect(resolveRelease({ model: 'staging-train' }, { model: 'trunk', component: 'x' })).toEqual({
      model: 'staging-train',
      component: 'x',
    })
    expect(resolveRelease({ model: 'trunk', component: 'y' }, { model: 'staging-train', component: 'x' })).toEqual({
      model: 'trunk',
      component: 'y',
    })
  })
})

describe('generateCiYml', () => {
  it('generates bun + vitest CI with SHA-pinned setup-bun', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain(ACTION_PINS.setupBun)
    expect(yml).toContain('bun install --frozen-lockfile')
    expect(yml).toContain('bun lint')
    expect(yml).toContain('bun typecheck')
    expect(yml).toContain('run: bun run test')
    expect(yml).not.toContain('trufflehog')
  })

  it('never lets a generated workflow install with a floating lockfile', () => {
    // A bare `bun install` re-resolves whenever bun.lock disagrees with
    // package.json, so two runs of the same commit can pick different tool
    // versions and disagree on lint (#518). Its siblings are already pinned:
    // python uses `uv sync --frozen`, node uses `npm ci`.
    //
    // Every generated install site is covered: the ci job, the e2e job
    // (generateE2eJob) and the deploy job. Pinning only one of the three
    // leaves the others floating.
    const emitted = [
      generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none', e2e: 'playwright' }),
      generateCiYml({ stack: 'node', test: 'none', deploy: 'none' }),
      generateCiYml({ stack: 'python', test: 'none', deploy: 'none' }),
      generateDeployYml({ stack: 'bun', test: 'vitest', deploy: 'vercel' }),
    ]
    let installs = 0
    for (const yml of emitted) {
      installs += (yml.match(/bun install/g) ?? []).length
      expect(yml).not.toMatch(/bun install(?! --frozen-lockfile)/)
      // --frozen-lockfile forbids CHANGES to the lockfile; with no lockfile at
      // all it installs a fresh floating resolution and still exits 0. So each
      // install must be preceded by a presence gate or the pin is a no-op.
      expect((yml.match(/bun install/g) ?? []).length).toBe(
        (yml.match(/git ls-files --error-unmatch bun\.lock/g) ?? []).length,
      )
    }
    // Guards the guard: if the generators stop emitting bun installs the
    // assertions above would all pass vacuously.
    expect(installs).toBe(3)
  })

  it('omits lint/typecheck when disabled', () => {
    const yml = generateCiYml({
      stack: 'bun',
      test: 'none',
      deploy: 'none',
      lint: false,
      typecheck: false,
    })
    expect(yml).not.toContain('bun lint')
    expect(yml).not.toContain('bun typecheck')
  })

  it('uses bun run test for bun/jest stacks (package-script convention)', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'jest', deploy: 'none' })
    expect(yml).toContain('run: bun run test')
  })

  it('emits bun runner via --test bun as bun run test by default', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'bun', deploy: 'none' })
    expect(yml).toContain('run: bun run test')
  })

  it('emits verbatim testCommand when set', () => {
    const yml = generateCiYml({
      stack: 'bun',
      test: 'bun',
      testCommand: 'bun test packages/shared',
      deploy: 'none',
    })
    expect(yml).toContain('run: bun test packages/shared')
  })

  it('generates node + jest CI with SHA-pinned setup-node', () => {
    const yml = generateCiYml({ stack: 'node', test: 'jest', deploy: 'none' })
    expect(yml).toContain(ACTION_PINS.setupNode)
    expect(yml).toContain('npm ci')
    expect(yml).toContain('npm run lint')
    expect(yml).toContain('npx tsc --noEmit')
    expect(yml).toContain('npm test')
  })

  it('omits test step and comments when test is "none"', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).not.toMatch(/- name: Test/)
    expect(yml).toContain('test: none — no unit test step')
  })
  it('includes optional e2e job when e2e is playwright', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none', e2e: 'playwright' })
    expect(yml).toContain('e2e:')
    expect(yml).toContain('bun run test:e2e')
    expect(yml).toContain("github.event_name != 'pull_request' || !github.event.pull_request.draft")
    expect(yml).not.toContain('classify')
  })

  it('targets main and staging branches', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('branches: [main, staging]')
  })

  it('skips full CI on draft PRs and re-triggers on ready_for_review', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('types: [opened, synchronize, reopened, ready_for_review]')
    expect(yml).toContain("github.event_name != 'pull_request' || !github.event.pull_request.draft")
    expect(yml).toContain('merge_group: {}')
    expect(yml).not.toContain('  classify:')
    expect(yml).not.toContain('needs: [classify]')
    expect(yml).not.toContain('naked')
  })

  it('scopes the default token to contents/checks/pull-requests read', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('permissions:\n  contents: read\n  checks: read\n  pull-requests: read\n')
  })
})

describe('generateSecretScanYml', () => {
  it('is standalone with SHA-pinned checkout and trufflehog', () => {
    const yml = generateSecretScanYml()
    expect(yml).toContain('name: Secret Scan')
    expect(yml).toContain(ACTION_PINS.checkout)
    expect(yml).toContain(ACTION_PINS.trufflehog)
    expect(yml).toContain('--only-verified')
    expect(yml).toContain('trufflehog-exclude-paths.txt')
    expect(yml).not.toContain('  classify:')
    expect(yml).not.toContain('naked')
    // Must pin exclude on the action extra_args line (not only the build step)
    expect(yml).toContain('extra_args: --only-verified --exclude-paths=trufflehog-exclude.txt')
    // Job id = protection context; no job.name override with different casing
    expect(yml).toMatch(/# Job id is the GitHub check name/)
    expect(yml).not.toMatch(/trufflehog:\n\s+name:\s+TruffleHog/)
    // Diff-scoped CI (secondary); local trufflehog-check.sh is primary
    expect(yml).toContain('base:')
    expect(yml).toContain('head:')
    expect(yml).toContain('path: ./')
  })

  it('declares PR types including ready_for_review and least-privilege permissions', () => {
    const yml = generateSecretScanYml()
    expect(yml).toContain('types: [opened, synchronize, reopened, ready_for_review]')
    expect(yml).toContain('permissions:\n  contents: read\n  checks: read\n  pull-requests: read\n')
  })
})

describe('generateMergeOnGreenYml', () => {
  it('wakes on CI and Secret Scan workflow names', () => {
    const yml = generateMergeOnGreenYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).toContain('name: Merge on Green')
    expect(yml).toContain('- CI')
    expect(yml).toContain('- Secret Scan')
    expect(yml).toContain(ACTION_PINS.githubScript)
  })
})

describe('generateDependabotAutomergeYml', () => {
  it('labels dependabot patch/minor PRs reviewed', () => {
    const yml = generateDependabotAutomergeYml()
    expect(yml).toContain('dependabot[bot]')
    expect(yml).toContain('semver-patch')
    expect(yml).toContain(ACTION_PINS.createAppToken)
    expect(yml).toContain(ACTION_PINS.dependabotFetchMetadata)
    expect(yml).not.toContain('21025c705c08')
  })
})

describe('generateDependabotYml', () => {
  it('emits the bun ecosystem for a bun stack, never npm', () => {
    const yml = generateDependabotYml({ stack: 'bun' })
    expect(yml).toContain('package-ecosystem: bun')
    // npm would read package-lock.json and leave bun.lock stale (#518).
    expect(yml).not.toContain('package-ecosystem: npm')
    expect(yml).toContain('package-ecosystem: github-actions')
    expect(yml).toContain('default-days: 3')
    expect(yml).not.toContain('semver-major-days')
  })

  it('emits npm for a node stack', () => {
    const yml = generateDependabotYml({ stack: 'node' })
    expect(yml).toContain('package-ecosystem: npm')
    expect(yml).not.toContain('package-ecosystem: bun')
  })

  it('emits pip ecosystem for python stack', () => {
    const yml = generateDependabotYml({ stack: 'python' })
    expect(yml).toContain('package-ecosystem: pip')
    expect(yml).toContain('package-ecosystem: github-actions')
  })
})

describe('classifyTestRunner / workflowOptsFromStack', () => {
  it('maps bun run test (canonical vitest-on-bun) to vitest, not none', () => {
    expect(classifyTestRunner(undefined, 'bun run test')).toBe('vitest')
    const opts = workflowOptsFromStack({
      runtime: 'bun',
      commands: { test: 'bun run test' },
    })
    expect(opts.test).toBe('vitest')
    expect(opts.testCommand).toBe('bun run test')
  })

  it('maps testing.unit bun + bare bun test to bun', () => {
    expect(classifyTestRunner('bun', 'bun test')).toBe('bun')
  })

  it('prefers testing.unit vitest over command text', () => {
    expect(classifyTestRunner('vitest', 'bun run test')).toBe('vitest')
  })

  it('emits CI test step from stack with only commands.test', () => {
    const opts = workflowOptsFromStack({
      runtime: 'bun',
      commands: { test: 'bun run test', lint: 'bun lint' },
    })
    const yml = generateCiYml(opts)
    expect(yml).toContain('run: bun run test')
    expect(yml).toMatch(/- name: Test/)
  })
})

describe('normalizeWorkflowOpts — release (Model B / #371)', () => {
  it('defaults release to staging-train with empty component when absent', () => {
    const norm = normalizeWorkflowOpts({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(norm.release).toEqual({ model: 'staging-train', component: '' })
  })

  it('passes an explicit trunk release through unchanged', () => {
    const norm = normalizeWorkflowOpts({
      stack: 'bun',
      test: 'vitest',
      deploy: 'none',
      release: { model: 'trunk', component: 'roxabi-plugins' },
    })
    expect(norm.release).toEqual({ model: 'trunk', component: 'roxabi-plugins' })
  })

  it('workflowOptsFromStack threads a trunk release through to WorkflowOpts.release', () => {
    const opts = workflowOptsFromStack({
      runtime: 'bun',
      commands: { test: 'bun run test' },
      release: { model: 'trunk', component: 'roxabi-plugins' },
    })
    expect(opts.release).toEqual({ model: 'trunk', component: 'roxabi-plugins' })
  })

  it('workflowOptsFromStack defaults to staging-train when no release is given', () => {
    const opts = workflowOptsFromStack({ runtime: 'bun', commands: { test: 'bun run test' } })
    expect(opts.release).toEqual({ model: 'staging-train', component: '' })
  })

  it('workflowOptsFromStack coerces an unknown model to staging-train', () => {
    const opts = workflowOptsFromStack({
      runtime: 'bun',
      commands: { test: 'bun run test' },
      release: { model: 'weird', component: 'x' },
    })
    expect(opts.release).toEqual({ model: 'staging-train', component: 'x' })
  })
})

describe('generateDeployYml', () => {
  it('generates Vercel deploy workflow', () => {
    const yml = generateDeployYml({ stack: 'bun', test: 'none', deploy: 'vercel' })
    expect(yml).toContain('Deploy to Vercel')
    expect(yml).toContain('VERCEL_TOKEN')
    expect(yml).toContain('VERCEL_PROJECT_ID')
  })

  it('generates placeholder when deploy is "none"', () => {
    const yml = generateDeployYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).toContain('No deploy target configured')
  })

  it('uses SHA-pinned node setup when stack is node', () => {
    const yml = generateDeployYml({ stack: 'node', test: 'none', deploy: 'vercel' })
    expect(yml).toContain(ACTION_PINS.setupNode)
    expect(yml).toContain('npm ci')
  })

  it('has workflow_dispatch trigger', () => {
    const yml = generateDeployYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).toContain('workflow_dispatch')
  })
})

describe('writeWorkflows', () => {
  // writeWorkflows writes under the cwd — every case runs in a throwaway dir so the
  // repo's own .github/ can never be touched.
  const opts = { stack: 'bun', test: 'vitest', deploy: 'none' } as const
  let tmp: string
  let origCwd: string

  beforeEach(() => {
    origCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'write-workflows-'))
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(origCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('does not clobber existing files by default (top-up)', async () => {
    fs.mkdirSync('.github/workflows', { recursive: true })
    fs.writeFileSync('.github/workflows/ci.yml', 'sentinel-ci')
    fs.writeFileSync('.github/dependabot.yml', 'sentinel-dependabot')

    const results = await writeWorkflows(opts)

    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toBe('sentinel-ci')
    expect(fs.readFileSync('.github/dependabot.yml', 'utf8')).toBe('sentinel-dependabot')
    expect(results).toContainEqual({ file: 'ci.yml', status: 'skipped' })
    expect(results).toContainEqual({ file: 'dependabot.yml', status: 'skipped' })
    // absent files are still topped up
    expect(results).toContainEqual({ file: 'auto-merge.yml', status: 'created' })
    expect(fs.readFileSync('.github/workflows/auto-merge.yml', 'utf8')).toContain('name: Auto Merge')
  })

  it('overwrites existing files with force', async () => {
    fs.mkdirSync('.github/workflows', { recursive: true })
    fs.writeFileSync('.github/workflows/ci.yml', 'sentinel-ci')
    fs.writeFileSync('.github/dependabot.yml', 'sentinel-dependabot')

    const results = await writeWorkflows(opts, true)

    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toContain('name: CI')
    expect(fs.readFileSync('.github/dependabot.yml', 'utf8')).toContain('package-ecosystem: bun')
    expect(results).toContainEqual({ file: 'ci.yml', status: 'updated' })
    expect(results).toContainEqual({ file: 'dependabot.yml', status: 'updated' })
  })

  it('reports dependabot.yml alongside the workflows it writes', async () => {
    const results = await writeWorkflows(opts)

    expect(results).toContainEqual({ file: 'dependabot.yml', status: 'created' })
    expect(fs.existsSync('.github/dependabot.yml')).toBe(true)
    // every file touched on disk appears in the report — no silent writes
    const reported = results.map((r) => r.file).sort()
    const onDisk = [...fs.readdirSync('.github/workflows'), 'dependabot.yml'].sort()
    expect(reported).toEqual(onDisk)
  })

  it('reports the deploy workflow for a cloudflare stack', async () => {
    const results = await writeWorkflows({ stack: 'bun', test: 'vitest', deploy: 'cloudflare' })

    expect(results).toContainEqual({ file: 'deploy-cloudflare.yml', status: 'created' })
  })

  it('writes [main] into context-lint.yml under trunk', async () => {
    await writeWorkflows({ ...opts, release: { model: 'trunk', component: 'x' } })
    const yml = fs.readFileSync('.github/workflows/context-lint.yml', 'utf8')
    expect(yml).toContain('branches: [main]\n')
    expect(yml).not.toContain('branches: [main, staging]')
  })

  it('emits NO release workflow under either model — a release is a pushed tag, not a merge (ADR-021)', async () => {
    const staging = await writeWorkflows(opts)
    expect(staging.map((r) => r.file)).not.toContain('auto-release.yml')

    fs.rmSync('.github', { recursive: true, force: true })
    const trunk = await writeWorkflows({ ...opts, release: { model: 'trunk', component: 'roxabi-plugins' } })
    expect(trunk.map((r) => r.file)).not.toContain('auto-release.yml')
    expect(fs.readdirSync('.github/workflows').filter((f) => /release/.test(f))).toEqual([])
  })
})

describe('generateContextLintYml', () => {
  it('is read-only and uses SHA-pinned checkout', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('permissions:\n  contents: read')
    expect(yml).toContain(ACTION_PINS.checkout)
    expect(yml).not.toContain('secrets.')
  })

  it('triggers only on agent-context file paths', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain("'**/AGENTS.md'")
    expect(yml).toContain("'.grok/**'")
    expect(yml).toContain("github.event_name != 'pull_request' || !github.event.pull_request.draft")
    expect(yml).not.toContain('classify')
  })

  it('lints the scaffold placeholder in the file scaffold-rules writes (AGENTS.md)', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain("grep -rl 'Add project-specific gotchas here' --include=AGENTS.md")
    expect(yml).not.toContain('CLAUDE.md')
  })

  it('declares PR types including ready_for_review and least-privilege permissions', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('types: [opened, synchronize, reopened, ready_for_review]')
    expect(yml).toContain('permissions:\n  contents: read\n  checks: read\n  pull-requests: read\n')
  })
})
