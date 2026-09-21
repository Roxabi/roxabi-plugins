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
    'pr-title.yml': generatePrTitleYml(opts),
    'context-lint.yml': generateContextLintYml(opts),
    'secret-scan.yml': generateSecretScanYml(opts),
    'dependabot-automerge.yml': generateDependabotAutomergeYml(),
    ...(opts.merge === 'merge-on-green'
      ? { 'merge-on-green.yml': generateMergeOnGreenYml(opts) }
      : { 'auto-merge.yml': generateAutoMergeYml(opts) }),
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

  // ── Trunk-mode double-writer guard (#371 N10) — a hard FAIL, not a warn ──
  // A second release writer is a correctness hazard (two workflows racing to own
  // the release), so unlike the digest loop above this is `fail`. Only trunk repos
  // are guarded; staging-train is inert. N11 — which required a generated
  // auto-release.yml to exist and match — is gone with the tagger it guarded
  // (ADR-021): a trunk repo now generates no release workflow at all, and its
  // hand-written release.yml is deliberately ungoverned.
  if (stack.release?.model === 'trunk') {
    if (existsSync('.github/workflows/release-please.yml')) {
      checks.push({
        name: 'release-model:release-please-collision',
        status: 'fail',
        detail:
          'release.model is trunk but .github/workflows/release-please.yml is present — a second release writer. Delete the release-please trio; a trunk release is cut by pushing an annotated tag.',
      })
    }
  }

  return checks
}
