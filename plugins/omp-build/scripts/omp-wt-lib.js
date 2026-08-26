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

const SPARK_SECTIONS = new Set(['developpement', 'pilotage', 'taches', 'roadmap'])

export function parseSparkUrl(s) {
  let u
  try {
    u = new URL(String(s).trim())
  } catch {
    return null
  }
  const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [client, section, open] = parts
  if (!SPARK_SECTIONS.has(section)) return null
  const id = open || u.searchParams.get('id')
  if (!id) return null
  return { client, id }
}

export function parseSparkToken(s) {
  const raw = String(s).trim()
  const fromUrl = parseSparkUrl(raw)
  if (fromUrl) return fromUrl
  const m = raw.match(/^spark:(?:([a-z0-9-]+)#)?([A-Za-z0-9]+)$/i) || raw.match(/^([a-z0-9-]+)#(\d+)$/i)
  if (!m) return { id: raw.replace(/^spark:/i, ''), client: null }
  return { client: m[1] || null, id: m[2] }
}

export function parseGithubOrigin(url) {
  const m = String(url)
    .trim()
    .match(/github\.com[:/]([^/]+)\/([^/.]+)/i)
  return m ? { owner: m[1], name: m[2] } : null
}

export function clientSlugFromByRepo(json) {
  const slug = json?.project?.clientSlug
  return typeof slug === 'string' && slug.trim() ? slug.trim() : null
}

export function classifyRawIntake(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { kind: 'empty' }
  if (/^#?\d+$/.test(s)) return { kind: 'gh', issue: Number(s.replace('#', '')) }
  if (/^spark:/i.test(s) || /^[a-z0-9-]+#\d+$/i.test(s) || parseSparkUrl(s)) {
    const p = parseSparkToken(s)
    return { kind: 'spark', id: p.id, client: p.client || null }
  }
  return { kind: 'subject', subject: s }
}

export function parseArgv(args) {
  let issue = null
  let specPath = null
  let printOnly = false
  let subject = null
  let sparkId = null
  let sparkClientFlag = null
  let sparkClientToken = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--print') printOnly = true
    else if (a === '--spec') specPath = args[++i]
    else if (a === '--subject') subject = args[++i]
    else if (a === '--spark' || a === '-s') {
      const v = args[++i]
      if (!v || v.startsWith('-')) return { usage: true }
      const p = parseSparkToken(v)
      sparkId = p.id
      if (p.client) sparkClientToken = p.client
    } else if (a === '--client' || a === '-c') {
      const v = args[++i]
      if (!v || v.startsWith('-')) return { usage: true }
      sparkClientFlag = v
    } else if (a === '-h' || a === '--help') return { usage: true }
    else if (/^#?\d+$/.test(a)) issue = Number(a.replace('#', ''))
    else if (/^spark:/i.test(a) || /^[a-z0-9-]+#\d+$/i.test(a) || parseSparkUrl(a)) {
      const p = parseSparkToken(a)
      sparkId = p.id
      if (p.client) sparkClientToken = p.client
    } else if (!a.startsWith('-') && !subject) subject = a
    else return { usage: true }
  }
  if (sparkClientFlag && !sparkId) return { usage: true }
  return { printOnly, specPath, subject, issue, sparkId, sparkClientFlag, sparkClientToken }
}
