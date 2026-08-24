#!/usr/bin/env bun
/**
 * Intake → mint GH if needed → ensureWorktree → write spec in ω → omp --cwd ω.
 * Never switch principal. Never create ω without an issue. Never dirty principal.
 */
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseSpecMeta,
  findSpecForIssue,
  resolveNames,
  ensureWorktree,
} from '../skills/build/workflow.js'

const SPARK_SH = `${process.env.HOME}/projects/gosilex/spark/plugins/silex-spark/skills/spark-tickets/scripts/spark.sh`

function usage() {
  console.error(`usage: omp-wt [issue|#N] [--subject <text>] [--spec <path>] [--print]
       omp-wt -s <id|url> [-c <slug>]   # Spark; client from URL/-c, else origin, else config
       omp-wt                       # prompt: GH # | spark URL | spark:<client>#N | subject`)
  process.exit(2)
}

const SPARK_SECTIONS = new Set(['developpement', 'pilotage', 'taches', 'roadmap'])

function parseSparkUrl(s) {
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

function parseSparkToken(s) {
  const raw = String(s).trim()
  const fromUrl = parseSparkUrl(raw)
  if (fromUrl) return fromUrl
  const m =
    raw.match(/^spark:(?:([a-z0-9-]+)#)?([A-Za-z0-9]+)$/i) ||
    raw.match(/^([a-z0-9-]+)#(\d+)$/i)
  if (!m) return { id: raw.replace(/^spark:/i, ''), client: null }
  return { client: m[1] || null, id: m[2] }
}

function parseJsonBlob(text) {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    return JSON.parse(t.split('\n').filter(Boolean).at(-1))
  }
}

function setIssue(text, n) {
  if (/^issue:/m.test(text)) return text.replace(/^issue:\s*.*$/m, `issue: ${n}`)
  return text.replace(/^---\n/, `---\nissue: ${n}\n`)
}

function tldrBody(text) {
  const chunk = text.split(/##\s*TL;DR/i)[1]
  const body = chunk ? chunk.split(/^## /m)[0].trim() : ''
  return body || text.slice(0, 500)
}

function stubSpec({ type = 'feat', title, issue: n, spark }) {
  const sparkLine = spark ? `spark: ${spark}\n` : ''
  return `---
title: ${title}
type: ${type}
issue: ${n ?? 'null'}
${sparkLine}status: draft
---

## TL;DR

${title}

## Data model

## Acceptance

## Out of scope

## Invariants

## CONTEXT terms
`
}

const args = process.argv.slice(2)
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
    if (!v || v.startsWith('-')) usage()
    const p = parseSparkToken(v)
    sparkId = p.id
    if (p.client) sparkClientToken = p.client
  } else if (a === '--client' || a === '-c') {
    const v = args[++i]
    if (!v || v.startsWith('-')) usage()
    sparkClientFlag = v
  } else if (a === '-h' || a === '--help') usage()
  else if (/^#?\d+$/.test(a)) issue = Number(a.replace('#', ''))
  else if (/^spark:/i.test(a) || /^[a-z0-9-]+#\d+$/i.test(a) || parseSparkUrl(a)) {
    const p = parseSparkToken(a)
    sparkId = p.id
    if (p.client) sparkClientToken = p.client
  } else if (!a.startsWith('-') && !subject) subject = a
  else usage()
}
if (sparkClientFlag && !sparkId) {
  console.error('omp-wt: -c/--client only with -s/--spark')
  usage()
}

const root = (await Bun.$`git rev-parse --show-toplevel`.text()).trim()
process.chdir(root)

async function ask(q, def = '') {
  const rl = createInterface({ input, output })
  const hint = def ? ` [${def}]` : ''
  const a = (await rl.question(`${q}${hint}: `)).trim()
  rl.close()
  return a || def
}

async function mintIssue(title, body) {
  const prompt = `Create ONE GitHub issue in this repo with gh.
Title: ${title}
Body:
${body}

Do not implement anything. Do not edit files.
Last line of your reply MUST be exactly: ISSUE=<number>`
  const proc = Bun.spawn(['omp', '-p', '--no-session', '--cwd', root, prompt], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`omp -p mint failed (${code})`)
  const m = out.trim().match(/ISSUE=(\d+)/)
  if (!m) throw new Error(`omp -p did not print ISSUE=N\n${out}`)
  return Number(m[1])
}

async function tracked(path) {
  const rel = path.startsWith(root) ? path.slice(root.length + 1) : path
  const proc = Bun.spawn(['git', '-C', root, 'ls-files', '--error-unmatch', rel], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await proc.exited) === 0
}

function parseGithubOrigin(url) {
  const m = String(url)
    .trim()
    .match(/github\.com[:/]([^/]+)\/([^/.]+)/i)
  return m ? { owner: m[1], name: m[2] } : null
}

async function resolveSparkClientFromRepo() {
  if (!(await Bun.file(SPARK_SH).exists())) return null
  let url = ''
  try {
    url = (await Bun.$`git remote get-url origin`.text()).trim()
  } catch {
    return null
  }
  const repo = parseGithubOrigin(url)
  if (!repo) return null
  const path = `/api/v1/projects/by-repo?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.name)}`
  const proc = Bun.spawn([SPARK_SH, 'get', path], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) return null
  try {
    const json = parseJsonBlob(out)
    return json.project?.clientSlug || json.clientSlug || null
  } catch {
    return null
  }
}

async function resolveSparkClientFromConfig() {
  if (!(await Bun.file(SPARK_SH).exists())) return null
  const proc = Bun.spawn([SPARK_SH, 'config', 'show'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  const resolved = out.split('=== resolved ===')[1] || ''
  const m = resolved.match(/^\s+client:\s+(\S+)/m)
  const v = m?.[1]
  return v && v !== '(unset)' ? v : null
}

async function resolveSparkClient(explicit) {
  if (explicit) return explicit
  return (await resolveSparkClientFromRepo()) || (await resolveSparkClientFromConfig())
}

async function fetchSpark(id, client) {
  if (!(await Bun.file(SPARK_SH).exists())) {
    throw new Error(`spark.sh missing: ${SPARK_SH}`)
  }
  const argv = [SPARK_SH, 'tickets', 'get', String(id)]
  if (client) argv.push('--client', client)
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`spark get failed: ${err || out}`)
  const json = parseJsonBlob(out)
  const t = json.ticket || json
  const slug = client || t.clientSlug || null

  let ghIssue = null
  const ghArgv = [SPARK_SH, 'tickets', 'github-list', String(id)]
  if (slug) ghArgv.push('--client', slug)
  const gh = Bun.spawn(ghArgv, { stdout: 'pipe', stderr: 'pipe' })
  const ghOut = await new Response(gh.stdout).text()
  await gh.exited
  try {
    const listed = parseJsonBlob(ghOut)
    const first = listed.issues?.[0] || listed[0]
    ghIssue = first?.number || first?.issueNumber || null
  } catch {
    /* no linked GH */
  }

  return {
    title: t.title,
    body: t.body || t.description || '',
    spark: slug ? `${slug}#${t.ref ?? id}` : String(t.ref ?? id),
    ghIssue,
  }
}

if (!issue && !specPath && !subject && !sparkId) {
  const raw = await ask('Intake (GH # | spark URL | spark:<client>#N | subject)')
  if (!raw) throw new Error('need an intake')
  if (/^#?\d+$/.test(raw)) issue = Number(raw.replace('#', ''))
  else if (/^spark:/i.test(raw) || /^[a-z0-9-]+#\d+$/i.test(raw) || parseSparkUrl(raw)) {
    const p = parseSparkToken(raw)
    sparkId = p.id
    if (p.client) sparkClientToken = p.client
  } else subject = raw
}

let spark = null
let sourcePath = specPath
let content = null

if (sparkId) {
  const sparkClient = await resolveSparkClient(sparkClientFlag || sparkClientToken)
  console.error(`omp-wt: spark ${sparkClient || '-'} ${sparkId}`)
  const ticket = await fetchSpark(sparkId, sparkClient)
  subject = ticket.title
  spark = ticket.spark
  if (ticket.ghIssue) issue = Number(ticket.ghIssue)
}

if (!sourcePath && issue) sourcePath = await findSpecForIssue(root, issue)
if (sourcePath && (await Bun.file(sourcePath).exists())) {
  content = await Bun.file(sourcePath).text()
}

if (!content && issue) {
  const gh = await Bun.$`gh issue view ${issue} --json title,body`.json()
  subject = subject || gh.title
  content = stubSpec({ title: gh.title, issue, spark })
}

if (!content && subject) content = stubSpec({ title: subject, issue, spark })
if (!content) throw new Error('need a spec, issue, Spark ticket, or subject')

if (!issue) {
  const title =
    (content.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] ||
    subject ||
    (await ask('Issue title'))
  issue = await mintIssue(title, tldrBody(content))
}
content = setIssue(content, issue)

const meta = parseSpecMeta(content, { issue, specPath: sourcePath })
const names = await resolveNames({
  cwd: root,
  type: meta.type,
  slug: meta.slug,
  issue,
})
await ensureWorktree(root, names)
const dest = join(names.worktree, 'artifacts', 'specs', `${issue}-${meta.slug}-spec.md`)
await Bun.$`mkdir -p ${join(names.worktree, 'artifacts', 'specs')}`.quiet()
await Bun.write(dest, content)

if (sourcePath?.startsWith(root) && !(await tracked(sourcePath))) {
  await unlink(sourcePath).catch(() => {})
}

console.error(`${names.branch} → ${names.worktree}`)

if (printOnly) {
  console.log(names.worktree)
  process.exit(0)
}

const child = Bun.spawn(['omp', '--cwd', names.worktree], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(await child.exited)
