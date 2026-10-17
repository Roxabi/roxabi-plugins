import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SKILL.md'), 'utf8')
const CREDENTIAL = 'not-a-real-credential-0001'

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
  if [ -n "$GH_VIEW_FILE" ]; then cat "$GH_VIEW_FILE"; exit 0; fi
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
  checkout?: { origin?: string; originUrl?: string; upstream?: string; pin?: string },
): { status: number | null; called: boolean; body: string; ghLog: string; setLog: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'complexity-recipe-'))
  if (checkout) {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
        stdio: 'pipe',
      })
    git('init', '-q')
    if (checkout.origin) git('remote', 'add', 'origin', `https://github.com/${checkout.origin}.git`)
    if (checkout.originUrl) git('remote', 'add', 'origin', checkout.originUrl)
    if (checkout.upstream) git('remote', 'add', 'upstream', `https://github.com/${checkout.upstream}.git`)
    if (checkout.pin) {
      mkdirSync(join(dir, '.dev'))
      writeFileSync(join(dir, '.dev', 'dev-core.yml'), `github_repo: ${checkout.pin}\n`)
    }
  }
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), GH)
  writeFileSync(join(bin, 'T'), SET)
  chmodSync(join(bin, 'gh'), 0o755)
  chmodSync(join(bin, 'T'), 0o755)
  const tLog = join(dir, 't.log')
  const ghLog = join(dir, 'gh.log')
  const bodyOut = join(dir, 'body.out')
  const viewFile = join(dir, 'view.body')
  const childEnv: Record<string, string> = { ...env }
  if (env.GH_VIEW_BODY !== undefined) {
    writeFileSync(viewFile, env.GH_VIEW_BODY)
    delete childEnv.GH_VIEW_BODY
    childEnv.GH_VIEW_FILE = viewFile
  }
  const proc = spawnSync('bash', ['-c', recipeSource(score)], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      RECIPE_GH_LOG: ghLog,
      RECIPE_T_LOG: tLog,
      RECIPE_BODY: bodyOut,
      GITHUB_REPO: 'Acme/app',
      ...childEnv,
    },
  })
  return {
    status: proc.status,
    called: existsSync(tLog),
    body: existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : '',
    ghLog: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    setLog: existsSync(tLog) ? readFileSync(tLog, 'utf8') : '',
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

  it('does not call set when the repo slug is empty', () => {
    const result = runRecipe({ GITHUB_REPO: '', GH_REPO_SLUG: '' })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).not.toContain('issue view')
  })

  it('replaces one marker and writes the same repo', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec\n<!-- complexity: 1 -->\nrest' })
    expect(result.status).toBe(0)
    expect(result.called).toBe(true)
    expect(result.ghLog).toContain('issue view 42 --repo Acme/app')
    expect(result.setLog).toContain('set Acme/app#42')
    expect(result.setLog).toContain('--body-file')
    expect(result.body.match(/<!-- complexity:/g)).toHaveLength(1)
    expect(result.body).toContain('<!-- complexity: 4 -->')
    expect(result.body).not.toContain('<!-- complexity: 1 -->')
    expect(result.body).toContain('spec')
  })

  it('replaces one marker when it sits at the start of a body larger than the pipe', () => {
    const filler = 'x'.repeat(200_000)
    const result = runRecipe({ GH_VIEW_BODY: `<!-- complexity: 1 -->\n${filler}` }, '9')
    expect(result.status).toBe(0)
    expect(result.body.match(/<!-- complexity:/g)).toHaveLength(1)
    expect(result.body).toContain('<!-- complexity: 9 -->')
    expect(result.body).toContain(filler)
  })

  it('does not call set when a matched marker is not a number', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec <!-- complexity: nope -->' })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
  })

  it('targets origin, not the repo gh repo view names, and never asks gh', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      origin: 'Acme/product',
      upstream: 'Kit/parent',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Acme/product')
    expect(result.ghLog).not.toContain('repo view')
    expect(result.setLog).toContain('set Acme/product#42')
  })

  it('falls back to gh repo view only when origin is absent', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      upstream: 'Elsewhere/other',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('repo view')
    expect(result.ghLog).toContain('issue view 42 --repo Kit/parent')
  })

  it('lets a dev-core.yml pin naming another repo win over origin', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      origin: 'Acme/product',
      pin: 'Pin/yaml',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Pin/yaml')
    expect(result.ghLog).not.toContain('repo view')
  })

  it('lets an exported GITHUB_REPO win over an origin remote and a gh repo view naming a third repo', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: 'Env/pinned', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      origin: 'Acme/product',
      upstream: 'Kit/parent',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Env/pinned')
    expect(result.ghLog).not.toContain('repo view')
    expect(result.ghLog).not.toContain('Acme/product')
    expect(result.setLog).toContain('set Env/pinned#42')
    expect(result.setLog).not.toContain('Acme/product')
  })

  it('normalises a trailing slash on origin instead of falling through to gh', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      originUrl: 'https://github.com/Acme/product/',
      upstream: 'Kit/parent',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Acme/product')
    expect(result.ghLog).not.toContain('repo view')
    expect(result.setLog).toContain('set Acme/product#42')
  })

  it('resolves a credentialed origin without leaking the credential to gh, T or stderr', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      originUrl: `https://x-access-token:${CREDENTIAL}@github.com/Acme/product/`,
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Acme/product')
    for (const seen of [result.ghLog, result.setLog, result.stderr]) expect(seen).not.toContain(CREDENTIAL)
  })

  it.each([
    ['an origin with no owner/repo path', `https://x-access-token:${CREDENTIAL}@github.com/`],
    ['a bare word', 'weird'],
    [
      'an origin whose repo segment is not a valid name',
      `https://x-access-token:${CREDENTIAL}@github.com/Acme/.github/`,
    ],
  ])('refuses %s before any gh call, and redacts the credential', (_label, originUrl) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      originUrl,
      upstream: 'Kit/parent',
    })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).toBe('')
    expect(result.stderr).toContain('GITHUB_REPO')
    expect(result.stderr).not.toContain(CREDENTIAL)
  })

  it.each([
    ['github scp', 'git@github.com:Acme/product.git'],
    ['github ssh url with a port', 'ssh://git@github.com:22/Acme/product.git'],
    ['an upper-case github host', 'https://GitHub.com/Acme/product'],
  ])('still resolves a %s origin without asking gh', (_label, originUrl) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Kit/parent' }, '4', {
      originUrl,
      upstream: 'Kit/parent',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Acme/product')
    expect(result.ghLog).not.toContain('repo view')
    expect(result.setLog).toContain('set Acme/product#42')
  })

  it.each([
    ['a gitlab scp origin', 'git@gitlab.com:Other/tracker.git'],
    ['a credentialed gitlab https origin', `https://x-access-token:${CREDENTIAL}@gitlab.com/Other/tracker.git`],
    ['a local path origin', '/srv/git/Other/tracker.git'],
    ['a file url origin', 'file:///srv/git/Other/tracker.git'],
    ['a host that only starts with github.com', 'https://github.com.example.net/Other/tracker.git'],
    ['a userinfo that spells github.com in front of another host', 'https://github.com@gitlab.com/Other/tracker.git'],
    ['a github origin with extra path segments', 'https://github.com/Other/tracker/tree/main'],
  ])('refuses %s before any gh call, and redacts the credential', (_label, originUrl) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: '', GH_REPO_SLUG: 'Acme/product' }, '4', {
      originUrl,
      upstream: 'Kit/parent',
    })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).toBe('')
    expect(result.stderr).toContain('GITHUB_REPO')
    expect(result.stderr).not.toContain(CREDENTIAL)
  })

  it('lets an exported GITHUB_REPO win over a gitlab origin', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: 'Env/pinned' }, '4', {
      originUrl: 'git@gitlab.com:Other/tracker.git',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('issue view 42 --repo Env/pinned')
    expect(result.setLog).toContain('set Env/pinned#42')
  })
})
