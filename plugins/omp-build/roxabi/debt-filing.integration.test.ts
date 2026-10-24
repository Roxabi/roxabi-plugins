import { afterEach, describe, expect, it } from 'vitest'
import { cleanupDebtFilingTemp, filing, world } from './debt-filing.fixture-world.ts'

afterEach(cleanupDebtFilingTemp)

describe('trusted debt filing', () => {
  it('files a PR follow-up beside its closing issue parent and blocks on that issue', async () => {
    const w = world()
    const result = await filing(w)

    expect(result).toMatchObject({ ok: true, value: { target: 'Acme/app#84' } })
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--no-env-file',
        '--type',
        'fix',
        '--size',
        'F-lite',
        '--parent',
        'Acme/app#7',
        '--blocked-by',
        'Acme/app#70',
      ]),
    )
    expect(w.body()).toContain('## Acceptance criteria')
    expect(w.body()).toContain('The save path uses the stale region field.')
    expect(w.body()).toContain('Save the selected region rather than the stale region.')
    expect(w.body()).toContain('## Retention diagnostics')
    expect(w.body()).toContain('baseline-blocking-member-required')
  })

  it('keeps a foreign source parent coordinate when filing a sibling follow-up', async () => {
    const w = world({ parent: 'foreign' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))?.args).toEqual(
      expect.arrayContaining(['--parent', 'Acme/planning#7', '--blocked-by', 'Acme/app#70']),
    )
  })

  it('files beside a top-level source issue without a parent relation', async () => {
    const w = world({ parent: 'none' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).not.toContain('--parent')
    expect(create?.args).toEqual(expect.arrayContaining(['--blocked-by', 'Acme/app#70']))
  })

  it('accepts the native Fix type spelling after readback', async () => {
    const w = world({ capitalizedType: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.calls.filter((call) => call.file === 'bun' && call.args.includes('set'))).toHaveLength(0)
  })

  it('files from the exact confirmed review-purpose decision without reclassification', async () => {
    const w = world()
    const result = await filing(w)

    expect(result).toMatchObject({ ok: true, value: { target: 'Acme/app#84' } })
    expect(w.body()).toContain('- decision: `decision-1`')
  })

  it('files a canonically bound retained unusable finding without reclassifying it', async () => {
    const w = world({ unusable: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.created).toEqual([84])
    expect(w.body()).toContain('- **Label:** issue')
  })

  it('files an uncited canonical finding without inventing a correction cause', async () => {
    const w = world()
    const result = await filing(w, { causeIds: [] })

    expect(result.ok).toBe(true)
    expect(w.body()).toContain('### finding-1: uncited correction obligation')
    expect(w.body()).toContain('**Canonical correction cause:** none retained')
  })

  it('refuses an unknown canonical source finding before creating', async () => {
    const w = world({ unknownSource: true })
    const result = await filing(w)

    expect(result).toMatchObject({ ok: false, diagnostics: [expect.stringContaining('unknown-reference')] })
    expect(w.created).toEqual([])
  })

  it('omits issue relationships but retains PR origin when the PR closes no issue', async () => {
    const w = world({ origin: 'none' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).not.toContain('--parent')
    expect(create?.args).not.toContain('--blocked-by')
    expect(w.body()).toContain('**Origin:** PR Acme/app#42')
  })

  it('refuses malicious receipt discoveries instead of treating a marker as proof', async () => {
    const w = world({ existing: 'malicious' })
    const result = await filing(w)

    expect(result).toEqual({ ok: false, diagnostics: ['issue-triage-existing-receipt-untrusted'] })
    expect(w.created).toEqual([])
  })

  it('refuses ambiguous receipt discovery before creating', async () => {
    const w = world({ existing: 'duplicate' })
    const result = await filing(w)

    expect(result).toEqual({ ok: false, diagnostics: ['issue-triage-existing-receipt-ambiguous'] })
    expect(w.created).toEqual([])
  })

  it('refuses ambiguous PR origin before creating', async () => {
    const w = world({ origin: 'many' })
    const result = await filing(w)

    expect(result).toMatchObject({ ok: false, diagnostics: ['issue-triage-file-failed:debt-origin-issue-ambiguous'] })
    expect(w.created).toEqual([])
  })

  it('repairs a partial create through set and never issues a second create', async () => {
    const w = world({ partial: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.created).toEqual([84])
    expect(w.calls.filter((call) => call.file === 'bun' && call.args.includes('create'))).toHaveLength(1)
    expect(w.calls.find((call) => call.file === 'bun' && call.args.includes('set'))?.args).toEqual(
      expect.arrayContaining([
        '--type',
        'fix',
        '--size',
        'F-lite',
        '--parent',
        'Acme/app#7',
        '--blocked-by',
        'Acme/app#70',
      ]),
    )
  })

  it('refuses before writing when the source has no mandatory size metadata', async () => {
    const w = world({ sourceSize: 'not-a-size' })
    const result = await filing(w)

    expect(result).toMatchObject({
      ok: false,
      diagnostics: ['issue-triage-file-failed:debt-source-issue-metadata-required'],
    })
    expect(w.created).toEqual([])
  })
})
