import { describe, expect, it } from 'vitest'
import {
  formatSparkFail,
  linkedGithubIssue,
  missingClientMessage,
  needsSparkClient,
  parseJsonBlob,
  readSparkError,
  sparkPayload,
  ticketFromSparkJson,
} from './omp-wt-lib.js'

describe('parseJsonBlob', () => {
  it('parses a single object', () => {
    expect(parseJsonBlob('{"a":1}\n')).toEqual({ a: 1 })
  })

  it('uses the last JSON line when stdout is mixed', () => {
    expect(parseJsonBlob('noise\n{"ok":true}\n')).toEqual({ ok: true })
  })

  it('rejects empty stdout', () => {
    expect(() => parseJsonBlob('  \n')).toThrow(/empty JSON/)
  })
})

describe('readSparkError', () => {
  it('returns the API error string', () => {
    expect(readSparkError({ error: 'Clé API invalide ou absente.' })).toBe(
      'Clé API invalide ou absente.',
    )
  })

  it('ignores a successful ticket payload', () => {
    expect(readSparkError({ ticket: { title: 'x', ref: 59 } })).toBeNull()
  })

  it('ignores non-objects', () => {
    expect(readSparkError(null)).toBeNull()
    expect(readSparkError([{ error: 'x' }])).toBeNull()
  })
})

describe('sparkPayload', () => {
  it('throws the API error even when spark.sh exited 0', () => {
    expect(() => sparkPayload('{"error":"Identifiant non unique"}', 'spark get 59')).toThrow(
      'spark get 59: Identifiant non unique',
    )
  })

  it('returns the object when there is no error field', () => {
    expect(sparkPayload('{"project":{"clientSlug":"metalyde"}}', 'by-repo').project.clientSlug).toBe(
      'metalyde',
    )
  })

  it('throws when stdout is not JSON', () => {
    expect(() => sparkPayload('usage: spark.sh', 'spark get')).toThrow(/not JSON/)
  })
})

describe('needsSparkClient / missingClientMessage', () => {
  it('requires a client for numeric refs only', () => {
    expect(needsSparkClient('59')).toBe(true)
    expect(needsSparkClient('cmrsiblkz000001pez6br5hke')).toBe(false)
  })

  it('tells the operator how to pass the client', () => {
    expect(missingClientMessage(59)).toMatch(/-c <slug>/)
    expect(missingClientMessage(59)).toMatch(/<slug>#59/)
  })
})

describe('ticketFromSparkJson', () => {
  it('reads ticket.title', () => {
    const t = ticketFromSparkJson(
      { ticket: { title: 'Epic — Budget', ref: 59, clientSlug: 'metalyde', body: 'x' } },
      { id: 59, client: 'metalyde' },
    )
    expect(t).toMatchObject({ title: 'Epic — Budget', ref: 59, clientSlug: 'metalyde', body: 'x' })
  })

  it('fails closed when title is missing (error JSON treated as ticket)', () => {
    expect(() => ticketFromSparkJson({ error: 'Clé API invalide ou absente.' }, { id: 59 })).toThrow(
      /has no title/,
    )
  })
})

describe('linkedGithubIssue', () => {
  it('reads issues[0].number', () => {
    expect(linkedGithubIssue({ issues: [{ number: 282 }] })).toBe(282)
  })

  it('returns null on API error instead of inventing an issue', () => {
    expect(linkedGithubIssue({ error: 'Clé API invalide ou absente.' })).toBeNull()
  })
})

describe('formatSparkFail', () => {
  it('prefers stderr, then stdout, and includes exit code', () => {
    expect(
      formatSparkFail({ label: 'spark get', code: 1, stderr: 'boom', stdout: 'ignored' }),
    ).toBe('spark get failed: exit 1: boom')
  })
})
