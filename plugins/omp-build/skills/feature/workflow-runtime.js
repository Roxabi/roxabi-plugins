import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { trackPreparationGhOperation, trackPreparationOperation } from '../../host/preparation-cohort.ts'

const GIT_HOOK_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
]

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function ciWatchSh() {
  return realpathSync(fileURLToPath(new URL('../ci-watch/ci-watch.sh', import.meta.url)))
}

export function stripGitHookEnv(env = process.env) {
  const out = { ...env }
  for (const key of GIT_HOOK_VARS) delete out[key]
  return out
}

async function readProcess(proc) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => new Response(proc.stdout).text()),
    Promise.resolve().then(() => new Response(proc.stderr).text()),
    proc.exited,
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
  return { stdout: results[0].value, stderr: results[1].value, code: results[2].value }
}

export async function gitResult(cwd, args) {
  return trackPreparationOperation('git', () => {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], {
      cwd,
      env: stripGitHookEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return readProcess(proc)
  })
}

export async function git(cwd, args) {
  const { code, stdout, stderr } = await gitResult(cwd, args)
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
  return stdout.trim()
}

export async function gh(cwd, args) {
  return trackPreparationGhOperation(args, async () => {
    const proc = Bun.spawn(['gh', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const { stdout, stderr, code } = await readProcess(proc)
    if (code !== 0) {
      const error = new Error(`gh ${args.join(' ')} failed (${code}): ${stderr || stdout}`)
      throw Object.assign(error, { exitCode: code, stderr, stdout })
    }
    return stdout.trim()
  })
}

export function preview(raw) {
  const text = String(raw ?? '')
  return text.length > 200 ? `${text.slice(0, 200)}…` : text || '(empty)'
}

export const errorText = (error) => (error instanceof Error ? error.message : String(error))

export const stuckError = (disarmError, readError) =>
  readError === undefined
    ? new Error(errorText(disarmError), { cause: disarmError })
    : new Error(`${errorText(disarmError)} — after: ${errorText(readError)}`, { cause: readError })
