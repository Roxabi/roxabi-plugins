/**
 * Render a product-written pull-request body.
 *
 * A closing keyword followed only by a colon, whitespace, or newlines and then
 * a recognized issue or pull reference is replaced by `References`. Every other
 * byte stays, including indentation, the reference, and surrounding prose.
 * One replaced keyword neutralizes a following reference list. `References` is
 * not a closing keyword. featurePullBody also names the UW being bound as
 * `UW #N`. That line is not a closing keyword and is not the workflow-binding
 * record. Git commits and already-open manual PR bodies are not rewritten.
 */
import { readFileSync } from 'node:fs'

const KEYWORD_RE = /\b(?:closed|closes|close|fixes|fixed|fix|resolved|resolves|resolve)\b/gi
const REF_AFTER_RE =
  /^:?\s*(?:#\d+\b|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b|https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+\b)/i

export function generatedPullBody(body) {
  const text = typeof body === 'string' ? body : ''
  return text.replace(KEYWORD_RE, (keyword, offset, source) =>
    REF_AFTER_RE.test(source.slice(offset + keyword.length)) ? 'References' : keyword,
  )
}

/** Neutral reference to the UW openPr is binding. Not a closing keyword and not the binding record. */
export function featurePullBody(body, issue) {
  const text = generatedPullBody(body)
  if (!Number.isInteger(issue) || issue <= 0) return text
  const reference = `UW #${issue}`
  if (text.split(/\r?\n/).includes(reference)) return text
  return text ? `${text}\n\n${reference}` : reference
}

function invokedDirectly() {
  if (import.meta.main) return true
  const entry = process.argv[1] ?? ''
  return entry.endsWith('generated-pr-body.js') && process.argv.length > 2
}

if (invokedDirectly()) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('REFUSE: body file required\n')
    process.exit(1)
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'read failed'
    process.stderr.write(`REFUSE: cannot read body file: ${message}\n`)
    process.exit(1)
  }
  process.stdout.write(generatedPullBody(text))
}
