import { describe, expect, it } from 'vitest'
import { generateAutoMergeYml, generateCiYml, generateContextLintYml, generateDeployYml } from '../lib/workflows'

describe('generateAutoMergeYml', () => {
  it('emits the App token mint step (no secrets.PAT)', () => {
    const yml = generateAutoMergeYml()
    expect(yml).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1')
    expect(yml).toContain('vars.ROXABI_CI_APP_ID')
    expect(yml).toContain('secrets.ROXABI_CI_APP_PRIVATE_KEY')
    expect(yml).not.toContain('secrets.PAT')
  })

  it('uses steps.app.outputs.token (not PAT) for all GH_TOKEN references', () => {
    const yml = generateAutoMergeYml()
    // Every GH_TOKEN assignment must reference the App token
    const ghTokenMatches = [...yml.matchAll(/GH_TOKEN:\s*\$\{\{[^}]+\}\}/g)].map((m) => m[0])
    expect(ghTokenMatches.length).toBeGreaterThan(0)
    for (const match of ghTokenMatches) {
      expect(match).toContain('steps.app.outputs.token')
    }
  })

  it('emits the lazy-sync update-branch step gated by reviewed in the auto-merge job', () => {
    const yml = generateAutoMergeYml()
    // Narrow to the lazy-sync step block only (from step name to next step name)
    const lazySyncMatch = yml.match(/- name: Update branch \(lazy sync for late joiners\)[\s\S]*?(?=\n {6}- name:)/)
    expect(lazySyncMatch).not.toBeNull()
    const lazySyncStep = lazySyncMatch?.[0]
    // The if: guard must appear INSIDE the step block itself (not just at job level)
    expect(lazySyncStep).toContain("if: contains(github.event.pull_request.labels.*.name, 'reviewed')")
    expect(lazySyncStep).toContain('update-branch')
    // The step uses the app token
    expect(lazySyncStep).toContain('steps.app.outputs.token')
    expect(lazySyncStep).toContain('|| true')
  })

  it('lazy-sync step appears BEFORE enable auto-merge step', () => {
    const yml = generateAutoMergeYml()
    const lazyIdx = yml.indexOf('Update branch (lazy sync for late joiners)')
    const mergeIdx = yml.indexOf('Enable auto-merge (merge commit)')
    expect(lazyIdx).toBeGreaterThan(-1)
    expect(mergeIdx).toBeGreaterThan(-1)
    expect(lazyIdx).toBeLessThan(mergeIdx)
  })

  it('update-behind-prs job still filters reviewed label (regression guard)', () => {
    const yml = generateAutoMergeYml()
    const updateBehindSection = yml.split('update-behind-prs:')[1]
    expect(updateBehindSection).toContain('--label reviewed')
  })

  it('update-behind-prs job runs only on push (regression guard)', () => {
    const yml = generateAutoMergeYml()
    const updateBehindSection = yml.split('update-behind-prs:')[1]
    expect(updateBehindSection).toContain("github.event_name == 'push'")
  })

  it('update-behind-prs job includes the App token mint step', () => {
    const yml = generateAutoMergeYml()
    const updateBehindSection = yml.split('update-behind-prs:')[1]
    expect(updateBehindSection).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1')
    expect(updateBehindSection).toContain('vars.ROXABI_CI_APP_ID')
    expect(updateBehindSection).toContain('secrets.ROXABI_CI_APP_PRIVATE_KEY')
  })
})

describe('generateCiYml', () => {
  it('generates bun + vitest CI (bun run test, not bun test)', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('oven-sh/setup-bun@v2')
    expect(yml).toContain('bun install')
    expect(yml).toContain('bun lint')
    expect(yml).toContain('bun typecheck')
    expect(yml).toContain('run: bun run test')
  })

  it('uses the native bun runner for non-vitest bun stacks', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'jest', deploy: 'none' })
    expect(yml).toContain('run: bun test')
  })

  it('generates node + jest CI', () => {
    const yml = generateCiYml({ stack: 'node', test: 'jest', deploy: 'none' })
    expect(yml).toContain('actions/setup-node@v4')
    expect(yml).toContain('npm ci')
    expect(yml).toContain('npm run lint')
    expect(yml).toContain('npx tsc --noEmit')
    expect(yml).toContain('npm test')
  })

  it('omits test step when test is "none"', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).not.toContain('Test')
    expect(yml).not.toContain('bun test')
  })

  it('targets main and staging branches', () => {
    const yml = generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' })
    expect(yml).toContain('branches: [main, staging]')
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

  it('uses node setup when stack is node', () => {
    const yml = generateDeployYml({ stack: 'node', test: 'none', deploy: 'vercel' })
    expect(yml).toContain('actions/setup-node@v4')
    expect(yml).toContain('npm ci')
  })

  it('has workflow_dispatch trigger', () => {
    const yml = generateDeployYml({ stack: 'bun', test: 'none', deploy: 'none' })
    expect(yml).toContain('workflow_dispatch')
  })
})

describe('generateContextLintYml', () => {
  it('is read-only and uses no secrets', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('permissions:\n  contents: read')
    expect(yml).not.toContain('secrets.')
  })

  it('skips machine-local home-dir imports', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('"~/"*')
  })

  it('fails the job on violations', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('exit 1')
  })

  it('triggers only on agent-context file paths', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain("'**/CLAUDE.md'")
    expect(yml).toContain("'**/AGENTS.md'")
    expect(yml).toContain("'.claude/**'")
  })

  it('emits interpolated bash (no unresolved TS template escapes)', () => {
    const yml = generateContextLintYml()
    expect(yml).toContain('target=${imp#@}')
    expect(yml).not.toContain('\\$')
  })
})
