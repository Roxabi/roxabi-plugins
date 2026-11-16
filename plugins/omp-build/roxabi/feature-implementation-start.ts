import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FeatureCommandHost, FeatureGit } from './feature-contract.ts'

const execGit = promisify(execFile)

function observedGitText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

export async function readImplementationStart(
  host: FeatureCommandHost,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const git: FeatureGit =
    host.git ??
    (async (args, cwd) => {
      try {
        const shown = await execGit('git', [...args], { cwd, encoding: 'utf8' })
        return { stdout: observedGitText(shown.stdout), exitCode: 0 }
      } catch (error) {
        const stdout =
          typeof error === 'object' && error !== null && 'stdout' in error ? observedGitText(error.stdout) : ''
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : 1
        return { stdout, exitCode: typeof code === 'number' ? code : 1 }
      }
    })
  const head = await git(['rev-parse', 'HEAD'], host.cwd)
  const sha = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, reason: 'implementation-start-unobserved' }
  }
  return { ok: true, head: sha }
}
