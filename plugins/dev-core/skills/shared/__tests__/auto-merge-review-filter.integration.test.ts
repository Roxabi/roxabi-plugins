import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { generateAutoMergeYml } from '../workflows/workflow-generators'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const ME = 'omp-bot'

function reviewRecord(verdict: string, sha: string, extra = ''): string {
  return [
    '<!-- omp-build:code-review -->',
    `<!-- omp-build:review-head sha=${sha} -->`,
    '## Code Review',
    extra,
    `**Verdict: ${verdict}**`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function reviewFilter(yml: string): string {
  const marker = 'jq -r --arg reviewer "$REVIEWER" --arg head "$HEAD_SHA" \''
  const start = yml.indexOf(marker)
  if (start < 0) throw new Error('auto-merge review filter is not in the generated workflow')
  const open = start + marker.length
  const close = yml.indexOf("')", open)
  if (close < 0) throw new Error('auto-merge review filter is not closed')
  return yml.slice(open, close)
}

function runReviewFilter(comments: Array<{ author: string; body: string }>, head = HEAD): string {
  const payload = JSON.stringify({
    comments: comments.map((comment) => ({ author: { login: comment.author }, body: comment.body })),
  })
  const proc = spawnSync(
    'jq',
    ['-r', '--arg', 'reviewer', ME, '--arg', 'head', head, reviewFilter(generateAutoMergeYml())],
    { input: payload, encoding: 'utf8' },
  )
  if (proc.status !== 0) throw new Error(proc.stderr || 'jq failed')
  return proc.stdout.trim()
}

describe('fleet auto-merge review filter', () => {
  it('enables the latest Approve of this head, including a trailing summary', () => {
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve (clean)', HEAD) }])).toBe(HEAD)
    expect(
      runReviewFilter([
        {
          author: ME,
          body: reviewRecord('Approve (clean)', HEAD).replace(
            '**Verdict: Approve (clean)**',
            '**Verdict: Approve (clean)** — summary',
          ),
        },
      ]),
    ).toBe(HEAD)
    expect(
      runReviewFilter([
        { author: ME, body: '## Review Fixes Applied\n\n**Applied:** 1' },
        { author: ME, body: reviewRecord('Approve with comments', HEAD) },
      ]),
    ).toBe(HEAD)
  })

  it('a newer Request changes of the same head suppresses an older Approve', () => {
    expect(
      runReviewFilter([
        { author: ME, body: reviewRecord('Approve', HEAD) },
        { author: ME, body: reviewRecord('Request changes', HEAD) },
      ]),
    ).toBe('')
  })

  it('a newer Request changes of another head suppresses an older Approve', () => {
    expect(
      runReviewFilter([
        { author: ME, body: reviewRecord('Approve', HEAD) },
        { author: ME, body: reviewRecord('Request changes', OTHER) },
      ]),
    ).toBe('')
  })

  it('a body that contains both verdicts does not enable', () => {
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Request changes', HEAD, '**Verdict: Approve**') }])).toBe(
      '',
    )
  })

  it('an unanchored Approve prefix is not a verdict', () => {
    expect(
      runReviewFilter([
        {
          author: ME,
          body: reviewRecord('Approve', HEAD).replace('**Verdict: Approve**', '**Verdict: Approve**not'),
        },
      ]),
    ).toBe('')
  })

  it('ignores a label actor and a malformed line 2', () => {
    expect(runReviewFilter([{ author: 'label-actor', body: reviewRecord('Approve', HEAD) }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve', HEAD.slice(0, 39)) }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve', `${HEAD}a`) }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve', HEAD.toUpperCase()) }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: `note\n${reviewRecord('Approve', HEAD)}` }])).toBe('')
  })

  it('rejects an equal-head record whose line 2 or verdict is not anchored', () => {
    const headLine = `<!-- omp-build:review-head sha=${HEAD} -->`
    const prefixed = ['<!-- omp-build:code-review -->', `note ${headLine}`, '**Verdict: Approve**'].join('\n')
    const trailing = ['<!-- omp-build:code-review -->', `${headLine} trailing`, '**Verdict: Approve**'].join('\n')
    const otherFirst = ['not the marker', headLine, '**Verdict: Approve**'].join('\n')
    const looseVerdict = ['<!-- omp-build:code-review -->', headLine, '**Verdict: Approve**not'].join('\n')
    expect(runReviewFilter([{ author: ME, body: prefixed }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: trailing }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: otherFirst }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: looseVerdict }])).toBe('')
    expect(reviewFilter(generateAutoMergeYml())).toContain('[0-9a-f]{40}')
  })

  it('refuses an Approve of a different head', () => {
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve', OTHER) }])).toBe('')
    expect(runReviewFilter([{ author: ME, body: reviewRecord('Approve', HEAD) }])).toBe(HEAD)
  })

  it('a Request changes on a later page suppresses an Approve on the first page', () => {
    const yml = generateAutoMergeYml()
    expect(yml).toContain('gh api --paginate --slurp')
    expect(yml).not.toContain('gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json comments')
    const marker = "jq -c '"
    const open = yml.indexOf(marker)
    if (open < 0) throw new Error('comment reshape is not in the generated workflow')
    const reshape = yml.slice(open + marker.length, yml.indexOf("')", open))
    const pages = JSON.stringify([
      [{ user: { login: ME }, body: reviewRecord('Approve', HEAD), created_at: '2026-01-01T00:00:00Z' }],
      [{ user: { login: ME }, body: reviewRecord('Request changes', HEAD), created_at: '2026-01-01T00:00:01Z' }],
    ])
    const shaped = spawnSync('jq', ['-c', reshape], { input: pages, encoding: 'utf8' })
    if (shaped.status !== 0) throw new Error(shaped.stderr || 'reshape failed')
    expect(JSON.parse(shaped.stdout).comments.at(-1).body).toContain('Request changes')
    expect(
      runReviewFilter([
        { author: ME, body: reviewRecord('Approve', HEAD) },
        { author: ME, body: reviewRecord('Request changes', HEAD) },
      ]),
    ).toBe('')
  })

  it('a non-array page refuses to reshape', () => {
    const yml = generateAutoMergeYml()
    const marker = "jq -c '"
    const open = yml.indexOf(marker)
    if (open < 0) throw new Error('comment reshape is not in the generated workflow')
    const reshape = yml.slice(open + marker.length, yml.indexOf("')", open))
    const pages = JSON.stringify([
      [{ user: { login: ME }, body: reviewRecord('Approve', HEAD), created_at: '2026-01-01T00:00:00Z' }],
      {},
    ])
    const shaped = spawnSync('jq', ['-c', reshape], { input: pages, encoding: 'utf8' })
    expect(shaped.status).not.toBe(0)
    expect(shaped.stderr).toContain('incomplete comment pages')
  })
})
