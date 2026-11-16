import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import type { Context } from '@oh-my-pi/pi-ai/types'
import { actionInputDigest } from '../engine/action-input.ts'
import { type ActionInputManifest, actionInputManifestSchema } from '../engine/action-input-schema.ts'
import { fixtureSpecRow } from './feature-review-spec-row.ts'
import { cleanReviewDecision } from './feature-review-synthesis-sources.ts'
import { adoptionProofDiagnostic } from './fix-recovery-adoption-proof-diagnostic.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const proof = 'bun run test'
const scenario = 'saving after a region selection retains that region'

function actualOutput(context: Context, id: string): string {
  const message = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolCallId === id)
  return JSON.stringify(message) ?? ''
}

function applyPreparation(context: Context): MockResponse | undefined {
  const messages = JSON.stringify(context.messages)
  if (!messages.includes('adoption-edit'))
    return {
      content: [
        {
          type: 'toolCall',
          id: 'adoption-edit',
          name: 'bash',
          arguments: { command: `printf 'export function save(region: string) { return region }\\n' > src/save.ts` },
        },
      ],
    }
  if (!messages.includes('adoption-preproof'))
    return { content: [{ type: 'toolCall', id: 'adoption-preproof', name: 'bash', arguments: { command: proof } }] }
  if (!actualOutput(context, 'adoption-preproof').includes('PASS region'))
    throw new Error('adoption-precommit-proof-not-observed')
  if (!messages.includes('adoption-commit'))
    return {
      content: [
        {
          type: 'toolCall',
          id: 'adoption-commit',
          name: 'bash',
          arguments: {
            command: `git -c user.name=Fixture -c user.email=fixture@example.com add src/save.ts && git -c user.name=Fixture -c user.email=fixture@example.com -c commit.gpgsign=false commit -m 'fix: preserve selected region'`,
          },
        },
      ],
    }
  return undefined
}

function falsificationPreparation(context: Context): MockResponse | undefined {
  const messages = JSON.stringify(context.messages)
  if (!messages.includes('adoption-perturb'))
    return {
      content: [
        {
          type: 'toolCall',
          id: 'adoption-perturb',
          name: 'bash',
          arguments: {
            command: `printf 'export function save(_region: string) { return "stale-region" }\\n' > src/save.ts`,
          },
        },
      ],
    }
  if (!messages.includes('adoption-proof'))
    return { content: [{ type: 'toolCall', id: 'adoption-proof', name: 'bash', arguments: { command: proof } }] }
  if (!messages.includes('adoption-restore'))
    return {
      content: [
        {
          type: 'toolCall',
          id: 'adoption-restore',
          name: 'bash',
          arguments: { command: 'git restore -- src/save.ts' },
        },
      ],
    }
  if (!actualOutput(context, 'adoption-proof').includes('stale-region'))
    throw new Error('adoption-perturbed-proof-not-observed')
  return {
    content: [
      {
        type: 'toolCall',
        id: 'adoption-yield',
        name: 'yield',
        arguments: {
          data: {
            facts: [
              {
                guardId: 'selected-region-guard',
                removed: true,
                intendedScenario: scenario,
                proofFailed: true,
                proofToolCallId: 'adoption-proof',
                proofUnavailableReason: null,
              },
            ],
            skippedReason: null,
            commands: [],
          },
        },
      },
    ],
  }
}

