import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REAL_BUN, recipeEnv, run, startGitHub } from './fixtures/github-api'
import {
  CREDENTIAL,
  GIT_ENV,
  invalidRepoYaml,
  PARENT,
  PRODUCT,
  type RepoFixtureOptions,
  refusedOrigins,
  repoFixture,
  supportedOrigins,
} from './fixtures/repo-identity'

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SKILL.md'), 'utf8')
const triage = join(import.meta.dirname, '../triage.ts')

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

const T = `#!/bin/sh
if [ "$1" = repo ]; then
  exec "$BUN" --no-env-file "$TRIAGE" "$@"
fi
printf '%s %s\\n' "$GITHUB_REPO" "$*" >> "$RECIPE_T_LOG"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--body-file" ]; then
    cp "$arg" "$RECIPE_BODY"
  fi
  prev=$arg
done
exit 0
`

function runRecipe(env: Record<string, string>, score = '4', options?: RepoFixtureOptions) {
  const { root, cwd, bin } = repoFixture(options)
  try {
    writeFileSync(join(bin, 'gh'), GH, { mode: 0o755 })
    writeFileSync(join(bin, 'T'), T, { mode: 0o755 })
    return runInFixture(root, cwd, bin, env, score)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runInFixture(dir: string, cwd: string, bin: string, env: Record<string, string>, score: string) {
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
    cwd,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: dir,
      ...GIT_ENV,
      BUN: REAL_BUN,
      TRIAGE: triage,
      GH_REPO_SLUG: PARENT,
      RECIPE_GH_LOG: ghLog,
      RECIPE_T_LOG: tLog,
      RECIPE_BODY: bodyOut,
      ...childEnv,
    },
  })
  return {
    status: proc.status,
    stderr: proc.stderr,
    called: existsSync(tLog),
    body: existsSync(bodyOut) ? readFileSync(bodyOut, 'utf8') : '',
    ghLog: existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '',
    setLog: existsSync(tLog) ? readFileSync(tLog, 'utf8') : '',
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
    const result = runRecipe({ GH_REPO_SLUG: '' }, '4', { origin: null })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).not.toContain('issue view')
  })

  it('replaces one marker and writes the same repo', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec\n<!-- complexity: 1 -->\nrest' })
    expect(result.status).toBe(0)
    expect(result.called).toBe(true)
    expect(result.ghLog).toContain(`issue view 42 --repo github.com/${PRODUCT}`)
    expect(result.setLog).toContain(`${PRODUCT} set ${PRODUCT}#42`)
    expect(result.setLog).toContain('--body-file')
    expect(result.body.match(/<!-- complexity:/g)).toHaveLength(1)
    expect(result.body).toContain('<!-- complexity: 4 -->')
    expect(result.body).not.toContain('<!-- complexity: 1 -->')
    expect(result.body).toContain('spec')
  })

  it('reads from github.com and updates its public issue even with an enterprise GH_HOST', async () => {
    const { root, cwd, bin } = repoFixture()
    try {
      const github = await startGitHub(root, [`${PRODUCT}#42`])
      try {
        const log = join(root, 'gh.log')
        const publicAuth = 'public-fixture-token'
        writeFileSync(
          join(bin, 'gh'),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$RECIPE_GH_LOG"
if [ "$1 $2" = 'auth token' ]; then
  [ "$*" = 'auth token --hostname github.com' ] || exit 95
  echo '${publicAuth}'
  exit 0
fi
[ "$1 $2 $3" = 'issue view 42' ] || exit 94
if [ "$4 $5" = '--repo github.com/${PRODUCT}' ]; then
  echo 'public body'
else
  echo 'enterprise body'
fi
`,
          { mode: 0o755 },
        )
        writeFileSync(join(bin, 'T'), '#!/bin/sh\nexec "$BUN" --no-env-file "$TRIAGE" "$@"\n', { mode: 0o755 })
        const env = recipeEnv(github, bin, {
          BUN: REAL_BUN,
          GH_HOST: 'enterprise.example',
          RECIPE_GH_LOG: log,
          TRIAGE: triage,
        })
        delete env.GITHUB_TOKEN
        const result = await run(recipeSource(), cwd, env)
        expect(result.code, result.stderr).toBe(0)
        expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([
          `issue view 42 --repo github.com/${PRODUCT} --json body --jq .body`,
          'auth token --hostname github.com',
        ])
        expect(github.issues.get(`${PRODUCT}#42`)?.body).toBe('public body\n\n<!-- complexity: 4 -->\n')
        expect(github.calls).toMatchObject([
          { method: 'PATCH', path: `/repos/${PRODUCT}/issues/42`, authorization: ['Bearer', publicAuth].join(' ') },
        ])
      } finally {
        await github.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it.each(invalidRepoYaml)('refuses an invalid project YAML %s before issue reads or writes', (_name, yaml) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec' }, '4', { yaml })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('.dev/dev-core.yml')
    expect(result.ghLog).toBe('')
    expect(result.called).toBe(false)
  })

  it.each(supportedOrigins)('uses %s for both read and write without probing gh repo view', (_name, origin) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec' }, '4', { origin })
    expect(result.status).toBe(0)
    expect(result.ghLog.trim()).toBe(`issue view 42 --repo github.com/${PRODUCT} --json body --jq .body`)
    expect(result.setLog).toContain(`${PRODUCT} set ${PRODUCT}#42`)
    expect(result.stderr).toBe('')
  })

  it('keeps origin spelling for both read and write when only case differs from gh', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GH_REPO_SLUG: PRODUCT }, '4', {
      origin: 'https://github.com/acme/product.git',
    })
    expect(result.status).toBe(0)
    expect(result.ghLog.trim()).toBe('issue view 42 --repo github.com/acme/product --json body --jq .body')
    expect(result.setLog).toContain('acme/product set acme/product#42')
    expect(result.stderr).toBe('')
  })

  it.each(refusedOrigins)('refuses %s without reading, writing, or exposing credentials', (_name, origin) => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec' }, '4', { origin })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).toBe('')
    expect(result.stderr).toContain('Cannot use git remote "origin"')
    expect(result.stderr).not.toContain(CREDENTIAL)
  })

  it('falls back to gh only if origin is absent, keeping the same read and write target', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec' }, '4', { origin: null })
    expect(result.status).toBe(0)
    expect(result.ghLog).toContain('repo view')
    expect(result.ghLog).toContain(`issue view 42 --repo github.com/${PARENT}`)
    expect(result.setLog).toContain(`${PARENT} set ${PARENT}#42`)
  })

  it.each([`https://github.com/${PRODUCT}.git`, 'git@gitlab.com:acme/product.git'])(
    'honors the yaml pin over %s, and the env pin over both',
    (origin) => {
      const options = { origin, yamlPin: 'Pin/yaml' }
      const yaml = runRecipe({ GH_VIEW_BODY: 'spec' }, '4', options)
      expect(yaml.status).toBe(0)
      expect(yaml.ghLog).not.toContain('repo view')
      expect(yaml.ghLog).toContain('issue view 42 --repo github.com/Pin/yaml')
      expect(yaml.setLog).toContain('Pin/yaml set Pin/yaml#42')
      const env = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: 'Pin/env' }, '4', options)
      expect(env.status).toBe(0)
      expect(env.ghLog).not.toContain('repo view')
      expect(env.ghLog).toContain('issue view 42 --repo github.com/Pin/env')
      expect(env.setLog).toContain('Pin/env set Pin/env#42')
    },
  )

  it('rejects an invalid pin rather than reading or updating a different tracker', () => {
    const result = runRecipe({ GH_VIEW_BODY: 'spec', GITHUB_REPO: 'not-a-slug' }, '4', { yamlPin: 'Pin/yaml' })
    expect(result.status).not.toBe(0)
    expect(result.called).toBe(false)
    expect(result.ghLog).toBe('')
    expect(result.stderr).toContain('Invalid GitHub repo pin')
  })
})
