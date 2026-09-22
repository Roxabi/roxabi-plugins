import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSecurity, detectDependabotCooldownViolations, SEMVER_COOLDOWN_UNSUPPORTED } from '../doctor-local'

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

  it('flags a quoted semver key (`"semver-major-days":`)', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: bazel',
      '    cooldown:',
      '      default-days: 3',
      '      "semver-major-days": 7',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([{ ecosystem: 'bazel', property: 'semver-major-days' }])
  })

  it('flags a quoted package-ecosystem value', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: "docker"',
      '    cooldown:',
      '      default-days: 3',
      '      semver-major-days: 7',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([{ ecosystem: 'docker', property: 'semver-major-days' }])
  })

  it('flags an item where package-ecosystem is NOT the first key (F5 — key order is free)', () => {
    const yml = [
      'updates:',
      '  - directory: /',
      '    package-ecosystem: docker',
      '    cooldown:',
      '      default-days: 3',
      '      semver-major-days: 7',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([{ ecosystem: 'docker', property: 'semver-major-days' }])
  })

  it('flags a quoted package-ecosystem KEY (`- "package-ecosystem": docker`) (F11)', () => {
    const yml = [
      'updates:',
      '  - "package-ecosystem": docker',
      '    cooldown:',
      '      default-days: 3',
      '      semver-major-days: 7',
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([{ ecosystem: 'docker', property: 'semver-major-days' }])
  })

  it('does not fold a later item’s cooldown into an earlier item when the first key is not package-ecosystem', () => {
    const yml = [
      'updates:',
      '  - package-ecosystem: github-actions',
      '    cooldown:',
      '      default-days: 3',
      '  - directory: /',
      '    package-ecosystem: npm',
      '    cooldown:',
      '      semver-major-days: 7',
    ].join('\n')
    // npm supports semver-*-days → the github-actions block must not absorb the npm key.
    expect(detectDependabotCooldownViolations(yml)).toEqual([])
  })

  // The default-days-only ecosystems, per the Dependabot options reference (2026-07-17).
  // Widening SEMVER_COOLDOWN_UNSUPPORTED beyond github-actions must actually fire for each —
  // this table is the anchor: reverting the Set to just github-actions fails every row but one.
  // Independent literal, NOT derived from the production Set — otherwise shrinking the Set
  // would just drop rows instead of failing them. Drift is instead caught by the equality
  // assertion below.
  const DEFAULT_DAYS_ONLY = [
    'bazel',
    'devcontainers',
    'docker',
    'docker-compose',
    'github-actions',
    'gitsubmodule',
    'helm',
    'nix',
    'opentofu',
    'pre-commit',
    'terraform',
    'vcpkg',
  ]

  it('matches the production SEMVER_COOLDOWN_UNSUPPORTED set exactly', () => {
    expect(new Set(DEFAULT_DAYS_ONLY)).toEqual(SEMVER_COOLDOWN_UNSUPPORTED)
  })

  // Cross-product over every semver-*-days key, not just semver-major-days — otherwise
  // dropping minor|patch from SEMVER_COOLDOWN_KEY would leave these rows green.
  const SEMVER_COOLDOWN_KEYS = ['semver-major-days', 'semver-minor-days', 'semver-patch-days']

  const DEFAULT_DAYS_ONLY_X_KEYS = DEFAULT_DAYS_ONLY.flatMap((ecosystem) =>
    SEMVER_COOLDOWN_KEYS.map((property) => ({ ecosystem, property })),
  )

  it.each(DEFAULT_DAYS_ONLY_X_KEYS)('flags $property under $ecosystem', ({ ecosystem, property }) => {
    const yml = [
      'updates:',
      `  - package-ecosystem: ${ecosystem}`,
      '    cooldown:',
      '      default-days: 3',
      `      ${property}: 7`,
    ].join('\n')
    expect(detectDependabotCooldownViolations(yml)).toEqual([{ ecosystem, property }])
  })

  // The false-positive boundary: these DO support semver-*-days, so flagging them is the
  // exact failure this check must never produce. If GitHub's table changes, this fails loudly.
  const SEMVER_SUPPORTED = ['npm', 'gomod', 'cargo', 'pip', 'uv', 'bun', 'maven', 'gradle', 'nuget', 'bundler']

  it.each(SEMVER_SUPPORTED)('does not flag semver-major-days under %s (semver is valid there)', (ecosystem) => {
    const yml = [
      'updates:',
      `  - package-ecosystem: ${ecosystem}`,
      '    cooldown:',
      '      default-days: 3',
      '      semver-major-days: 7',
    ].join('\n')
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
