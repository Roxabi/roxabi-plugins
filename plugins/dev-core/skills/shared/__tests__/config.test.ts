import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

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
  STANDARD_LABELS,
  STANDARD_WORKFLOWS,
  PROTECTED_BRANCHES,
  BRANCH_PROTECTION_PAYLOAD,
  STATUS_ALIASES,
  STATUS_OPTIONS,
} = await import('../config')

describe('shared/config', () => {
  describe('option maps', () => {
    it('defaults to empty when env vars are not set', () => {
      expect(Object.keys(STATUS_OPTIONS)).toEqual([])
      expect(Object.keys(SIZE_OPTIONS)).toEqual([])
      expect(Object.keys(PRIORITY_OPTIONS)).toEqual([])
    })
  })

  describe('FIELD_MAP', () => {
    it('contains status, size, and priority', () => {
      expect(Object.keys(FIELD_MAP)).toEqual(['status', 'size', 'priority'])
    })

    it('each entry has a fieldId and options object', () => {
      for (const entry of Object.values(FIELD_MAP)) {
        expect(typeof entry.fieldId).toBe('string')
        expect(typeof entry.options).toBe('object')
      }
    })
  })

  describe('isProjectConfigured', () => {
    it('returns false when PROJECT_ID is empty', () => {
      expect(isProjectConfigured()).toBe(false)
    })

    it('returns a string for NOT_CONFIGURED_MSG', () => {
      expect(NOT_CONFIGURED_MSG).toContain('/init')
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
    it('resolves all valid sizes (case-insensitive)', () => {
      expect(resolveSize('xs')).toBe('XS')
      expect(resolveSize('S')).toBe('S')
      expect(resolveSize('m')).toBe('M')
      expect(resolveSize('L')).toBe('L')
      expect(resolveSize('xl')).toBe('XL')
    })

    it('returns undefined for invalid input', () => {
      expect(resolveSize('XXL')).toBeUndefined()
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
  it('has exactly 15 labels', () => {
    expect(STANDARD_LABELS).toHaveLength(15)
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

  it('has correct category counts (6 type, 5 area, 4 priority)', () => {
    const counts = { type: 0, area: 0, priority: 0 }
    for (const label of STANDARD_LABELS) counts[label.category]++
    expect(counts).toEqual({ type: 6, area: 5, priority: 4 })
  })
})

describe('STANDARD_WORKFLOWS', () => {
  it('contains ci.yml and deploy-preview.yml', () => {
    expect(STANDARD_WORKFLOWS).toEqual(['ci.yml', 'deploy-preview.yml'])
  })
})

describe('PROTECTED_BRANCHES', () => {
  it('contains main and staging', () => {
    expect(PROTECTED_BRANCHES).toEqual(['main', 'staging'])
  })
})

describe('BRANCH_PROTECTION_PAYLOAD', () => {
  it('requires 1 approving review', () => {
    expect(BRANCH_PROTECTION_PAYLOAD.required_pull_request_reviews.required_approving_review_count).toBe(1)
  })

  it('has strict status checks', () => {
    expect(BRANCH_PROTECTION_PAYLOAD.required_status_checks.strict).toBe(true)
  })
})

describe('detectGitHubRepo', () => {
  const originalEnv = process.env.GITHUB_REPO
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.GITHUB_REPO
    spawnSyncSpy = vi.spyOn(Bun, 'spawnSync')
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.GITHUB_REPO = originalEnv
    } else {
      delete process.env.GITHUB_REPO
    }
    spawnSyncSpy.mockRestore()
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
    spawnSyncSpy.mockReturnValue({
      stdout: new TextEncoder().encode('https://github.com/Roxabi/roxabi-plugins.git\n'),
      stderr: new Uint8Array(),
      exitCode: 0,
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    expect(detectGitHubRepo()).toBe('Roxabi/roxabi-plugins')
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

  it('throws when no env var and no git remote', () => {
    spawnSyncSpy.mockReturnValue({
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('fatal: not a git repository\n'),
      exitCode: 128,
      success: false,
    } as unknown as ReturnType<typeof Bun.spawnSync>)

    expect(() => detectGitHubRepo()).toThrow('Cannot detect GitHub repo')
  })
})
