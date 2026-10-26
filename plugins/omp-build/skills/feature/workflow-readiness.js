import { spawnSync } from 'node:child_process'
import { refreshReviewBase } from './review-base.ts'
import { readPrFields } from './workflow-gate.js'
import { stripGitHookEnv } from './workflow-runtime.js'

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function emptyLanding(fallback) {
  return { mode: fallback, required_checks: [] }
}

function parseStackYaml(stackText) {
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function')
    throw new Error('.dev/stack.yml: reading it needs bun >= 1.2.21 (Bun.YAML)')
  try {
    return Bun.YAML.parse(stackText)
  } catch (error) {
    throw new Error(`.dev/stack.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function landingConfiguration(doc, fallback) {
  if (doc == null) return emptyLanding(fallback)
  if (!isMap(doc) || (doc.landing != null && !isMap(doc.landing)))
    throw new Error('.dev/stack.yml: the document or landing is not a map')
  const landing = doc.landing ?? {}
  const mode = landing.mode ?? fallback
  if (mode !== 'native' && mode !== 'merge-on-green')
    throw new Error(`.dev/stack.yml: landing.mode must be native or merge-on-green, got ${JSON.stringify(mode)}`)
  const checks = landing.required_checks ?? []
  if (!Array.isArray(checks) || !checks.every((check) => typeof check === 'string' && check.length > 0))
    throw new Error('.dev/stack.yml: landing.required_checks must be a list of check names')
  return { mode, required_checks: checks }
}

export function parseLanding(stackText, { mergeOnGreenWorkflow = false } = {}) {
  const fallback = mergeOnGreenWorkflow ? 'merge-on-green' : 'native'
  if (!stackText.trim()) return emptyLanding(fallback)
  return landingConfiguration(parseStackYaml(stackText), fallback)
}

function gitSync(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { cwd, env: stripGitHookEnv(), encoding: 'utf8' })
}

export function readLandingAt(cwd, at) {
  const refPath = (path) => `${at}:${path}`
  const stack = gitSync(cwd, ['show', refPath('.dev/stack.yml')])
  const workflow = gitSync(cwd, ['cat-file', '-e', refPath('.github/workflows/merge-on-green.yml')])
  return parseLanding(stack.status === 0 ? stack.stdout : '', { mergeOnGreenWorkflow: workflow.status === 0 })
}

export function readLanding(cwd, { base } = {}) {
  if (typeof base !== 'string' || !base)
    throw new Error('readLanding: base is required — landing is read from origin/<base>, never the working tree')
  return readLandingAt(cwd, `refs/remotes/origin/${base}`)
}

export async function fetchBase(cwd, name, gitFn, ghFn) {
  const fetched = await refreshReviewBase(cwd, typeof name === 'string' ? name : '', gitFn, ghFn)
  return fetched.ok ? { name, tip: fetched.tip } : { name, refusal: fetched }
}

export async function resolveLandingBase(cwd, pr, ghFn, gitFn) {
  const data = await readPrFields(cwd, pr, ghFn, 'baseRefName')
  return fetchBase(cwd, data.baseRefName, gitFn, ghFn)
}
