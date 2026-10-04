import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SKILL.md'), 'utf8')

function recipeSource(score = '4', n = '42'): string {
  const start = skill.indexOf('## Complexity Scoring')
  const end = skill.indexOf('## Example Workflow')
  const section = skill.slice(start, end)
  const fenced = section.match(/```bash\n([\s\S]*?)```/)
  if (!fenced) throw new Error('complexity recipe fence missing')
  return fenced[1].replace('N=<number>', `N=${n}`).replace('SCORE=<score>', `SCORE=${score}`)
}

const GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$RECIPE_GH_LOG"
if [ "$1" = "issue" ]; then
  if [ -n "$GH_VIEW_EXIT" ]; then exit "$GH_VIEW_EXIT"; fi
  printf '%s' "$GH_VIEW_BODY"
  exit 0
fi
if [ "$1" = "repo" ]; then
  printf '%s' "$GH_REPO_SLUG"
  exit 0
fi
exit 0
`

const SET = `#!/bin/sh
printf '%s\\n' "$*" >> "$RECIPE_T_LOG"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--body-file" ]; then
    cp "$arg" "$RECIPE_BODY"
  fi
  prev=$arg
done
exit 0
`

function runRecipe(
  env: Record<string, string>,
  score = '4',
): { status: number | null; called: boolean; body: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'complexity-recipe-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), GH)
  writeFileSync(join(bin, 'T'), SET)
  chmodSync(join(bin, 'gh'), 0o755)
  chmodSync(join(bin, 'T'), 0o755)
  const tLog = join(dir, 't.log')
  const bodyOut = join(dir, 'body.out')
  const proc = spawnSync('bash', ['-c', recipeSource(score)], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      RECIPE_GH_LOG: join(dir, 'gh.log'),
      RECIPE_T_LOG: tLog,
      RECIPE_BODY: bodyOut,
      GITHUB_REPO: 'Acme/app',
      ...env,
    },
  })
  return {
    status: proc.status,
    called: existsSync(tLog),
    body: existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : '',
    stderr: proc.stderr,
  }
}

describe('complexity scoring recipe', () => {
  it('does not call set when the read fails, is null, or is empty', () => {
    const failed = runRecipe({ GH_VIEW_EXIT: '1' })
    expect(failed.status).not.toBe(0)
    expect(failed.called).toBe(false)

    const missing = runRecipe({ GH_VIEW_BODY: 'null' })
    expect(missing.status).not.toBe(0)
    expect(missing.called).toBe(false)

    const empty = runRecipe({ GH_VIEW_BODY: '  \n' })
    expect(empty.status).not.toBe(0)
    expect(empty.called).toBe(false)
  })

  it('replaces one marker and writes the same repo', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec\n<!-- complexity: 1 -->\nrest' })
    expect(result.status).toBe(0)
    expect(result.called).toBe(true)
    expect(result.body.match(/<!-- complexity:/g)).toHaveLength(1)
    expect(result.body).toContain('<!-- complexity: 4 -->')
    expect(result.body).not.toContain('<!-- complexity: 1 -->')
    expect(result.body).toContain('spec')
  })
})
