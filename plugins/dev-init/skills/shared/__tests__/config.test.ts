import { describe, expect, it, vi } from 'vitest'
import { registerGitHubRepoDetectionSuite } from '../../../../shared/__tests__/detect-github-repo.suite'

// Mock fs to block only .claude/dev-core.yml, pass through everything else.
// vi.spyOn doesn't work on ESM namespace objects (non-configurable exports).
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (path === '.claude/dev-core.yml') {
        throw new Error('ENOENT')
      }
      return actual.readFileSync(path, encoding ?? 'utf-8')
    },
  }
})

// Mock child_process.execSync to prevent gh CLI fallback in detectGitHubRepo
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execSync: (...args: Parameters<typeof actual.execSync>) => {
      const cmd = String(args[0])
      if (cmd.includes('gh repo view') || cmd.includes('gh api graphql')) {
        throw new Error('gh not available')
      }
      return actual.execSync(...args)
    },
  }
})

// Must be set before config module loads (detectGitHubRepo runs eagerly at import)
process.env.GITHUB_REPO = 'Test/test-repo'

const {
  BLOCK_ORDER,
  detectGitHubRepo,
  PRIORITY_ALIASES,
  PRIORITY_ORDER,
  resolvePriority,
  resolveSize,
  resolveStatus,
  STATUS_ALIASES,
} = await import('../adapters/config-helpers')

const { STANDARD_WORKFLOWS, PROTECTED_BRANCHES, buildBranchProtectionPayload } = await import(
  '../adapters/github-infra'
)

describe('shared/config', () => {
  describe('aliases', () => {
    it('STATUS_ALIASES covers all uppercase variants', () => {
      expect(STATUS_ALIASES.BACKLOG).toBe('Backlog')
      expect(STATUS_ALIASES['IN PROGRESS']).toBe('In Progress')
      expect(STATUS_ALIASES.IN_PROGRESS).toBe('In Progress')
      expect(STATUS_ALIASES.INPROGRESS).toBe('In Progress')
    })

    it('PRIORITY_ALIASES covers short and full forms', () => {
      expect(PRIORITY_ALIASES.URGENT).toBe('P0 - Urgent')
      expect(PRIORITY_ALIASES.HIGH).toBe('P1 - High')
      expect(PRIORITY_ALIASES.P0).toBe('P0 - Urgent')
      expect(PRIORITY_ALIASES.P1).toBe('P1 - High')
    })
  })

  describe('resolveStatus', () => {
    it('resolves canonical values', () => {
      expect(resolveStatus('Backlog')).toBe('Backlog')
      expect(resolveStatus('In Progress')).toBe('In Progress')
    })

    it('resolves uppercase aliases', () => {
      expect(resolveStatus('BACKLOG')).toBe('Backlog')
      expect(resolveStatus('IN PROGRESS')).toBe('In Progress')
      expect(resolveStatus('in_progress')).toBe('In Progress')
    })

    it('returns undefined for invalid input', () => {
      expect(resolveStatus('invalid')).toBeUndefined()
    })
  })

  describe('resolvePriority', () => {
    it('resolves canonical values', () => {
      expect(resolvePriority('P0 - Urgent')).toBe('P0 - Urgent')
    })

    it('resolves short aliases', () => {
      expect(resolvePriority('Urgent')).toBe('P0 - Urgent')
      expect(resolvePriority('High')).toBe('P1 - High')
      expect(resolvePriority('medium')).toBe('P2 - Medium')
      expect(resolvePriority('LOW')).toBe('P3 - Low')
    })

    it('resolves P-number aliases', () => {
      expect(resolvePriority('P0')).toBe('P0 - Urgent')
      expect(resolvePriority('p3')).toBe('P3 - Low')
    })

    it('returns undefined for invalid input', () => {
      expect(resolvePriority('none')).toBeUndefined()
    })
  })

  describe('resolveSize', () => {
    it('resolves tier-based sizes', () => {
      expect(resolveSize('S')).toBe('S')
      expect(resolveSize('F-lite')).toBe('F-lite')
      expect(resolveSize('F-full')).toBe('F-full')
    })

    it('maps legacy sizes to new tiers', () => {
      expect(resolveSize('XS')).toBe('S')
      expect(resolveSize('xs')).toBe('S')
      expect(resolveSize('M')).toBe('F-lite')
      expect(resolveSize('m')).toBe('F-lite')
      expect(resolveSize('L')).toBe('F-full')
      expect(resolveSize('l')).toBe('F-full')
      expect(resolveSize('XL')).toBe('F-full')
      expect(resolveSize('xl')).toBe('F-full')
    })

    it('returns undefined for invalid input', () => {
      expect(resolveSize('XXL')).toBeUndefined()
      expect(resolveSize('unknown')).toBeUndefined()
    })
  })

  describe('sort orders', () => {
    it('PRIORITY_ORDER ranks P0 highest', () => {
      expect(PRIORITY_ORDER['P0 - Urgent']).toBeLessThan(PRIORITY_ORDER['P3 - Low'])
    })

    it('BLOCK_ORDER ranks blocking first', () => {
      expect(BLOCK_ORDER.blocking).toBeLessThan(BLOCK_ORDER.ready)
      expect(BLOCK_ORDER.ready).toBeLessThan(BLOCK_ORDER.blocked)
    })
  })
})

describe('STANDARD_WORKFLOWS', () => {
  it('contains standard workflow files', () => {
    expect(STANDARD_WORKFLOWS).toContain('ci.yml')
    expect(STANDARD_WORKFLOWS).toContain('auto-merge.yml')
    expect(STANDARD_WORKFLOWS).toContain('merge-on-green.yml')
    expect(STANDARD_WORKFLOWS).toContain('pr-title.yml')
    expect(STANDARD_WORKFLOWS).toContain('secret-scan.yml')
    expect(STANDARD_WORKFLOWS).toContain('dependabot-automerge.yml')
    expect(STANDARD_WORKFLOWS).toContain('context-lint.yml')
    expect(STANDARD_WORKFLOWS).toContain('deploy-preview.yml')
    expect(STANDARD_WORKFLOWS).toContain('deploy-cloudflare.yml')
  })
})

describe('PROTECTED_BRANCHES', () => {
  it('contains main and staging', () => {
    expect(PROTECTED_BRANCHES).toEqual(['main', 'staging'])
  })
})

describe('buildBranchProtectionPayload', () => {
  it('does not require approving reviews (reviewed label is the gate)', () => {
    expect(buildBranchProtectionPayload({ hasSecretScan: false })).not.toHaveProperty('required_pull_request_reviews')
  })

  it('has strict status checks', () => {
    expect(buildBranchProtectionPayload({ hasSecretScan: false }).required_status_checks.strict).toBe(true)
  })

  it('includes trufflehog context when hasSecretScan is true', () => {
    const payload = buildBranchProtectionPayload({ hasSecretScan: true })
    expect(payload.required_status_checks.contexts).toContain('trufflehog')
  })

  it('excludes trufflehog context when hasSecretScan is false', () => {
    const payload = buildBranchProtectionPayload({ hasSecretScan: false })
    expect(payload.required_status_checks.contexts).not.toContain('trufflehog')
  })
})

registerGitHubRepoDetectionSuite({
  detectGitHubRepo,
})
