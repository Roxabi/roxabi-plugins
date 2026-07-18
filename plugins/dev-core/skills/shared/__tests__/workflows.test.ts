import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTION_PINS } from '../workflows/workflow-pins'
import {
  classifyTestRunner,
  generateAutoMergeYml,
  generateCiYml,
  generateContextLintYml,
  generateDeployYml,
  workflowOptsFromStack,
  writeWorkflows,
} from '../workflows/workflows'
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
})

describe('generateCiYml', () => {
  it('generates bun + vitest CI with SHA-pinned setup-bun', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain(ACTION_PINS.setupBun)
    expect(yml).toContain('bun install')
    expect(yml).toContain('bun lint')
    expect(yml).toContain('bun typecheck')
    expect(yml).toContain('run: bun run test')
    expect(yml).not.toContain('trufflehog')
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
  })

  it('targets main and staging branches', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('branches: [main, staging]')
  })
})

describe('generateSecretScanYml', () => {
  it('is standalone with SHA-pinned checkout and trufflehog', () => {
    const yml = generateSecretScanYml()
    expect(yml).toContain('name: Secret Scan')
    expect(yml).toContain(ACTION_PINS.checkout)
    expect(yml).toContain(ACTION_PINS.trufflehog)
    expect(yml).toContain('--only-verified')
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
  it('emits npm + github-actions for bun stack', () => {
    const yml = generateDependabotYml({ stack: 'bun' })
    expect(yml).toContain('package-ecosystem: npm')
    expect(yml).toContain('package-ecosystem: github-actions')
    expect(yml).toContain('default-days: 3')
    expect(yml).not.toContain('semver-major-days')
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
    expect(fs.readFileSync('.github/dependabot.yml', 'utf8')).toContain('package-ecosystem: npm')
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
    expect(yml).toContain("'**/CLAUDE.md'")
    expect(yml).toContain("'.grok/**'")
  })
})
