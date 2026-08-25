/**
 * Pure Spark / intake helpers for omp-wt.
 * spark.sh exits 0 on API {error:…} — callers must use sparkPayload / readSparkError.
 */

export function parseJsonBlob(text) {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('empty JSON')
  try {
    return JSON.parse(t)
  } catch {
    const last = t.split('\n').filter(Boolean).at(-1)
    if (!last) throw new Error('empty JSON')
    return JSON.parse(last)
  }
}

export function readSparkError(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const err = json.error
  return typeof err === 'string' && err.trim() ? err.trim() : null
}

export function sparkPayload(text, label) {
  let json
  try {
    json = parseJsonBlob(text)
  } catch (e) {
    throw new Error(`${label}: not JSON (${e.message})`)
  }
  const err = readSparkError(json)
  if (err) throw new Error(`${label}: ${err}`)
  return json
}

export function needsSparkClient(id) {
  return /^\d+$/.test(String(id ?? ''))
}

export function missingClientMessage(id) {
  return `Spark client unknown for #${id}. Pass -c <slug> or <slug>#${id} (origin by-repo and spark config empty).`
}

export function ticketFromSparkJson(json, { id, client } = {}) {
  const t = json?.ticket && typeof json.ticket === 'object' ? json.ticket : json
  const title = typeof t?.title === 'string' ? t.title.trim() : ''
  const ref = t?.ref ?? id
  const label = client ? `${client}#${ref}` : String(ref ?? id ?? '?')
  if (!title) throw new Error(`Spark ticket ${label} has no title`)
  return {
    title,
    body: t.body || t.description || '',
    ref,
    clientSlug: client || t.clientSlug || null,
  }
}

export function linkedGithubIssue(json) {
  if (!json || readSparkError(json)) return null
  const first = json.issues?.[0] || json.githubIssues?.[0] || (Array.isArray(json) ? json[0] : null)
  const n = first?.number || first?.issueNumber
  return n != null && Number.isFinite(Number(n)) ? Number(n) : null
}

export function formatSparkFail({ label, code, stderr, stdout }) {
  const bits = [`${label} failed`]
  if (code != null && code !== 0) bits.push(`exit ${code}`)
  const err = String(stderr || '').trim()
  const out = String(stdout || '').trim()
  if (err) bits.push(err)
  else if (out) bits.push(out.slice(0, 400))
  return bits.join(': ')
}
