import type { GitRunner } from './workflow-checkout.ts'
import {
  configPinDigest,
  type EffectiveWorkflowConfig,
  effectiveWorkflowConfig,
  shippedProductVersion,
} from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'

const OVERRIDE_PATH = '.dev/stack.yml'

/**
 * Reads the fix configuration from the committed checkout. Working-tree copies
 * are never consulted.
 */
export async function readEffectiveFixConfig(input: { cwd: string; commit: string; git: GitRunner }): Promise<
  | { ok: true; version: string; digest: string; effective: EffectiveWorkflowConfig }
  | {
      ok: false
      reason: 'unsupported' | 'unreadable'
      diagnostics: { code: string; message: string }[]
    }
> {
  const shown = await input.git(input.cwd, ['show', `${input.commit}:${OVERRIDE_PATH}`])
  const missing = shown.code !== 0 && /does not exist|exists on disk, but not in|invalid object/.test(shown.stderr)
  if (shown.code !== 0 && !missing) {
    return {
      ok: false,
      reason: 'unreadable',
      diagnostics: [{ code: 'unreadable', message: shown.stderr.trim() || 'workflow override is unreadable' }],
    }
  }
  const parsed = parseWorkflowOverride(missing ? null : shown.stdout)
  if (!parsed.ok) return parsed
  const effective = effectiveWorkflowConfig(shippedProductVersion(), parsed.additionalRequirements)
  return {
    ok: true,
    version: WORKFLOW_CONFIG_VERSION,
    digest: configPinDigest(effective),
    effective,
  }
}
