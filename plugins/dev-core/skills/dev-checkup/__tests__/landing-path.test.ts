import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateCiYml } from '../../shared/workflows/workflow-generators'
import { checkLandingPath } from '../doctor-local'

describe('checkLandingPath', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-path-'))
    process.chdir(tmpDir)
    fs.mkdirSync('.github/workflows', { recursive: true })
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when ci.yml has a classify job on push', () => {
    fs.writeFileSync('.github/workflows/ci.yml', generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' }))
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).toBe('pass')
  })

  it('fails when classify still uses .merged == true on /commits/.../pulls', () => {
    fs.writeFileSync(
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  classify:',
        '    steps:',
        '      - run: |',
        '          prs="$(gh api "repos/acme/repo/commits/deadbeef/pulls")"',
        '          n="$(printf \'%s\' "$prs" | jq --arg sha "$SHA" \'[.[] | select(.merged == true and .merge_commit_sha == $sha)] | length\')"',
        '  ci:',
        '    name: CI',
        "    if: needs.classify.outputs.path == 'naked'",
      ].join('\n'),
    )
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).not.toBe('pass')
    expect(ci?.detail).toContain('.merged == true')
  })

  it('fails when classify probe misses a naked-gated suite job', () => {
    fs.writeFileSync(
      '.github/workflows/ci.yml',
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  classify:',
        '    steps:',
        '      - run: |',
        '          n="$(jq \'[.[] | select(.state == "closed" and .merge_commit_sha == $sha)] | length\')"',
        '          ok="$(jq \'[.check_runs[] | select(.conclusion == "success") | (.name | ascii_downcase) | select(. == "ci")] | unique | length\')"',
        '          if [ "$ok" -ge 1 ]; then path=pr-merge; fi',
        '  ci:',
        '    name: CI',
        "    if: needs.classify.outputs.path == 'naked'",
        '  e2e:',
        '    name: E2E',
        "    if: needs.classify.outputs.path == 'naked'",
      ].join('\n'),
    )
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).not.toBe('pass')
    expect(ci?.detail).toContain('e2e')
  })

  it('warns when ci.yml pushes without classify', () => {
    fs.writeFileSync('.github/workflows/ci.yml', 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  ci: {}\n')
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).toBe('warn')
    expect(ci?.detail).toContain('without classify')
  })

  it('skips absent workflows', () => {
    const { checks } = checkLandingPath()
    expect(checks.every((c) => c.status === 'skip')).toBe(true)
  })
})
