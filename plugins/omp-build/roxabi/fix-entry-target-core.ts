import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FixActionResult, FixTarget } from './fix-contract.ts'

export const execFileAsync = promisify(execFile)
export type Gh = (cwd: string, args: string[]) => Promise<string>
export function fail<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}
export function defaultGh(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) =>
    String(stdout).trim(),
  )
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function sha(value: string): string | null {
  const candidate = value.trim()
  return /^[0-9a-f]{40}$/.test(candidate) ? candidate : null
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(stdout).trim()
}

export async function gitResult(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout: String(out.stdout), stderr: String(out.stderr) }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: String(failed.stdout ?? ''),
      stderr: String(failed.stderr ?? ''),
    }
  }
}

export async function targetEditedAt(cwd: string, gh: Gh, target: FixTarget): Promise<string | null> {
  const command = target.kind === 'pull-request' ? 'pr' : 'issue'
  try {
    const item = object(JSON.parse(await gh(cwd, [command, 'view', String(target.number), '--json', 'updatedAt'])))
    return item !== null && typeof item.updatedAt === 'string' && item.updatedAt.length > 0 ? item.updatedAt : null
  } catch {
    return null
  }
}
