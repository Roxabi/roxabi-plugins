import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `analyze-branches.sh` quotes carefully, but it is not the layer that deletes.
 * The executed layer is this Markdown body: the agent reads a command template,
 * substitutes `<branch>` / `<path>`, and runs it. Nothing between the analyser
 * and that substitution constrains the charset — a refname carries whatever a PR
 * author typed — so the quoting has to be in the template a reader copies.
 */
const SKILL = readFileSync(path.resolve(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

/** Every fenced bash line that runs a deletion, with its placeholders. */
const DELETION_LINES = SKILL.split('\n').filter((line) =>
  /^\s*(git\s+(branch\s+-[dD]|push\s+\S+\s+--delete|worktree\s+remove)|rm\s+-rf|rmdir)\b/.test(line),
)

describe('executed deletion templates', () => {
  it('has one for each command the body claims to run', () => {
    // The set is spelled out so a template that disappears (or is renamed into a
    // shape the filter above misses) fails here instead of silently emptying the
    // corpus every other assertion iterates over.
    for (const verb of [
      /git branch -d /,
      /git branch -D /,
      /git push origin --delete/,
      /git worktree remove/,
      /rm -rf/,
    ]) {
      expect(DELETION_LINES.some((line) => verb.test(line))).toBe(true)
    }
  })

  it('passes every placeholder as a value: quoted, after `--`', () => {
    const unquoted = DELETION_LINES.filter((line) => /<[a-z-]+>/.test(line)).filter(
      (line) => !/--\s+"<[a-z-]+>"/.test(line),
    )
    // `rmdir -- "<path>" 2>/dev/null || rm -rf -- "<path>"` is one line carrying
    // two templates; each half must satisfy the rule, hence the filter runs on
    // the whole line and the failure prints it verbatim.
    expect(unquoted).toEqual([])
  })

  it('says the placeholder is a value, where the operator substitutes it', () => {
    // Quoting that nobody explains gets "simplified" by the next editor.
    expect(SKILL).toMatch(/is a value, never a fragment/)
  })
})

describe('the deletion enumeration', () => {
  it('names all three deletion sites, including the remote one', () => {
    // An enumeration that stops at Step 5 describes the deletion git can refuse
    // and omits the one it cannot: `git push origin --delete` has no unmerged
    // check and leaves no copy.
    const section = /## Where deletion happens[\s\S]*?\n## /.exec(SKILL)?.[0]
    expect(section, 'deletion enumeration section').toBeDefined()
    expect(section).toMatch(/\| 5 \|/)
    expect(section).toMatch(/5b-execute/)
    expect(section).toMatch(/\| 6e \|/)
    expect(section).toMatch(/git push origin --delete/)
  })

  it('records that only the local delete has a git-side backstop', () => {
    expect(SKILL).toMatch(/nothing refuses `push --delete`/)
  })
})

describe('--report-only', () => {
  it('reaches the analyser with --no-fetch, and says why', () => {
    // "zero mutations (cron-safe)" is refuted by the analyser's default
    // `git fetch --prune origin`, which writes refs/remotes/*.
    const step2 = /### 2\. Analyze Branches[\s\S]*?\n### /.exec(SKILL)?.[0]
    expect(step2, 'Step 2 section').toBeDefined()
    expect(step2).toMatch(/REPORT_ONLY.*=.*true.*--no-fetch/)
    expect(step2).toMatch(/stale/)
    for (const invocation of step2?.match(/bash skill:\/\/cleanup\/analyze-branches\.sh.*/g) ?? []) {
      expect(invocation).toContain('$FETCH_ARG')
    }
  })
})
