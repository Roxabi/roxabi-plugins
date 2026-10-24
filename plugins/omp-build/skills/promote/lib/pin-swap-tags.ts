import type { Deps } from './pin-swap-contract'

function parseVersion(tag: string): [number, number, number] {
  const match = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
}

function compareSemver(a: string, b: string): number {
  const [a1, a2, a3] = parseVersion(a)
  const [b1, b2, b3] = parseVersion(b)
  return a1 - b1 || a2 - b2 || a3 - b3
}

function tagsAtSha(output: string, sha: string): string[] {
  const tagToShas = new Map<string, Set<string>>()
  for (const line of output.split('\n').filter(Boolean)) {
    const [lineSha = '', ref = ''] = line.split('\t')
    const tagMatch = ref.trim().match(/^refs\/tags\/(.+?)(\^\{\})?$/)
    if (!tagMatch) continue
    const tagName = tagMatch[1]
    const shas = tagToShas.get(tagName) ?? new Set<string>()
    shas.add(lineSha.trim())
    tagToShas.set(tagName, shas)
  }
  return [...tagToShas]
    .filter(([, shas]) => shas.has(sha))
    .map(([tagName]) => tagName)
    .filter((tagName) => /v\d+\.\d+\.\d+/.test(tagName))
}

export async function resolveTagAtSha(
  gitUrl: string,
  sha: string,
  pkgName: string,
  deps: Pick<Deps, 'run'>,
): Promise<string | null> {
  let output: string
  try {
    output = await deps.run(['git', 'ls-remote', '--tags', gitUrl])
  } catch (err) {
    throw new Error(`Failed to query ${gitUrl} for tags at ${sha}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!output) return null

  const matchingTags = tagsAtSha(output, sha)
  if (matchingTags.length === 0) return null
  const normalizedPkg = pkgName.replace(/_/g, '-').toLowerCase()
  const monorepoMatch = matchingTags.find((tag) => tag.toLowerCase().startsWith(`${normalizedPkg}/`))
  return monorepoMatch ?? [...matchingTags].sort(compareSemver).reverse()[0] ?? null
}
