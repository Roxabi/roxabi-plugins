#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { githubPreparationKind } from '../host/preparation-gh-classifier.ts'
import { executeSimCommand } from '../skills/feature/testing/gh-simulator/sim-execution.ts'

// A fault may refuse a POST before dispatch or lose a response after simulator persistence.
// Its marker is transport evidence, never workflow authority.
const argv = process.argv.slice(2)
if (process.env.RECOVERY_GH_TRACE) {
  const safe = argv.map((arg, index) => {
    if (index > 0 && ['-f', '-F', '--field', '--raw-field'].includes(argv[index - 1] ?? '')) {
      const key = arg.split('=', 1)[0]
      if (key === 'query') {
        const document = arg.slice('query='.length)
        const operation = /\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(document)
        const sha256 = createHash('sha256').update(document, 'utf8').digest('hex')
        return `query=<${operation?.[1] ?? 'unknown'}:${operation?.[2] ?? 'anonymous'}:sha256=${sha256}>`
      }
      return `${key}=<redacted>`
    }
    if (index > 0 && ['-H', '--header', '--hostname'].includes(argv[index - 1] ?? '')) return '<redacted>'
    if (arg.startsWith('body=')) return 'body=<redacted>'
    return index < 2 || arg.startsWith('-') || /^(GET|POST|PATCH|PUT|DELETE|graphql)$/.test(arg) ? arg : '<redacted>'
  })
  appendFileSync(
    process.env.RECOVERY_GH_TRACE,
    `${JSON.stringify({ kind: githubPreparationKind(argv), argv: safe })}\n`,
  )
}
const kind = process.env.FIX_RECOVERY_FAULT_KIND
const marker = process.env.FIX_RECOVERY_FAULT_MARKER
const before = process.env.FIX_RECOVERY_FAULT_BEFORE === '1'
const body = argv.find((arg) => arg.startsWith('body='))?.slice(5) ?? ''
const commentPost =
  argv.includes('POST') && argv.some((arg) => /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(arg))
const matches = Boolean(marker && kind && commentPost && body.includes(`<!-- omp-build-record v=1 kind=${kind} `))
// After an accepted R POST loses its response, publication-writer.ts:63 reads
// page one to reconcile it. Fail that one exact pure GET, then allow all later
// reads, including settlement's independent fresh history, to run normally.
if (
  process.env.FIX_RECOVERY_FAIL_RECONCILE === '1' &&
  marker &&
  existsSync(marker) &&
  process.env.FIX_RECOVERY_FAULT_RELEASE &&
  existsSync(process.env.FIX_RECOVERY_FAULT_RELEASE)
) {
  const original = JSON.parse(readFileSync(marker, 'utf8')) as { kind?: string; before?: boolean; argv?: string[] }
  const endpoint = original.argv?.find((arg) => /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(arg))
  if (
    original.kind === 'fix-request' &&
    original.before === false &&
    endpoint &&
    argv[0] === 'api' &&
    argv[1] === `${endpoint}?per_page=100&page=1` &&
    argv.includes('--include')
  ) {
    try {
      writeFileSync(`${marker}.read-failed`, JSON.stringify({ endpoint: argv[1], operation: 'reconcile-page-one' }), {
        flag: 'wx',
      })
      process.stderr.write('fixture: one reconciliation GET failed\n')
      process.exit(1)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
function interrupt(): boolean {
  if (!marker) return false
  // Readers act on the marker's existence, so it appears whole: the JSON is staged, then linked.
  // Like an exclusive create, the link fails with EEXIST when another call published first.
  const staged = `${marker}.${process.pid}.tmp`
  try {
    writeFileSync(staged, JSON.stringify({ kind, body, argv, before }))
    linkSync(staged, marker)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(staged, { force: true })
  }
  const release = process.env.FIX_RECOVERY_FAULT_RELEASE
  if (release) {
    const deadline = Date.now() + 30_000
    const signal = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(release) && Date.now() < deadline) Atomics.wait(signal, 0, 0, 25)
    if (!existsSync(release)) throw new Error('fixture: publication gate timed out')
  }
  process.stderr.write(
    before ? 'fixture: POST refused before simulator dispatch\n' : 'fixture: response lost after accepted comment\n',
  )
  return true
}
if (matches && before && interrupt()) {
  process.exitCode = 1
} else {
  const result = executeSimCommand(argv, { cwd: process.cwd(), readStdin: () => readFileSync(0, 'utf8') })
  if (result.status === 0 && matches && !before && interrupt()) process.exitCode = 1
  else {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.status
  }
}
