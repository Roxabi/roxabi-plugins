import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Clear option env vars before config module loads so defaults apply (not .env values)
delete process.env.STATUS_OPTIONS_JSON
delete process.env.SIZE_OPTIONS_JSON
delete process.env.PRIORITY_OPTIONS_JSON
delete process.env.GH_PROJECT_ID
// Must be set before config module loads (detectGitHubRepo runs eagerly at import)
process.env.GITHUB_REPO = 'Test/test-repo'

const {
  BLOCK_ORDER,
  NOT_CONFIGURED_MSG,
  detectGitHubRepo,
  FIELD_MAP,
  isProjectConfigured,
  PRIORITY_ALIASES,
  PRIORITY_OPTIONS,
  PRIORITY_ORDER,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_OPTIONS,
  STATUS_ALIASES,
  STATUS_OPTIONS,
} = await import('../adapters/config-helpers')

const { STANDARD_LABELS, STANDARD_WORKFLOWS, PROTECTED_BRANCHES, buildBranchProtectionPayload } = await import(
  '../adapters/github-infra'
)

describe('shared/config', () => {
  describe('option maps', () => {
    it('defaults to empty when env vars are not set', () => {
      expect(Object.keys(STATUS_OPTIONS)).toEqual([])
      expect(Object.keys(SIZE_OPTIONS)).toEqual([])
      expect(Object.keys(PRIORITY_OPTIONS)).toEqual([])
    })
  })

  describe('FIELD_MAP', () => {
    it('contains status, size, priority, and lane', () => {
      expect(Object.keys(FIELD_MAP)).toEqual(['status', 'size', 'priority', 'lane'])
    })

    it('each entry has a fieldId and options object', () => {
      for (const entry of Object.values(FIELD_MAP)) {
        expect(typeof entry.fieldId).toBe('string')
        expect(typeof entry.options).toBe('object')
      }
    })
  })

  describe('isProjectConfigured', () => {
    it('returns false when GH_PROJECT_ID is empty', () => {
      expect(isProjectConfigured()).toBe(false)
    })

    it('returns a string for NOT_CONFIGURED_MSG', () => {
      expect(NOT_CONFIGURED_MSG).toContain('/init')
    })

    it('returns false when only old PROJECT_ID is set (not GH_PROJECT_ID)', () => {
      const orig = process.env.PROJECT_ID
      process.env.PROJECT_ID = 'PVT_legacy'
      delete process.env.GH_PROJECT_ID
      try {
        expect(isProjectConfigured()).toBe(false)
      } finally {
        if (orig !== undefined) process.env.PROJECT_ID = orig
        else delete process.env.PROJECT_ID
      }
    })
  })

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

describe('STANDARD_LABELS', () => {
  it('has exactly 11 labels', () => {
    expect(STANDARD_LABELS).toHaveLength(11)
  })

  it('all names are unique', () => {
    const names = STANDARD_LABELS.map((l) => l.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('all colors are valid 6-char hex', () => {
    for (const label of STANDARD_LABELS) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/)
    }
  })

  it('has correct category counts (6 type, 5 area)', () => {
    const counts = { type: 0, area: 0 }
    for (const label of STANDARD_LABELS) counts[label.category]++
    expect(counts).toEqual({ type: 6, area: 5 })
  })
})

describe('STANDARD_WORKFLOWS', () => {
  it('contains standard workflow files', () => {
    expect(STANDARD_WORKFLOWS).toContain('ci.yml')
    expect(STANDARD_WORKFLOWS).toContain('auto-merge.yml')
    expect(STANDARD_WORKFLOWS).toContain('pr-title.yml')
    expect(STANDARD_WORKFLOWS).toContain('deploy-preview.yml')
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

describe('detectGitHubRepo', () => {
  const originalEnv = process.env.GITHUB_REPO
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>
  let execSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.GITHUB_REPO
    spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
    // Mock execSync to throw (simulating gh CLI not available)
    // This forces the code to use git detection path
    execSyncSpy = vi.spyOn(require('node:child_process'), 'execSync').mockImplementation(() => {
      throw new Error('gh: command not found')
    })
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPO = originalEnv
    } else {
      delete process.env.GITHUB_REPO
    }
    spawnSyncSpy.mockRestore()
    execSyncSpy.mockRestore()
  })

  it('prefers GITHUB_REPO env var when set', () => {
    process.env.GITHUB_REPO = 'MyOrg/my-repo'
    expect(detectGitHubRepo()).toBe('MyOrg/my-repo')
    expect(spawnSyncSpy).not.toHaveBeenCalled()
  })

  it('parses SSH remote URL', () => {
    spawnSyncSpy.mockReturnValue({
      stdout: new TextEncoder().encode('git@github.com:Roxabi/roxabi-plugins.git\n'),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
  })

  it('parses HTTPS remote URL', () => {
    const stdout = new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins.git\n')
    spawnSyncSpy.mockReturnValue({
      stdout,
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    const result = detectGitHubRepo()
    expect(result).toBe('Roxabi/roxabi-plugins')
  })

  it('parses HTTPS remote URL without .git suffix', () => {
    spawnSyncSpy.mockReturnValue({
      stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins\n'),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
  })

  it('throws when no env var, no git remote, and no gh CLI', async () => {
    // Temporarily remove GITHUB_REPO env var to force git detection
    const originalEnv = process.env.GITHUB_REPO
    delete process.env.GITHUB_REPO

    // Mock git to fail
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('fatal: not a git repository\n'),
      exitCode: 128,
      success: false,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    // The function should throw when detection fails
    expect(() => detectGitHubRepo()).toThrow('Cannot detect GitHub repo')

    // Restore env
    process.env.GITHUB_REPO = originalEnv
  })
})
