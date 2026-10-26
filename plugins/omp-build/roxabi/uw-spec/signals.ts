import { VALID_CLAIMS } from '../../skills/dev-review/roster-contract'

export function extractYamlBlocks(content: string): string[] {
  const blocks: string[] = []
  const re = /```ya?ml[^\n]*\n([\s\S]*?)```/gi
  let m = re.exec(content)
  while (m) {
    blocks.push(m[1].replace(/\r\n/g, '\n'))
    m = re.exec(content)
  }
  return blocks
}

export function parseClaimTags(yaml: string): string[] | null {
  const lines = yaml.split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*claim:\s*(.*)$/)
    if (!m) continue
    const raw = m[1].trim()
    if (!raw) return null
    if (raw.startsWith('[')) {
      const inner = raw.slice(1, raw.endsWith(']') ? -1 : undefined)
      const tags = inner
        .split(',')
        .map((t) =>
          t
            .trim()
            .replace(/^['"]|['"]$/g, '')
            .toLowerCase(),
        )
        .filter(Boolean)
      return tags.length ? tags : null
    }
    return [raw.replace(/^['"]|['"]$/g, '').toLowerCase()]
  }
  return null
}

export function validateClaimTags(tags: string[] | null): tags is string[] {
  if (!tags?.length) return false
  return tags.every((t) => Object.hasOwn(VALID_CLAIMS, t))
}

export function parsePricedFences(specContent: string): {
  claims: string[]
  pricedClaimOk: boolean
  hasPricedFence: boolean
} {
  const allClaims = new Set<string>()
  let hasPricedFence = false
  let pricedClaimOk = true

  for (const block of extractYamlBlocks(specContent)) {
    if (!/^\s*priced:/m.test(block)) continue
    hasPricedFence = true
    if (!/^\s*not:/m.test(block) || !/^\s*oracles:/m.test(block)) {
      pricedClaimOk = false
      continue
    }
    const tags = parseClaimTags(block)
    if (!validateClaimTags(tags)) {
      pricedClaimOk = false
      continue
    }
    for (const t of tags) allClaims.add(t)
  }

  return { claims: [...allClaims], pricedClaimOk, hasPricedFence }
}

export function specIsDraft(specContent: string): boolean {
  const fm = specContent.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return false
  const status = fm[1]
    .match(/^status:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
  return status === 'draft'
}
