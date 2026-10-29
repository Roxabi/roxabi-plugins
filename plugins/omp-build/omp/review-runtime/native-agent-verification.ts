import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { EffectiveSubagentPolicy } from '@oh-my-pi/pi-coding-agent/task/structured-subagent'
import type { NativeTask } from './contracts.ts'
import { loadPinnedProfile } from './executed-child-profile.ts'

export async function verifySelectedAgent(task: NativeTask, policy: EffectiveSubagentPolicy): Promise<void> {
  const { parseAgent } = await import('@oh-my-pi/pi-coding-agent/task/agents')
  const profile = await loadPinnedProfile(task)
  const selected = policy.agent
  if (
    !profile ||
    !selected.filePath ||
    policy.agentName !== task.agent ||
    policy.planMode ||
    policy.preparedSession ||
    policy.isIsolated
  )
    throw new Error('pinned agent policy unavailable')
  const pinnedPath = join(dirname(task.action.snapshot.indexPath), 'plugin', 'agents', `${task.agent}.md`)
  const [pinned, discovered] = await Promise.all([readFile(pinnedPath), readFile(selected.filePath)])
  const pin = task.action.inputs.manifest.plugin
  const refs = pin.files.filter((file) => file.path === `${pin.root}/agents/${task.agent}.md`)
  if (
    refs.length !== 1 ||
    refs[0].repository !== pin.repository ||
    refs[0].commit !== pin.commit ||
    createHash('sha256').update(pinned).digest('hex') !== refs[0].digest
  )
    throw new Error('pinned agent bytes changed')
  if (!pinned.equals(discovered)) throw new Error('discovered agent bytes differ from pinned profile')
  const expected = parseAgent(selected.filePath, pinned.toString('utf8'), selected.source)
  if (
    !isDeepStrictEqual(selected, expected) ||
    !isDeepStrictEqual(policy.effectiveAgent, expected) ||
    selected.systemPrompt.trim() !== profile.prompt ||
    !isDeepStrictEqual(selected.tools, profile.tools) ||
    !isDeepStrictEqual(selected.output, profile.outputSchema) ||
    !selected.blocking ||
    !selected.structured ||
    policy.schema.mode !== 'strict' ||
    policy.schema.source !== 'agent' ||
    !isDeepStrictEqual(policy.schema.schema, profile.outputSchema)
  )
    throw new Error('discovered agent behavior differs from pinned profile')
}
