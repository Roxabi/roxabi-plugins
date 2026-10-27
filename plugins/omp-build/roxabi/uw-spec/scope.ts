/** Markdown headings outside fenced code. */
function headings(body: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^ {0,3}#{1,6}\s/.test(line)) out.push(line)
  }
  return out
}

/**
 * Framed enough to start unattended: a `size:` label, an acceptance/criteria
 * heading, and no heading containing "needs framing" (the §4 not-framed marker).
 */
export function hasScope(input: { labels: readonly string[]; body: string }): boolean {
  const titles = headings(input.body)
  return (
    input.labels.some((label) => label.startsWith('size:')) &&
    titles.some((title) => /acceptance|criteria/i.test(title)) &&
    !titles.some((title) => /needs framing/i.test(title))
  )
}
