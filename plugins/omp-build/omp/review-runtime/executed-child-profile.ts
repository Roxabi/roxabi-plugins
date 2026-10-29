import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ContextEvent, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { producerJsonSchema } from '../../engine/producer-schema.ts'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles.ts'
import { nativeReviewProfiles } from '../../roxabi/native-review-profiles.ts'
import { hostActionBinding, verifyHostAction } from './action-registry.ts'
import { object } from './capture.ts'
import type { NativeExtension, NativeTask } from './contracts.ts'

export type PinnedProfile = {
  prompt: string
  tools: readonly string[]
  outputSchema: unknown
  model: string
}

export function isCanonicalChild(ctx: ExtensionContext): boolean {
  return (
    ctx.agent.kind === 'sub' &&
    [...nativeFeatureProfiles, ...nativeReviewProfiles].some(
      (profile) => profile.name.toLowerCase() === ctx.agent.name.toLowerCase(),
    )
  )
}

/** The generated agent format is deliberately restricted to the single-line fields we publish. */
function parseProfile(text: string): { fields: Map<string, string>; prompt: string } | null {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  const allowed: Record<string, true> = {
    name: true,
    description: true,
    tools: true,
    model: true,
    maxTurns: true,
    blocking: true,
    structured: true,
    output: true,
  }
  if (end < 0) return null
  const fields = new Map<string, string>()
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z]+): (.*)$/.exec(line)
    if (!match || !allowed[match[1]] || fields.has(match[1])) return null
    fields.set(match[1], match[2])
  }
  return { fields, prompt: normalized.slice(end + 5).trim() }
}

/** Retain the exact sealed, pinned bytes; never use an independently discovered agent file. */
export async function loadPinnedProfile(task: NativeTask): Promise<PinnedProfile | null> {
  try {
    if (hostActionBinding(task.action.snapshot, task.action.inputs) === null) return null
    const verified = await verifyHostAction(task.action.snapshot)
    if (!verified.ok) return null
    const profile = [...nativeFeatureProfiles, ...nativeReviewProfiles].find((item) => item.name === task.agent)
    if (!profile || !/^[A-Za-z0-9_-]+$/.test(task.agent)) return null
    const pin = task.action.inputs.manifest.plugin
    const relative = `agents/${task.agent}.md`
    const refs = pin.files.filter((file) => file.path === `${pin.root}/${relative}`)
    if (refs.length !== 1 || refs[0].repository !== pin.repository || refs[0].commit !== pin.commit) return null
    const bytes = await readFile(join(dirname(task.action.snapshot.indexPath), 'plugin', relative))
    if (createHash('sha256').update(bytes).digest('hex') !== refs[0].digest) return null
    const parsed = parseProfile(bytes.toString('utf8'))
    if (!parsed?.prompt || parsed.fields.size !== 8) return null
    const fields = parsed.fields
    if (
      fields.get('name') !== profile.name ||
      fields.get('tools') !== profile.tools ||
      fields.get('model') !== JSON.stringify(profile.model) ||
      fields.get('maxTurns') !== String(profile.maxTurns) ||
      fields.get('blocking') !== 'true' ||
      fields.get('structured') !== 'true'
    )
      return null
    const outputSchema: unknown = JSON.parse(fields.get('output') ?? '')
    if (!isDeepStrictEqual(outputSchema, producerJsonSchema(profile.output))) return null
    return {
      prompt: parsed.prompt,
      tools: profile.tools.split(',').map((tool) => tool.trim()),
      outputSchema,
      model: profile.model,
    }
  } catch {
    return null
  }
}

/** Validate the SDK-authored in-memory session_init, not child/model claims. */
export function validateChildInit(profile: PinnedProfile, task: NativeTask, entry: unknown): boolean {
  if (!object(entry) || entry.type !== 'session_init' || entry.agent !== task.agent || typeof entry.task !== 'string')
    return false
  if (entry.task.trimEnd() !== `Complete assignment thoroughly:\n\n${task.task.trim()}`) return false
  if (!Array.isArray(entry.tools) || entry.tools.some((tool) => typeof tool !== 'string')) return false
  const actual = new Set(
    entry.tools.filter((tool) => tool !== 'yield' && !(tool === 'wait' && profile.tools.includes('bash'))),
  )
  if (actual.size !== profile.tools.length || profile.tools.some((tool) => !actual.has(tool))) return false
  return (
    entry.spawns === '' &&
    entry.advisor === undefined &&
    entry.readSummarize === undefined &&
    (entry.modelRole === undefined || typeof entry.modelRole === 'string') &&
    isDeepStrictEqual(entry.outputSchema, profile.outputSchema)
  )
}

export function toolSetValid(pi: NativeExtension, profile: PinnedProfile): boolean {
  const allowed = new Set([...profile.tools, 'yield'])
  const active = pi.getActiveTools()
  if (active.length !== allowed.size || active.some((name) => !allowed.has(name))) return false
  const all = pi.getAllTools()
  return active.every((name) => {
    const matches = all.filter((tool) => tool.name === name)
    return matches.length === 1 && matches[0]?.sourceInfo?.source === 'builtin'
  })
}

function validContextMessage(message: ContextEvent['messages'][number], task: string): boolean {
  if (message.role !== 'user') return message.role === 'assistant' || message.role === 'toolResult'
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every((part) => part.type === 'text')
        ? content.map((part) => part.text).join('')
        : null
  return text === task
}

export function validContext(messages: ContextEvent['messages'], task: string): boolean {
  let users = 0
  for (const message of messages) {
    if (message.role === 'user') users++
    if (!validContextMessage(message, task)) return false
  }
  return users === 1
}
