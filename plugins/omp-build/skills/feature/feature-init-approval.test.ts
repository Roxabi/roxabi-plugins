import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseFacts } from './feature-init.fixture'
import { initFeature } from './feature-init-apply'
import type { TriageInit } from './feature-init-triage'

let scratch: string | undefined
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})
describe('feature init authorization', () => {
  function authTriage(writes: { tracker: number }): TriageInit {
    return {
      defaultInitDeps: () => ({
        cwdRepo: 'Acme/app',
        listLabelNames: async () => [],
        listIssueLabelSets: async () => [],
        readContract: () => null,
        ensureLabel: async () => 'present' as const,
        updateLabels: async () => {},
        writeContract: () => {},
      }),
      buildPlan: async () => ({
        plan: {
          repo: 'Acme/app',
          createLabels: [],
          labelColors: {},
          relabels: [],
          proseBlockedBy: [],
          contract: 'unchanged' as const,
          vocabulary: 'canonical' as const,
          refused: [],
        },
        issues: [],
        contractText: 'contract',
      }),
      canonicalPlan: () => 'tracker-plan',
      applyApprovedPlan: async () => {
        writes.tracker++
        throw new Error('must not run')
      },
    } as unknown as TriageInit
  }

  it('refuses digest-only approval before stack or tracker writes', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-approval-'))
    const writes = { tracker: 0 }
    const deps = {
      facts: { ...baseFacts(), mergeOnGreen: false },
      parseYaml: () => ({ schema_version: '1.0' }),
      triage: authTriage(writes),
      repository: 'Acme/app',
      principal: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const preview = await initFeature(['--dir', scratch], deps)
    await expect(initFeature(['--dir', scratch, '--approve', preview.digest], deps)).rejects.toThrow(
      'explicit operator approval is required',
    )
    expect(existsSync(path.join(scratch, '.dev', 'stack.yml'))).toBe(false)
    expect(writes.tracker).toBe(0)
    vi.restoreAllMocks()
  })

  it('refuses a wrong approval digest before stack or tracker writes', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-wrong-digest-'))
    const writes = { tracker: 0 }
    const deps = {
      facts: { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parseYaml: () => ({ schema_version: '1.0' }),
      triage: authTriage(writes),
      repository: 'Acme/app',
      principal: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(
      initFeature(['--dir', scratch, '--approve', '0'.repeat(64), '--operator-approval', 'ship it'], deps),
    ).rejects.toThrow('approval digest does not match the preview')
    expect(existsSync(path.join(scratch, '.dev', 'stack.yml'))).toBe(false)
    expect(writes.tracker).toBe(0)
    vi.restoreAllMocks()
  })

  it('refuses digest pasted as operator approval before stack or tracker writes', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-digest-as-approval-'))
    const writes = { tracker: 0 }
    const deps = {
      facts: { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parseYaml: () => ({ schema_version: '1.0' }),
      triage: authTriage(writes),
      repository: 'Acme/app',
      principal: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const preview = await initFeature(['--dir', scratch], deps)
    await expect(
      initFeature(['--dir', scratch, '--approve', preview.digest, '--operator-approval', preview.digest], deps),
    ).rejects.toThrow('explicit operator approval is required')
    await expect(
      initFeature(['--dir', scratch, '--approve', preview.digest, '--operator-approval', `${preview.digest}\n`], deps),
    ).rejects.toThrow('explicit operator approval is required')
    await expect(
      initFeature(['--dir', scratch, '--approve', preview.digest, '--operator-approval', ` ${preview.digest} `], deps),
    ).rejects.toThrow('explicit operator approval is required')
    await expect(
      initFeature(
        ['--dir', scratch, '--approve', preview.digest, '--operator-approval', `${preview.digest}\u200B`],
        deps,
      ),
    ).rejects.toThrow('explicit operator approval is required')
    await expect(
      initFeature(
        ['--dir', scratch, '--approve', preview.digest, '--operator-approval', `\u200C${preview.digest}`],
        deps,
      ),
    ).rejects.toThrow('explicit operator approval is required')
    expect(existsSync(path.join(scratch, '.dev', 'stack.yml'))).toBe(false)
    expect(writes.tracker).toBe(0)
    vi.restoreAllMocks()
  })

  it('refuses apply on the principal before stack or tracker writes', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-apply-'))
    const writes = { tracker: 0 }
    const deps = {
      facts: { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parseYaml: () => ({ schema_version: '1.0' }),
      triage: authTriage(writes),
      repository: 'Acme/app',
      principal: true,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const preview = await initFeature(['--dir', scratch], deps)
    await expect(
      initFeature(['--dir', scratch, '--approve', preview.digest, '--operator-approval', 'ship it'], deps),
    ).rejects.toThrow('init=refused principal')
    expect(existsSync(path.join(scratch, '.dev', 'stack.yml'))).toBe(false)
    expect(writes.tracker).toBe(0)
    vi.restoreAllMocks()
  })

  it('binds preserved stack bytes into the approval digest', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-digest-bytes-'))
    mkdirSync(path.join(scratch, '.dev'), { recursive: true })
    writeFileSync(path.join(scratch, '.dev', 'stack.yml'), 'schema_version: "1.0"\nkeep: one\n')
    const deps = {
      facts: { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parseYaml: (text: string) => {
        const map: Record<string, unknown> = {}
        for (const line of text.split('\n')) {
          const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
          if (match) map[match[1]] = match[2].replace(/^"|"$/g, '')
        }
        return map
      },
      triage: authTriage({ tracker: 0 }),
      repository: 'Acme/app',
      principal: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = await initFeature(['--dir', scratch], deps)
    writeFileSync(path.join(scratch, '.dev', 'stack.yml'), 'schema_version: "1.0"\nkeep: tampered\n')
    const second = await initFeature(['--dir', scratch], deps)
    expect(second.digest).not.toBe(first.digest)
    await expect(
      initFeature(['--dir', scratch, '--approve', first.digest, '--operator-approval', 'ship it'], deps),
    ).rejects.toThrow('approval digest does not match the preview')
    expect(readFileSync(path.join(scratch, '.dev', 'stack.yml'), 'utf8')).toContain('tampered')
    vi.restoreAllMocks()
  })

  it('refuses a rebuilt tracker plan that differs before stack or tracker writes', async () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-changed-plan-'))
    let plans = 0
    let applies = 0
    const triage = {
      defaultInitDeps: () => ({
        cwdRepo: 'Acme/app',
        listLabelNames: async () => [],
        listIssueLabelSets: async () => [],
        readContract: () => null,
        ensureLabel: async () => 'present' as const,
        updateLabels: async () => {},
        writeContract: () => {},
      }),
      buildPlan: async () => {
        plans++
        return {
          plan: {
            repo: 'Acme/app',
            createLabels: plans > 2 ? ['size:S'] : [],
            labelColors: { 'size:S': 'ededed' },
            relabels: [],
            proseBlockedBy: [],
            contract: 'unchanged' as const,
            vocabulary: 'canonical' as const,
            refused: [],
          },
          issues: [],
          contractText: 'contract',
        }
      },
      canonicalPlan: (trackerPlan: { createLabels: string[] }) => JSON.stringify(trackerPlan.createLabels),
      applyApprovedPlan: async () => {
        applies++
        throw new Error('must not run')
      },
    } as unknown as TriageInit
    const deps = {
      facts: { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parseYaml: () => ({ schema_version: '1.0' }),
      triage,
      repository: 'Acme/app',
      principal: false,
    }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const preview = await initFeature(['--dir', scratch], deps)
    await expect(
      initFeature(['--dir', scratch, '--approve', preview.digest, '--operator-approval', 'yes'], deps),
    ).rejects.toThrow('plan changed before apply')
    expect(existsSync(path.join(scratch, '.dev', 'stack.yml'))).toBe(false)
    expect(applies).toBe(0)
    vi.restoreAllMocks()
  })
})
