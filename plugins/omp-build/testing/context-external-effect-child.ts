import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import type { Context } from '@oh-my-pi/pi-ai/types'
import { actionInputManifestSchema } from '../engine/action-input-schema.ts'

const metadata = `printf 'OMP_TOOL_CALL_ID=%s\\n' "\${PI_TOOL_CALL_ID:?}" >&2`

/** Real Bash writes a fictional file outside the managed checkout; stdout stays machine-checkable. */
export function outsideEffectBashCommand(absoluteOutsidePath: string): string {
  if (!absoluteOutsidePath.startsWith('/') || absoluteOutsidePath.includes("'"))
    throw new Error('outside-effect-path-invalid')
  return [
    '(',
    'set -e',
    metadata,
    `mkdir -p "$(dirname '${absoluteOutsidePath}')"`,
    `printf 'outside-effect-payload\\n' > '${absoluteOutsidePath}'`,
    "printf 'OUTSIDE_OK\\n'",
    ')',
  ].join('\n')
}

function capturedCalls(context: Context): { toolCallId: string; text: string }[] {
  const calls: { toolCallId: string; text: string }[] = []
  for (const message of context.messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'bash') continue
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const marker = /(?:^|\n)OMP_TOOL_CALL_ID=([^\s]+)/.exec(text)?.[1]
    if (message.isError || marker === undefined || marker !== message.toolCallId)
      throw new Error(`outside-effect-bash-capture-invalid:${text}`)
    calls.push({ toolCallId: marker, text })
  }
  return calls
}

function userTask(context: Context): string {
  return context.messages
    .flatMap((message) =>
      message.role === 'user'
        ? typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
}

/** Scripted R-workflow-implement: genuine Bash outside checkout, then blocked context-negative with empty claims. */
export function outsideEffectImplementResponse(context: Context, absoluteOutsidePath: string): MockResponse {
  const names = new Set((context.tools ?? []).map((tool) => tool.name))
  if (!names.has('yield') || !names.has('bash')) throw new Error('outside-effect-implement-tools-missing')
  const command = outsideEffectBashCommand(absoluteOutsidePath)
  const captures = capturedCalls(context)
  if (captures.length === 0) {
    return { content: [{ type: 'toolCall', name: 'bash', arguments: { command } }] }
  }
  if (captures.length !== 1 || !captures[0]?.text.split('\n').includes('OUTSIDE_OK'))
    throw new Error('outside-effect-command-checks-incomplete')
  const index = /^Index: (.+)$/m.exec(userTask(context))?.[1]
  if (!index) throw new Error('outside-effect-index-unidentified')
  const manifest = actionInputManifestSchema.parse(
    JSON.parse(readFileSync(join(dirname(index), 'manifest.json'), 'utf8')),
  )
  if (manifest.spec.kind !== 'accepted') throw new Error('outside-effect-spec-not-accepted')
  return {
    content: [
      {
        type: 'toolCall',
        id: 'outside-effect-yield',
        name: 'yield',
        arguments: {
          data: {
            outcome: 'blocked',
            commitSHAs: [],
            commands: [],
            criteria: [],
            missing: [
              {
                locator: {
                  kind: 'information-request',
                  description: 'Disposition of the unreconciled outside-effect file',
                },
                reason: `Unreconciled outside effect remains open at ${absoluteOutsidePath}`,
                targets: [],
              },
            ],
            reason: `Unreconciled outside-effect warning: fictional host file written outside checkout at ${absoluteOutsidePath}`,
          },
        },
      },
    ],
  }
}
