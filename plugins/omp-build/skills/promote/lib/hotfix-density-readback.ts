import { type AnchorSource, type Commit, type Deps, parseCommits } from './hotfix-density-domain'

export type Anchor = { anchorDate: string; anchorSource: AnchorSource; anchorWarn?: string }

const FALLBACK_WARNING = 'No release tag or promotion merge found — using 30-day window (may be inaccurate)'

function fallbackAnchor(): Anchor {
  return {
    anchorDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    anchorSource: 'fallback-30d',
    anchorWarn: FALLBACK_WARNING,
  }
}

function anchorFromTagOutput(output: string): Anchor | null {
  for (const line of output.split('\n').filter(Boolean)) {
    const [tagName, ...dateParts] = line.trim().split(' ')
    if (!/^(?:.+\/)?v\d+\.\d+\.\d+/.test(tagName)) continue
    const anchorDate = dateParts.join(' ')
    if (anchorDate) return { anchorDate, anchorSource: 'tag' }
  }
  return null
}

function anchorFromPromotionOutput(output: string): Anchor | null {
  const parts = output.trim().split(' ')
  return parts.length >= 3 ? { anchorDate: parts.slice(1).join(' '), anchorSource: 'promotion-merge' } : null
}

export async function resolveAnchor(cwd: string | undefined, deps: Pick<Deps, 'run'>): Promise<Anchor> {
  try {
    const output = await deps.run(
      ['git', 'tag', '--list', '--sort=-creatordate', '--format=%(refname:short) %(creatordate:iso-strict)'],
      cwd,
    )
    const anchor = anchorFromTagOutput(output)
    if (anchor) return anchor
  } catch {
    // Fall through to the promotion merge.
  }

  try {
    const output = await deps.run(
      ['git', 'log', 'main', '--merges', '--format=%H %ai', '--grep=chore: promote staging to main', '-1'],
      cwd,
    )
    const anchor = anchorFromPromotionOutput(output)
    if (anchor) return anchor
  } catch {
    // Fall through to the bounded fallback.
  }
  return fallbackAnchor()
}

export async function listCommitsSince(
  anchorDate: string,
  cwd: string | undefined,
  deps: Pick<Deps, 'run'>,
): Promise<Commit[]> {
  try {
    const output = await deps.run(['git', 'log', 'main..staging', `--after=${anchorDate}`, '--format=%H\t%s'], cwd)
    return parseCommits(output)
  } catch {
    return []
  }
}

export async function fetchHotfixPrShas(anchorDate: string, deps: Pick<Deps, 'run'>): Promise<Set<string>> {
  try {
    const output = await deps.run([
      'gh',
      'pr',
      'list',
      '--state',
      'merged',
      '--search',
      `label:hotfix merged:>=${anchorDate.slice(0, 10)}`,
      '--json',
      'mergeCommit',
      '--jq',
      '.[].mergeCommit.oid',
    ])
    return new Set(
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim()),
    )
  } catch {
    return new Set()
  }
}
