import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  generateAutoMergeYml,
  generateAutoReleaseYml,
  generateCiYml,
  generateContextLintYml,
  generateDeployYml,
  generatePrTitleYml,
  workflowOptsFromStack,
} from '../shared/workflows/workflow-generators'
import {
  generateCloudflareDeployYml,
  generateDependabotAutomergeYml,
  generateMergeOnGreenYml,
  generateSecretScanYml,
} from '../shared/workflows/workflows-fleet'
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

/**
 * P3 #318 — compare on-disk workflows vs generator output for this stack.yml.
 * The generators are copy-synced into dev-core (skills/shared/workflows), so this
 * check is self-contained: no cross-plugin runtime import into dev-init, no degrade path.
 */
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
    // #371 — thread release so trunk mode + baked component reach the generator (N11).
    release: stack.release
      ? { model: stack.release.model, component: stack.release.component ?? undefined }
      : undefined,
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

  // ── Trunk-mode double-writer guards (#371 N10/N11) — hard FAILS, not warns ──
  // A drifted/absent release workflow, or a second release writer, is a
  // correctness hazard (wrong or no release on merge), so unlike the digest loop
  // above these are `fail`. Only trunk repos are guarded; staging-train is inert.
  if (stack.release?.model === 'trunk') {
    // N10 — release.model:trunk and release-please.yml both present is a split
    // brain: two workflows racing to own the release. auto-release.yml wins.
    if (existsSync('.github/workflows/release-please.yml')) {
      checks.push({
        name: 'release-model:release-please-collision',
        status: 'fail',
        detail:
          'release.model is trunk but .github/workflows/release-please.yml is present — two release writers. Delete the release-please trio (auto-release.yml owns releases).',
      })
    }
    // N11 — the committed auto-release.yml must EXIST and match the generator
    // exactly. A trunk repo with no release workflow never releases; a drifted
    // one releases with unknown behavior. Both are fail, not warn.
    const arPath = join('.github/workflows', 'auto-release.yml')
    if (!existsSync(arPath)) {
      checks.push({
        name: 'release-model:auto-release',
        status: 'fail',
        detail:
          'release.model is trunk but .github/workflows/auto-release.yml is absent — run /ci-setup to generate it.',
      })
    } else if (digest(readFileSync(arPath, 'utf8')) === digest(generateAutoReleaseYml(opts))) {
      checks.push({ name: 'release-model:auto-release', status: 'pass', detail: 'matches generator' })
    } else {
      checks.push({
        name: 'release-model:auto-release',
        status: 'fail',
        detail:
          'auto-release.yml differs from the generator (drift) — regenerate via /ci-setup, never hand-edit (N11).',
      })
    }
  }

  return checks
}
