import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const skill = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')
const extraction = /^(CHANGELOG_SOURCE=\$\(git show [\s\S]*?^NOTES_HEADING=.*)$/m.exec(skill)?.[1]
const publish = /^\s*create-release\)\s*(.*?)\s*;;$/m.exec(skill)?.[1]
if (!extraction || !publish) throw new Error('Finalize notes extraction or release command missing from SKILL.md')

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function runNotes(changelog: string) {
  root = mkdtempSync(path.join(tmpdir(), 'omp-finalize-notes-'))
  const repo = root
  const bin = path.join(repo, 'bin')
  const technical = 'docs/technical changelog.md'
  const notes = path.join(repo, 'published-notes')
  mkdirSync(path.join(repo, 'docs'))
  mkdirSync(bin)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, {
    HOME: repo,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'author@example.com',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'author@example.com',
    PATH: `${bin}:${process.env.PATH}`,
    NOTES_FILE: notes,
  })
  function git(...args: string[]) {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q')
  writeFileSync(path.join(repo, technical), changelog)
  // A root changelog exists at M but is not the discovered technical surface.
  writeFileSync(path.join(repo, 'CHANGELOG.md'), '## [1.2.3]\n\nWrong root surface\n')
  git('add', '--', technical, 'CHANGELOG.md')
  git('commit', '-qm', 'promotion')
  const merge = git('rev-parse', 'HEAD')
  writeFileSync(path.join(repo, technical), '## [1.2.3]\n\nWrong later commit\n')
  git('add', '--', technical)
  git('commit', '-qm', 'later commit')
  writeFileSync(path.join(repo, technical), '## [1.2.3]\n\nWrong working tree\n')
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
set -eu
[ "$1" = release ] && [ "$2" = create ]
shift 2
while [ "$#" -gt 0 ]; do
  if [ "$1" = --notes ]; then printf '%s' "$2" > "$NOTES_FILE"; exit 0; fi
  shift
done
exit 1
`,
    { mode: 0o755 },
  )
  const script = `set -eu
M=${JSON.stringify(merge)}
TECHNICAL_CHANGELOG=${JSON.stringify(technical)}
VERSION=kit/v1.2.3
DERIVED=1.2.3
${extraction}
${publish}
`
  const result = spawnSync('bash', ['-c', script], { cwd: repo, env, encoding: 'utf8' })
  return { result, notes: existsSync(notes) ? readFileSync(notes, 'utf8') : undefined }
}

describe('promote finalize release notes', () => {
  it.each([
    ['component', '[kit/v1.2.3]'],
    ['bare', '[1.2.3]'],
    ['v-prefixed', '[v1.2.3]'],
    ['unbracketed component', 'kit/v1.2.3'],
    ['release-please link', '[1.2.3](https://example.com/compare/v1.2.2...v1.2.3)'],
  ])('publishes only the merged %s section', (_format, heading) => {
    const selected = `## ${heading} - 2026-01-02\n\n### Features\n\n* Delivered change`
    const { result, notes } = runNotes(
      `# Changelog\n\n## Unreleased\n\n* Future change\n\n${selected}\n\n## [1.2.2]\n\n* Old change\n`,
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(notes).toBe(selected)
  })

  it.each([
    ['missing target', '## [1.2.2]\n\n* Old change'],
    ['empty target', '## [1.2.3]\n\n   \n\n## [1.2.2]\n\n* Old change'],
    ['duplicate aliases', '## [kit/v1.2.3]\n\n* First\n\n## [v1.2.3]\n\n* Second'],
    ['wrong version suffix', '## [1.2.3-rc.1]\n\n* Prerelease only'],
  ])('refuses %s before publishing', (_scenario, changelog) => {
    const { result, notes } = runNotes(`# Changelog\n\n## Unreleased\n\n* Future change\n\n${changelog}\n`)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('REFUSE')
    expect(notes).toBeUndefined()
  })
})
