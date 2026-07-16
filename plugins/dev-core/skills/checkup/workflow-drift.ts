import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateAutoMergeYml,
  generateCiYml,
  generateContextLintYml,
  generateDeployYml,
  generatePrTitleYml,
  workflowOptsFromStack,
} from '../../../dev-init/skills/init/lib/workflows'
import {
  generateCloudflareDeployYml,
  generateDependabotAutomergeYml,
  generateMergeOnGreenYml,
  generateSecretScanYml,
} from '../../../dev-init/skills/init/lib/workflows-fleet'
import type { Check, StackInfo } from './doctor-shared'
import { readStackYml } from './doctor-shared'

function normalizeYml(s: string): string {
  return s.replace(/\r\n/g, '\n').trim()
}

function digest(s: string): string {
  return createHash('sha256').update(normalizeYml(s)).digest('hex').slice(0, 12)
}

function detectMergeStrategy(stackMerge: StackInfo['mergeStrategy']): 'auto-merge' | 'merge-on-green' {
  if (stackMerge) return stackMerge
  if (existsSync('.github/workflows/merge-on-green.yml')) return 'merge-on-green'
  return 'auto-merge'
}

/** P3 #318 — compare on-disk workflows vs generator output for this stack.yml. */
export function checkWorkflowDrift(): Check[] {
  const stack = readStackYml()
  const opts = workflowOptsFromStack({
    runtime: stack.runtime ?? undefined,
    deployPlatform: stack.deployPlatform ?? undefined,
    merge: detectMergeStrategy(stack.mergeStrategy),
    e2e: stack.e2e ?? undefined,
    unit: stack.unit ?? undefined,
    test: stack.unit ?? stack.test ?? undefined,
    commands: {
      lint: stack.hasLint ? 'lint' : '',
      typecheck: stack.hasTypecheck ? 'tc' : '',
      test: stack.test ?? '',
    },
  })
  const expected: Record<string, string> = {
    'ci.yml': generateCiYml(opts),
    'pr-title.yml': generatePrTitleYml(),
    'context-lint.yml': generateContextLintYml(),
    'secret-scan.yml': generateSecretScanYml(),
    'dependabot-automerge.yml': generateDependabotAutomergeYml(),
    ...(opts.merge === 'merge-on-green'
      ? { 'merge-on-green.yml': generateMergeOnGreenYml(opts) }
      : { 'auto-merge.yml': generateAutoMergeYml() }),
    ...(opts.deploy === 'vercel' ? { 'deploy-preview.yml': generateDeployYml(opts) } : {}),
    ...(opts.deploy === 'cloudflare' ? { 'deploy-cloudflare.yml': generateCloudflareDeployYml() } : {}),
  }
  const checks: Check[] = []
  for (const [file, gen] of Object.entries(expected)) {
    const path = join('.github/workflows', file)
    if (!existsSync(path)) {
      checks.push({ name: `drift:${file}`, status: 'skip', detail: 'file absent — presence check only' })
      continue
    }
    const onDisk = readFileSync(path, 'utf8')
    if (digest(onDisk) === digest(gen)) {
      checks.push({ name: `drift:${file}`, status: 'pass', detail: 'matches generator' })
    } else {
      checks.push({
        name: `drift:${file}`,
        status: 'warn',
        detail: 'differs from generator — repo evolved or generator stale; never --force without review',
      })
    }
  }
  return checks
}
