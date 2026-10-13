import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findFloatingWorkflowPins, findInlinePins, parseInlinePins } from '../verify-action-pins'

describe('parseInlinePins', () => {
  it('parses unquoted workflow action references', () => {
    expect(parseInlinePins('uses: actions/checkout@v7\n')).toEqual([{ action: 'actions/checkout', ref: 'v7' }])
  })

  it.each(['uses: "actions/checkout@v7"\n', "uses: 'actions/checkout@v7'\n"])(
    'parses quoted floating references',
    (source) => {
      expect(parseInlinePins(source)).toEqual([{ action: 'actions/checkout', ref: 'v7' }])
    },
  )

  it('does not treat local or expression-based uses values as third-party actions', () => {
    expect(parseInlinePins('uses: ./local-action\nuses: ${{ inputs.action }}\n')).toEqual([])
  })
})

describe('findInlinePins', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const fixtureRelPath = 'tools/__tests__/.tmp-inline-pins-fixture.yml'
  const fixtureAbsPath = path.join(repoRoot, fixtureRelPath)

  afterEach(() => fs.rmSync(fixtureAbsPath, { force: true }))

  it('attaches the relative file path to each action reference', () => {
    fs.writeFileSync(fixtureAbsPath, 'uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n')
    expect(findInlinePins([fixtureRelPath])).toEqual([
      { file: fixtureRelPath, action: 'actions/checkout', ref: '0123456789abcdef0123456789abcdef01234567' },
    ])
  })
})

describe('findFloatingWorkflowPins', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const dirRel = 'tools/__tests__/.tmp-floating-fixture'
  const dirAbs = path.join(repoRoot, dirRel)

  afterEach(() => fs.rmSync(dirAbs, { recursive: true, force: true }))

  it.each([
    ['unquoted.yml', 'uses: actions/checkout@v7\n'],
    ['double-quoted.yml', 'uses: "actions/checkout@v7"\n'],
    ['single-quoted.yml', "uses: 'actions/checkout@v7'\n"],
  ])('rejects a %s floating pin', (name, source) => {
    fs.mkdirSync(dirAbs, { recursive: true })
    fs.writeFileSync(path.join(dirAbs, name), source)
    expect(findFloatingWorkflowPins(dirRel)).toEqual([
      { file: `${dirRel}/${name}`, action: 'actions/checkout', ref: 'v7' },
    ])
  })

  it('accepts an equivalent quoted or unquoted 40-hex SHA pin', () => {
    fs.mkdirSync(dirAbs, { recursive: true })
    const sha = '0123456789abcdef0123456789abcdef01234567'
    fs.writeFileSync(
      path.join(dirAbs, 'pins.yml'),
      `uses: actions/checkout@${sha}\nuses: "actions/checkout@${sha}"\nuses: 'actions/checkout@${sha}'\n`,
    )
    expect(findFloatingWorkflowPins(dirRel)).toEqual([])
  })
})