function correctionResult(context: Context, manifest: ActionInputManifest, cwd: string, apply: boolean): MockResponse {
  if (!actualOutput(context, 'adoption-proof').includes('PASS region')) throw new Error('adoption-proof-not-observed')
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  if (manifest.spec.kind !== 'accepted') throw new Error('adoption-spec-not-accepted')
  const spec = manifest.spec.effective
  const criteria = spec.spec.criteria.map((criterion) => {
    const target = { format: 'omp-build-finding-target/1', kind: 'criterion', spec: spec.own, id: criterion.id }
    return {
      target,
      verification: 'evidence',
      evidence: [
        {
          id: `correction-${criterion.id}`,
          target,
          method: 'test',
          scenario,
          after: {
            toolCallId: 'adoption-proof',
            versionClaim: {
              code: { repository: manifest.code.repository, commit },
              reason: 'The actual proof imports the action worktree at this commit.',
              references: [],
            },
          },
          before: null,
        },
      ],
    }
  })
  return {
    content: [
      {
        type: 'toolCall',
        id: 'adoption-yield',
        name: 'yield',
        arguments: {
          data: {
            outcome: 'applied',
            commitSHAs: apply ? [commit] : [],
            commands: [],
            proofToolCallId: 'adoption-proof',
            proofUnavailableReason: null,
            proofPaths: [],
            criteria,
            guardInventory: apply
              ? [
                  {
                    guardId: 'selected-region-guard',
                    productionGuard: 'save retains the selected region',
                    paths: ['src/save.ts'],
                    intendedScenario: scenario,
                  },
                ]
              : [],
          },
        },
      },
    ],
  }
}

function correctionResponse(
  context: Context,
  manifest: ActionInputManifest,
  cwd: string,
  apply: boolean,
  falsify: boolean,
): MockResponse {
  if (apply) {
    const preparation = applyPreparation(context)
    if (preparation) return preparation
  }
  if (falsify) {
    const preparation = falsificationPreparation(context)
    if (preparation) return preparation
  }
  if (!JSON.stringify(context.messages).includes('adoption-proof'))
    return { content: [{ type: 'toolCall', id: 'adoption-proof', name: 'bash', arguments: { command: proof } }] }
  return correctionResult(context, manifest, cwd, apply)
}

function reviewResponse(
  context: Context,
  manifest: ActionInputManifest,
  index: string,
  text: string,
  box: Box,
): MockResponse {
  const names = new Set((context.tools ?? []).map((tool) => tool.name))
  const synthesis = text.includes('Synthesize only the dossier named by the index.')
  const specTask = text.includes('Judge each accepted criterion in the index.')
  const recall = !synthesis && !specTask && !names.has('bash')
  const readOnly = synthesis || recall
  if (!JSON.stringify(context.messages).includes('adoption-review-probe'))
    return {
      content: [
        {
          type: 'toolCall',
          id: 'adoption-review-probe',
          name: readOnly ? 'read' : 'bash',
          arguments: readOnly ? { path: index } : { command: proof },
        },
      ],
    }
  if (!readOnly && !actualOutput(context, 'adoption-review-probe').includes('PASS region'))
    throw new Error('adoption-final-review-probe-failed')
  const fingerprint = actionInputDigest(manifest)
  const action = { inputs: { fingerprint }, snapshot: { indexPath: index, manifestDigest: fingerprint } }
  let data: unknown
  if (synthesis) data = cleanReviewDecision(`Index: ${index}`)
  else if (specTask) {
    try {
      data = { findings: [], specRows: [fixtureSpecRow(action)] }
    } catch (error) {
      throw new Error(adoptionProofDiagnostic(box, manifest, error))
    }
  } else data = { findings: [] }
  return { content: [{ type: 'toolCall', id: 'adoption-review-yield', name: 'yield', arguments: { data } }] }
}

export function adoptionChildResponse(context: Context, cwd: string, box: Box): MockResponse {
  const text = context.messages
    .flatMap((message) =>
      message.role === 'user'
        ? typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
  const index = /^Index: (.+)$/m.exec(text)?.[1]
  if (!index) throw new Error('adoption-child-index-unidentified')
  const manifest = actionInputManifestSchema.parse(
    JSON.parse(readFileSync(join(dirname(index), 'manifest.json'), 'utf8')),
  )
  const apply = text.includes('Apply only confirmed correction cause')
  const revalidate =
    text.includes('Revalidate the confirmed required correction cause') ||
    text.includes('After native surgical restoration of production guard')
  const falsify = text.includes('falsify only confirmed production guard')
  return apply || revalidate || falsify
    ? correctionResponse(context, manifest, cwd, apply, falsify)
    : reviewResponse(context, manifest, index, text, box)
}
