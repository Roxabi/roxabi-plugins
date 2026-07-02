import { describe, expect, it } from 'vitest'
import { ACTION_PINS } from '../lib/workflow-pins'
import { generateAutoMergeYml, generateCiYml, generateContextLintYml, generateDeployYml } from '../lib/workflows'
import { generateDependabotAutomergeYml, generateMergeOnGreenYml, generateSecretScanYml } from '../lib/workflows-fleet'

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

  it('uses the native bun runner for non-vitest bun stacks', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'jest', deploy: 'none' })
    expect(yml).toContain('run: bun test')
  })

  it('generates node + jest CI with SHA-pinned setup-node', () => {
    const yml = generateCiYml({ stack: 'node', test: 'jest', deploy: 'none' })
    expect(yml).toContain(ACTION_PINS.setupNode)
    expect(yml).toContain('npm ci')
    expect(yml).toContain('npm run lint')
    expect(yml).toContain('npx tsc --noEmit')
    expect(yml).toContain('npm test')
  })

  it('omits test step when test is "none"', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).not.toContain('bun test')
    expect(yml).not.toMatch(/- name: Test/)
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
