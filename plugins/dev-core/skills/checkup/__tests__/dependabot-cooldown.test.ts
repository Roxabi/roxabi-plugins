import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSecurity, detectDependabotCooldownViolations } from '../doctor-local'

/**
 * Dependabot cooldown validity.
 * `semver-*-days` is supported for npm/yarn but not for github-actions; GitHub
 * rejects the whole file at parse time when it appears there, so a presence-only
 * check passes on a config that is entirely inert.
 */

// The repo's own valid config, inlined so the test does not read .github/.
const VALID = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: github-actions',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '    groups:',
  '      github-actions:',
  '        patterns:',
  '          - "*"',
  '        update-types:',
  '          - minor',
  '          - patch',
  '    cooldown:',
  '      default-days: 3',
  '  - package-ecosystem: npm',
  '    directory: /',
  '    schedule:',
  '      interval: weekly',
  '    groups:',
  '      npm-dependencies:',
  '        patterns:',
  '          - "*"',
  '        update-types:',
  '          - minor',
  '          - patch',
  '    cooldown:',
  '      default-days: 3',
  '      semver-major-days: 7',
  '      semver-minor-days: 3',
  '      semver-patch-days: 3',
].join('\n')

// The config GitHub rejected for weeks: semver-*-days under github-actions.
const BROKEN = VALID.replace(
  ['    cooldown:', '      default-days: 3', '  - package-ecosystem: npm'].join('\n'),
  ['    cooldown:', '      default-days: 3', '      semver-major-days: 7', '  - package-ecosystem: npm'].join('\n'),
)

describe('detectDependabotCooldownViolations', () => {
  it('does not flag the valid config, where only npm carries semver-*-days', () => {
    expect(detectDependabotCooldownViolations(VALID)).toEqual([])
  })

  it('flags semver-major-days under github-actions', () => {
    expect(detectDependabotCooldownViolations(BROKEN)).toEqual([
      { ecosystem: 'github-actions', property: 'semver-major-days' },
    ])
  })

  it('flags every offending key, not just the first', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: github-actions',
      '    cooldown:',
      '      default-days: 3',
      '      semver-major-days: 7',
      '      semver-minor-days: 3',
      '      semver-patch-days: 3',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml).map((v) => v.property)).toEqual([
      'semver-major-days',
      'semver-minor-days',
      'semver-patch-days',
    ])
  })

  it('ignores semver-*-days named in a comment inside a github-actions block', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: github-actions',
      '    # semver-major-days: 7 is rejected here — do not add it back',
      '    cooldown:',
      '      default-days: 3',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([])
  })

  it('does not attribute a later npm key to an earlier github-actions block', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: github-actions',
      '    cooldown:',
      '      default-days: 3',
      '  - package-ecosystem: npm',
      '    cooldown:',
      '      semver-major-days: 7',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([])
  })

  it('does not flag keys outside a cooldown mapping', () => {
    const yml = ['updates:', '  - package-ecosystem: github-actions', '    groups:', '      semver-major-days: 7'].join(
      '\n',
    )
    expect(detectDependabotCooldownViolations(yml)).toEqual([])
  })
})

describe('checkSecurity dependabot.yml status', () => {
  const original = process.cwd()
  let tmpDir: string

  function writeDependabot(content: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependabot-test-'))
    fs.mkdirSync(path.join(tmpDir, '.github'))
    fs.writeFileSync(path.join(tmpDir, '.github/dependabot.yml'), content)
    process.chdir(tmpDir)
  }

  function dependabotCheck() {
    return checkSecurity().checks.find((c) => c.name === 'dependabot.yml')
  }

  afterEach(() => {
    process.chdir(original)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes the valid config', () => {
    writeDependabot(VALID)
    expect(dependabotCheck()?.status).toBe('pass')
  })

  it('fails the config GitHub rejects, naming the property and the ecosystem', () => {
    writeDependabot(BROKEN)
    const check = dependabotCheck()
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('semver-major-days')
    expect(check?.detail).toContain('github-actions')
  })
})
