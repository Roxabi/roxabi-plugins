import type { NativeTask } from '../omp/review-runtime/contracts'
import type { AllocateReviewInput, AllocateReviewResult } from '../skills/dev-review/roster-contract'
import { allocateReview } from '../skills/dev-review/roster-selection'
import { nativePanelProfileByRole } from './native-review-profiles'
import type { ReviewConfig } from './review-assets'

export type ReviewChunk = {
  index: number
  delta: string[]
  /** Exact chunker output; never recreated from paths or a summary. */
  diff: string
  files: readonly { path: string; text: string | null; deleted: boolean; binary?: boolean }[]
  /** Exact digest.py output; never recreated from prose. */
  digest: string
}
export type ReviewPanelInput = {
  chunks: readonly ReviewChunk[]
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  commonContext: string
}
export type RecallTaskInput = {
  classId: string
  chunks: readonly number[]
  callsites: readonly { file: string; line: number }[]
  sourceFindingIds: readonly string[]
  canonicalClasses: readonly string[]
  context: string
  sourceEvidence: string
}

export function createRecallTask(input: RecallTaskInput): Omit<NativeTask, 'action'> {
  if (input.chunks.length < 2 || input.callsites.length < 3) throw new Error('recall threshold was not met')
  if (!input.canonicalClasses.includes(input.classId)) throw new Error('recall class is not canonical')
  return {
    name: `recall-${input.classId}`,
    agent: 'R-review-recall',
    solutionSpace: 'verify one canonical cross-chunk review class from retained reports and callsites',
    task: `Verify canonical class ${input.classId} using only the index. Return structured findings. Do not publish.`,
  }
}

export type ReviewPanel = { allocation: AllocateReviewResult; tasks: Array<Omit<NativeTask, 'action'>> }

/** Preserves chunk order, full diff/file bytes and roster-owned role selection. */
export function allocateReviewPanel(input: ReviewPanelInput): ReviewPanel {
  if (input.chunks.length === 0) throw new Error('review requires chunker output')
  if (input.chunks.some((chunk, index) => chunk.index !== index || chunk.digest.length === 0))
    throw new Error('review chunks require ordered chunker/digest outputs')
  const allocation = allocateReview({
    chunkDeltas: input.chunks.map((chunk) => [...chunk.delta]),
    shared: { ...input.roster, chunks: input.chunks.length },
  })
  if (allocation.global.review_halt) throw new Error('roster halted review dispatch')
  const tasks = input.chunks.flatMap((chunk) =>
    allocation.chunk_agents[chunk.index].map((role) => {
      const agent = nativePanelProfileByRole[role]
      if (!agent) throw new Error(`roster selected unsupported native role ${role}`)
      return {
        name: `panel-${chunk.index}-${role}`,
        agent,
        solutionSpace: 'review this assigned chunk and report only structured findings',
        task: 'Review the assigned chunk named by the index. Return structured findings only. Do not publish.',
      }
    }),
  )
  return { allocation, tasks }
}
