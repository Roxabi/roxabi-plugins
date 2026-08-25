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
import {
  formatSparkFail,
  linkedGithubIssue,
  missingClientMessage,
  needsSparkClient,
  sparkPayload,
  ticketFromSparkJson,
} from './omp-wt-lib.js'

const SPARK_SH = `${process.env.HOME}/projects/gosilex/spark/plugins/silex-spark/skills/spark-tickets/scripts/spark.sh`

function log(msg) {
  console.error(`omp-wt: ${msg}`)
}

function die(err) {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(msg.startsWith('omp-wt:') ? msg : `omp-wt: ${msg}`)
  process.exit(1)
}

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

async function sparkJson(argv, label) {
  if (!(await Bun.file(SPARK_SH).exists())) {
    throw new Error(`spark.sh missing: ${SPARK_SH}`)
  }
  log(label)
  const proc = Bun.spawn([SPARK_SH, ...argv], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(formatSparkFail({ label, code, stderr, stdout }))
  return sparkPayload(stdout, label)
}

function parseGithubOrigin(url) {
  const m = String(url)
    .trim()
    .match(/github\.com[:/]([^/]+)\/([^/.]+)/i)
  return m ? { owner: m[1], name: m[2] } : null
}

async function resolveSparkClientFromRepo() {
  let url = ''
  try {
    url = (await Bun.$`git remote get-url origin`.text()).trim()
  } catch (e) {
    log(`origin: ${(e instanceof Error ? e.message : e) || 'unavailable'}`)
    return null
  }
  const repo = parseGithubOrigin(url)
  if (!repo) {
    log(`origin is not GitHub (${url})`)
    return null
  }
  const path = `/api/v1/projects/by-repo?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.name)}`
  try {
    const json = await sparkJson(['get', path], `spark by-repo ${repo.owner}/${repo.name}`)
    return json.project?.clientSlug || json.clientSlug || null
  } catch (e) {
    log(e instanceof Error ? e.message : String(e))
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
  const code = await proc.exited
  if (code !== 0) {
    log(`spark config show failed (exit ${code})`)
    return null
  }
  const resolved = out.split('=== resolved ===')[1] || ''
  const m = resolved.match(/^\s+client:\s+(\S+)/m)
  const v = m?.[1]
  return v && v !== '(unset)' ? v : null
}

async function resolveSparkClient(explicit) {
  if (explicit) {
    log(`client ${explicit} (flag/token)`)
    return explicit
  }
  const fromRepo = await resolveSparkClientFromRepo()
  if (fromRepo) {
    log(`client ${fromRepo} (origin by-repo)`)
    return fromRepo
  }
  const fromCfg = await resolveSparkClientFromConfig()
  if (fromCfg) {
    log(`client ${fromCfg} (spark config)`)
    return fromCfg
  }
  log('client unresolved (no -c, by-repo, or spark config)')
  return null
}

async function fetchSpark(id, client) {
  const getArgv = ['tickets', 'get', String(id)]
  if (client) getArgv.push('--client', client)
  const json = await sparkJson(getArgv, `spark tickets get ${client ? `${client}#` : ''}${id}`)
  const ticket = ticketFromSparkJson(json, { id, client })
  const slug = client || ticket.clientSlug || null

  let ghIssue = null
  const ghArgv = ['tickets', 'github-list', String(id)]
  if (slug) ghArgv.push('--client', slug)
  try {
    const listed = await sparkJson(
      ghArgv,
      `spark tickets github-list ${slug ? `${slug}#` : ''}${id}`,
    )
    ghIssue = linkedGithubIssue(listed)
  } catch (e) {
    log(`github-list: ${e instanceof Error ? e.message : e}`)
  }

  return {
    title: ticket.title,
    body: ticket.body,
    spark: slug ? `${slug}#${ticket.ref}` : String(ticket.ref),
    ghIssue,
  }
}

async function run() {
  const root = (await Bun.$`git rev-parse --show-toplevel`.text()).trim()
  process.chdir(root)
  log(`repo ${root}`)

  async function ask(q, def = '') {
    const rl = createInterface({ input, output })
    const hint = def ? ` [${def}]` : ''
    const a = (await rl.question(`${q}${hint}: `)).trim()
    rl.close()
    return a || def
  }

  async function mintIssue(title, body) {
    log(`mint GH issue: ${title}`)
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
    log(`minted GH #${m[1]}`)
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
    if (!sparkClient && needsSparkClient(sparkId)) {
      throw new Error(missingClientMessage(sparkId))
    }
    const ticket = await fetchSpark(sparkId, sparkClient)
    subject = ticket.title
    spark = ticket.spark
    log(`spark ${spark}: ${ticket.title}`)
    if (ticket.ghIssue) {
      issue = Number(ticket.ghIssue)
      log(`linked GH #${issue}`)
    } else {
      log(`no linked GH issue for ${spark}`)
    }
  }

  if (!sourcePath && issue) sourcePath = await findSpecForIssue(root, issue)
  if (sourcePath && (await Bun.file(sourcePath).exists())) {
    content = await Bun.file(sourcePath).text()
    log(`spec ${sourcePath}`)
  }

  if (!content && issue) {
    try {
      const gh = await Bun.$`gh issue view ${issue} --json title,body`.json()
      subject = subject || gh.title
      content = stubSpec({ title: gh.title, issue, spark })
      log(`GH #${issue}: ${gh.title}`)
    } catch (e) {
      throw new Error(`gh issue view ${issue} failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (!content && subject) content = stubSpec({ title: subject, issue, spark })
  if (!content) {
    throw new Error(
      sparkId
        ? `Spark ${spark || sparkId} produced no spec (ticket fetch failed or title empty)`
        : 'need a spec, issue, Spark ticket, or subject',
    )
  }

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
  log(`wrote ${dest}`)

  if (sourcePath?.startsWith(root) && !(await tracked(sourcePath))) {
    await unlink(sourcePath).catch(() => {})
  }

  console.error(`${names.branch} → ${names.worktree}`)

  if (printOnly) {
    console.log(names.worktree)
    return
  }

  const child = Bun.spawn(['omp', '--cwd', names.worktree], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(await child.exited)
}

await run().catch(die)
