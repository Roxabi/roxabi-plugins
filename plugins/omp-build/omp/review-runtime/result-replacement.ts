import type { ToolResultEvent } from '@oh-my-pi/pi-coding-agent'
import { CREDENTIAL_DISCLOSURE, CREDENTIAL_MODE, retainActionRecordSync } from '../action-communication.ts'
import type { NativeBatch } from './contracts'

export type OwnedResultReplacement = {
  content: [{ type: 'text'; text: string }]
  details: {
    summary: string
    detailRef: string
    credentialMode: typeof CREDENTIAL_MODE
    childIds: string[]
    replacedAutomaticPreview: true
  }
  isError: boolean
}

export function unusableOwnedReplacement(reason: string): OwnedResultReplacement {
  const summary = `native task result unusable: ${reason}`
  return {
    content: [
      {
        type: 'text',
        text: `${summary}\ndetail: retention-unavailable\n${CREDENTIAL_DISCLOSURE}\nnext: restore artifact storage and rerun the owned task`,
      },
    ],
    details: {
      summary,
      detailRef: 'retention-unavailable',
      credentialMode: CREDENTIAL_MODE,
      childIds: [],
      replacedAutomaticPreview: true,
    },
    isError: true,
  }
}

export function replaceOwnedTaskResult(
  event: ToolResultEvent,
  batch: NativeBatch,
  retain: (value: unknown) => string,
): OwnedResultReplacement {
  let detailRef: string
  try {
    detailRef = retain({
      toolCallId: event.toolCallId,
      content: event.content,
      details: event.details,
      isError: event.isError === true,
    })
  } catch {
    return unusableOwnedReplacement('retention-failed')
  }
  if (!detailRef.startsWith('local://')) return unusableOwnedReplacement('retention-failed')
  const summary = `native batch ${batch.operationId} retained; automatic preview replaced`
  return {
    content: [{ type: 'text', text: `${summary}\ndetail: ${detailRef}\n${CREDENTIAL_DISCLOSURE}` }],
    details: {
      summary,
      detailRef,
      credentialMode: CREDENTIAL_MODE,
      childIds: batch.tasks.tasks.map((task) => task.name),
      replacedAutomaticPreview: true,
    },
    isError: event.isError === true,
  }
}

export function retainOwnedResult(ctx: Parameters<typeof retainActionRecordSync>[0], value: unknown): string {
  return retainActionRecordSync(ctx, 'native-result', value)
}
