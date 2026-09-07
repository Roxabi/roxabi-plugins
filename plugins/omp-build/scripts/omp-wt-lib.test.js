import { describe, expect, it } from 'vitest'
import {
  classifyRawIntake,
  clientSlugFromByRepo,
  formatSparkFail,
  linkedGithubIssue,
  missingClientMessage,
  needsSparkClient,
  notSparkFlagMessage,
  parseArgv,
  parseGithubOrigin,
  parseJsonBlob,
  parseSparkToken,
  parseSparkUrl,
  readSparkError,
  sparkChildEnv,
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
    expect(readSparkError({ error: 'Clé API invalide ou absente.' })).toBe('Clé API invalide ou absente.')
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
    expect(sparkPayload('{"project":{"clientSlug":"metalyde"}}', 'by-repo').project.clientSlug).toBe('metalyde')
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
    expect(() => ticketFromSparkJson({ error: 'Clé API invalide ou absente.' }, { id: 59 })).toThrow(/has no title/)
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
    expect(formatSparkFail({ label: 'spark get', code: 1, stderr: 'boom', stdout: 'ignored' })).toBe(
      'spark get failed: exit 1: boom',
    )
  })
})

describe('classifyRawIntake', () => {
  it('treats bare numbers as GH issues', () => {
    expect(classifyRawIntake('60')).toEqual({ kind: 'gh', issue: 60 })
    expect(classifyRawIntake('#60')).toEqual({ kind: 'gh', issue: 60 })
  })

  it('classifies spark tokens and URLs', () => {
    expect(classifyRawIntake('metalyde#60')).toEqual({
      kind: 'spark',
      id: '60',
      client: 'metalyde',
    })
    expect(classifyRawIntake('spark:metalyde#60')).toEqual({
      kind: 'spark',
      id: '60',
      client: 'metalyde',
    })
    expect(classifyRawIntake('https://spark.gosilex.com/silex/developpement/cmtxxx')).toEqual({
      kind: 'spark',
      id: 'cmtxxx',
      client: 'silex',
    })
  })

  it('returns empty for blank input', () => {
    expect(classifyRawIntake('')).toEqual({ kind: 'empty' })
    expect(classifyRawIntake('   ')).toEqual({ kind: 'empty' })
  })

  it('falls back to subject', () => {
    expect(classifyRawIntake('Add pricing oracle')).toEqual({
      kind: 'subject',
      subject: 'Add pricing oracle',
    })
  })
  it('treats an Excalidraw URL as a subject, not Spark', () => {
    expect(classifyRawIntake('https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm')).toEqual({
      kind: 'subject',
      subject: 'https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm',
    })
  })
})

describe('parseArgv', () => {
  it('parses GH issue positional', () => {
    expect(parseArgv(['60'])).toEqual({
      printOnly: false,
      specPath: null,
      subject: null,
      issue: 60,
      sparkId: null,
      sparkClientFlag: null,
      sparkClientToken: null,
    })
  })

  it('parses spark id without client', () => {
    expect(parseArgv(['-s', '60'])).toEqual({
      printOnly: false,
      specPath: null,
      subject: null,
      issue: null,
      sparkId: '60',
      sparkClientFlag: null,
      sparkClientToken: null,
    })
  })

  it('parses spark id with client flag', () => {
    expect(parseArgv(['-s', '60', '-c', 'metalyde'])).toEqual({
      printOnly: false,
      specPath: null,
      subject: null,
      issue: null,
      sparkId: '60',
      sparkClientFlag: 'metalyde',
      sparkClientToken: null,
    })
  })

  it('rejects client without spark', () => {
    expect(parseArgv(['-c', 'x'])).toEqual({ usage: true })
  })

  it('extracts client from spark URL', () => {
    expect(parseArgv(['-s', 'https://spark.gosilex.com/silex/developpement/cmtxxx'])).toEqual({
      printOnly: false,
      specPath: null,
      subject: null,
      issue: null,
      sparkId: 'cmtxxx',
      sparkClientFlag: null,
      sparkClientToken: 'silex',
    })
  })

  it('rejects -s with a non-Spark URL instead of sending it as a ticket id', () => {
    const url = 'https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm'
    expect(parseArgv(['-s', url])).toEqual({ usage: true, error: notSparkFlagMessage(url) })
  })

  it('treats a positional Excalidraw URL as subject', () => {
    expect(parseArgv(['https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm'])).toMatchObject({
      subject: 'https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm',
      sparkId: null,
    })
  })

  it('still accepts a bare Spark cuid with -s', () => {
    expect(parseArgv(['-s', 'cmrlsrvwm000sxdmkb7jai3sv'])).toMatchObject({
      sparkId: 'cmrlsrvwm000sxdmkb7jai3sv',
      sparkClientToken: null,
    })
  })
})

describe('parseSparkUrl / parseSparkToken', () => {
  it('requires a Spark host and rejects Excalidraw', () => {
    expect(parseSparkUrl('https://spark.gosilex.com/silex/developpement/cmtxxx')).toEqual({
      client: 'silex',
      id: 'cmtxxx',
    })
    expect(parseSparkUrl('https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm')).toBeNull()
    expect(parseSparkUrl('https://evil.example/metalyde/developpement/cmtxxx')).toBeNull()
  })

  it('does not treat a non-Spark URL as a ticket id', () => {
    expect(parseSparkToken('https://app.excalidraw.com/s/7ad586Zigro/9tKtSYT5Xcm')).toBeNull()
  })

  it('still parses slug#N and spark:client#N', () => {
    expect(parseSparkToken('metalyde#60')).toEqual({ client: 'metalyde', id: '60' })
    expect(parseSparkToken('spark:metalyde#60')).toEqual({ client: 'metalyde', id: '60' })
  })

  it('still accepts a bare cuid', () => {
    expect(parseSparkToken('cmrlsrvwm000sxdmkb7jai3sv')).toEqual({
      id: 'cmrlsrvwm000sxdmkb7jai3sv',
      client: null,
    })
  })
})

describe('parseGithubOrigin', () => {
  it('parses https and ssh remotes', () => {
    expect(parseGithubOrigin('https://github.com/roxabi/roxabi-plugins.git')).toEqual({
      owner: 'roxabi',
      name: 'roxabi-plugins',
    })
    expect(parseGithubOrigin('git@github.com:roxabi/roxabi-plugins.git')).toEqual({
      owner: 'roxabi',
      name: 'roxabi-plugins',
    })
  })
})

describe('clientSlugFromByRepo', () => {
  it('returns project clientSlug', () => {
    expect(clientSlugFromByRepo({ project: { clientSlug: 'metalyde' } })).toBe('metalyde')
  })

  it('ignores error payloads', () => {
    expect(clientSlugFromByRepo({ error: 'Projet introuvable.' })).toBeNull()
  })
})

describe('sparkChildEnv', () => {
  it('strips SPARK_URL and SPARK_API_KEY so a project .env cannot point spark.sh at staging', () => {
    expect(
      sparkChildEnv({
        HOME: '/home/dev',
        SPARK_URL: 'https://spark-staging.gosilex.com',
        SPARK_API_KEY: 'spk_placeholder',
        SPARK_USER_API_KEY: 'spu_keep',
      }),
    ).toEqual({
      HOME: '/home/dev',
      SPARK_USER_API_KEY: 'spu_keep',
    })
  })
})
