import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const PARSE = fileURLToPath(new URL('../parse-falsify.sh', import.meta.url))
const ROOT = join(PARSE, '..', '..', '..', '..', '..')
// Tracked in this worktree — git ls-files is the oracle when the CLI has no diff.
const TRACKED = 'plugins/dev-core/skills/pr/parse-falsify.sh'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parse-falsify-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runCli(file: string): string {
  const r = spawnSync('bash', [PARSE, file, 'main'], { encoding: 'utf-8', cwd: ROOT })
  return r.stdout
}

function keys(stdout: string): { falsify_ok: string; falsify_reason: string } {
  return {
    falsify_ok: stdout.match(/^falsify_ok=(.*)$/m)?.[1] ?? '',
    falsify_reason: stdout.match(/^falsify_reason=(.*)$/m)?.[1] ?? '',
  }
}

function writeEvidence(body: string): string {
  const p = join(dir, 'falsify.md')
  writeFileSync(p, body)
  return p
}

function matrixDoc(rows: string, evidence = ''): string {
  return writeEvidence(
    `## SC → Test Matrix\n\n| SC | Test(s) | Status |\n|----|---------|--------|\n${rows}\n\n## Falsification Evidence\n\n${evidence}\n`,
  )
}

describe('parse-falsify.sh CLI — stdout keys, fail-closed', () => {
  it('missing file → missing-artifact', () => {
    const out = keys(runCli(join(dir, 'nope.md')))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('missing-artifact')
  })

  it('no SC heading → missing-matrix', () => {
    const file = writeEvidence('## Falsification Evidence\n\nbroke x → AssertionError: x\n')
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('missing-matrix')
  })

  it('heading-only / no rows → missing-matrix-rows', () => {
    const file = writeEvidence('## SC → Test Matrix\n\n## Falsification Evidence\n')
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('missing-matrix-rows')
  })

  it('⏳ not run → pending-row', () => {
    const file = matrixDoc(`| SC1: pending | ${TRACKED} :: t | ⏳ not run |`)
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('pending-row')
  })

  it('broke x → {error} → placeholder', () => {
    const file = matrixDoc(`| SC1: mapped | ${TRACKED} :: t | ✓ proven |`, 'broke x → {error}')
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('placeholder')
  })

  it('broke . → AssertionError with proven rows is not ok', () => {
    // '.' exists as a directory and is a glob wildcard against the tests cell.
    // The priced quantity is a regular file in git; '.' must not satisfy it.
    const file = matrixDoc(`| SC1: mapped | ${TRACKED} :: t | ✓ proven |`, 'broke . → AssertionError: expected true')
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(['unreal-file', 'proven-unmatched']).toContain(out.falsify_reason)
  })

  it('✓ proven with no matching broke line → proven-unmatched', () => {
    const file = matrixDoc(`| SC1: mapped | ${TRACKED} :: t | ✓ proven |`)
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('proven-unmatched')
  })

  it('all rows ⚠ NO TEST — prompt-logic-only and empty evidence → no-proven-row', () => {
    const file = matrixDoc('| SC1: prompt | — | ⚠ NO TEST — prompt-logic-only |')
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('no-proven-row')
  })

  it('all-e2e matrix is no-proven-row, not bad-status', () => {
    const file = matrixDoc(`| SC1: e2e | ${TRACKED} :: t | ⚠ NO FALSIFY — e2e |`)
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('no-proven-row')
  })

  it('happy path: proven row + tracked file + error token', () => {
    const file = matrixDoc(
      `| SC1: matcher | ${TRACKED} :: t | ✓ proven |`,
      `broke ${TRACKED} → AssertionError: expected true`,
    )
    const out = keys(runCli(file))
    expect(out.falsify_ok).toBe('true')
    expect(out.falsify_reason).toBe('ok')
  })
})

function emitGates(issue: string, spec: string, branch: string): string {
  const r = spawnSync(
    'bash',
    ['-c', 'source "$1"; pf_emit_gates "$2" "$3" "$4" "$5"', '_', PARSE, issue, 'main', spec, branch],
    { encoding: 'utf-8', cwd: ROOT },
  )
  return r.stdout
}

function gateKeys(stdout: string): {
  priced_ok: string
  falsify_required: string
  falsify_ok: string
  falsify_reason: string
} {
  return {
    priced_ok: stdout.match(/^priced_ok=(.*)$/m)?.[1] ?? '',
    falsify_required: stdout.match(/^falsify_required=(.*)$/m)?.[1] ?? '',
    falsify_ok: stdout.match(/^falsify_ok=(.*)$/m)?.[1] ?? '',
    falsify_reason: stdout.match(/^falsify_reason=(.*)$/m)?.[1] ?? '',
  }
}

describe('pf_emit_gates — missing spec / no-issue fail-closed', () => {
  it('τ≠S and missing spec → priced_ok=false', () => {
    const out = gateKeys(emitGates('42', '', 'feat/42-control-quality'))
    expect(out.priced_ok).toBe('false')
  })

  it('τ≠S and no issue → falsify_required=true, falsify_ok=false, no-issue', () => {
    const out = gateKeys(emitGates('', '', 'feat/no-issue'))
    expect(out.priced_ok).toBe('false')
    expect(out.falsify_required).toBe('true')
    expect(out.falsify_ok).toBe('false')
    expect(out.falsify_reason).toBe('no-issue')
  })

  it('τ=S (chore prefix) without spec still skip-opens', () => {
    const out = gateKeys(emitGates('', '', 'chore/docs-only'))
    expect(out.priced_ok).toBe('true')
    expect(out.falsify_required).toBe('false')
    expect(out.falsify_ok).toBe('true')
    expect(out.falsify_reason).toBe('no-issue')
  })
})
