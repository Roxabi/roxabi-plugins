import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkflowGraph } from '../engine/workflow-graph.ts'
import { shippedWorkflowGraph, WORKFLOW_CONFIG_VERSION, workflowGraphData } from './workflow-graph.ts'

export type ConfigPin = {
  compatibility: string
  additionalRequirements: readonly string[]
  graphDigest: string
  graph: WorkflowGraph
  productVersion: string
}

export type EffectiveWorkflowConfig = {
  compatibility: typeof WORKFLOW_CONFIG_VERSION
  additionalRequirements: string[]
  graphDigest: string
  graph: WorkflowGraph
  productVersion: string
}

/** Key-sorted JSON. Array order stays meaningful. Undefined fields are omitted so codec read-back matches. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Digest of the complete serialized effective configuration pin. */
export function configPinDigest(effective: ConfigPin): string {
  return createHash('sha256').update(canonicalJson(effective)).digest('hex')
}

/** Digest of the shipped edge table. Product version is not part of the digest. */
export function workflowConfigDigest(): string {
  return createHash('sha256')
    .update(canonicalJson({ version: WORKFLOW_CONFIG_VERSION, ...workflowGraphData }))
    .digest('hex')
}

export function installedProductVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  )
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('omp-build package version is missing')
  }
  if (parsed.version.length === 0) throw new Error('omp-build package version is empty')
  return parsed.version
}

export function effectiveWorkflowConfig(
  productVersion: string,
  additionalRequirements: readonly string[],
): EffectiveWorkflowConfig {
  return {
    compatibility: WORKFLOW_CONFIG_VERSION,
    additionalRequirements: [...additionalRequirements],
    graphDigest: workflowConfigDigest(),
    graph: shippedWorkflowGraph(productVersion),
    productVersion,
  }
}

/**
 * Fact for the engine. Not a record and not a pass inferred from zero proof records.
 * `applicable-noop` is the existing admission where both producers do not apply and
 * the current review-input binding was captured. Ignored-local and missing committed
 * config stay blocked. A missing decision is `not-run`.
 */
export type ProofGraphOutcome =
  | { status: 'not-run' }
  | {
      status: 'blocked'
      reason:
        | 'ignored-local'
        | 'missing-committed-config'
        | 'unreadable'
        | 'ambiguous'
        | 'unbound'
        | 'missing'
        | 'verdict'
        | 'unjustified'
    }
  | {
      status: 'applicable-noop'
      inputBound: true
      reviewInput: string
      semctx: 'absent'
      assertledger: 'not-applicable'
    }
  | {
      status: 'requires-record'
      inputBound: true
      reviewInput: string
      semctx: 'configured' | 'absent'
      assertledger: 'detection' | 'not-applicable'
    }
  | {
      status: 'admitted'
      inputBound: true
      reviewInput: string
      semctx: 'absent' | 'verified' | 'partial'
      assertledger: 'not-applicable' | 'detection'
    }
