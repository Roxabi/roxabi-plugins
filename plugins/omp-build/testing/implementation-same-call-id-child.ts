import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MockResponse } from '@oh-my-pi/pi-ai/providers/mock'
import type { Context } from '@oh-my-pi/pi-ai/types'
import { actionInputManifestSchema } from '../engine/action-input-schema.ts'

const metadata = `printf 'OMP_TOOL_CALL_ID=%s\\n' "\${PI_TOOL_CALL_ID:?}" >&2`

/** Metadata stays outside the application's exact stdout/stderr assertions. */
export const SAME_CALL_PROOF_COMMAND = [
  '(',
  'set -e',
  metadata,
  'out=$(mktemp .same-call-stdout.XXXXXX)',
  'err=$(mktemp .same-call-stderr.XXXXXX)',
  'trap \'rm -f "$out" "$err"\' EXIT',
  'bun src/region.ts >"$out" 2>"$err"',
  'printf \'region preserved\\n\' | cmp -s - "$out"',
  'test ! -s "$err"',
  "printf 'APP_OK\\n'",
  ')',
].join('\n')

export const COMMIT_COMMAND = [
  '(',
  'set -e',
  metadata,
  'mkdir -p src',
  "printf 'region preserved\\n' > README.md",
  "cat > src/region.ts <<'APP'\nprocess.stdout.write('region preserved\\n')\nAPP",
  'git add README.md src/region.ts',
  "git -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -m 'feat: preserve region (#42)'",
  "printf 'COMMIT_OK\\n'",
  ')',
].join('\n')

const commands = [COMMIT_COMMAND, SAME_CALL_PROOF_COMMAND]

function capturedCalls(context: Context): { toolCallId: string; text: string }[] {
  const calls: { toolCallId: string; text: string }[] = []
  for (const message of context.messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'bash') continue
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    const marker = /(?:^|\n)OMP_TOOL_CALL_ID=([^\s]+)/.exec(text)?.[1]
    if (message.isError || marker === undefined || marker !== message.toolCallId)
      throw new Error(`same-call-bash-capture-invalid:${text}`)
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

/** Scripted R-workflow-implement producer: real Bash, same-call env ID, then yield. */
export function sameCallImplementResponse(context: Context, cwd: string): MockResponse {
  const names = new Set((context.tools ?? []).map((tool) => tool.name))
  if (!names.has('yield') || !names.has('bash')) throw new Error('same-call-implement-tools-missing')
  const captures = capturedCalls(context)
  const next = commands[captures.length]
  if (next !== undefined) {
    return { content: [{ type: 'toolCall', name: 'bash', arguments: { command: next } }] }
  }
  if (
    captures.length !== commands.length ||
    !captures[0]?.text.split('\n').includes('COMMIT_OK') ||
    !captures[1]?.text.split('\n').includes('APP_OK')
  )
    throw new Error('same-call-command-checks-incomplete')
  const index = /^Index: (.+)$/m.exec(userTask(context))?.[1]
  if (!index) throw new Error('same-call-index-unidentified')
  const manifest = actionInputManifestSchema.parse(
    JSON.parse(readFileSync(join(dirname(index), 'manifest.json'), 'utf8')),
  )
  if (manifest.spec.kind !== 'accepted') throw new Error('same-call-spec-not-accepted')
  const criterion = manifest.spec.effective.spec.criteria[0]
  if (!criterion) throw new Error('same-call-criterion-missing')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
  const target = {
    format: 'omp-build-finding-target/1' as const,
    kind: 'criterion' as const,
    spec: manifest.spec.effective.own,
    id: criterion.id,
  }
  return {
    content: [
      {
        type: 'toolCall',
        id: 'same-call-yield',
        name: 'yield',
        arguments: {
          data: {
            outcome: 'implemented',
            commitSHAs: [head],
            commands: captures.map((capture, index) => ({
              toolCallId: capture.toolCallId,
              command: commands[index],
              exitCode: 0,
            })),
            criteria: [
              {
                target,
                verification: 'unverified',
                reason: 'same-call provenance proof only; criterion business behavior not verified',
              },
            ],
            reason: 'Owned commit with same-call Bash ID provenance',
          },
        },
      },
    ],
  }
}
