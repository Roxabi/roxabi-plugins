export type ReviewFile = {
  path: string
  oldPath?: string
  hunk?: string
  text: string | null
  deleted: boolean
  binary: boolean
}
export type PreparedReviewChunk = { index: number; delta: string[]; diff: string; files: ReviewFile[]; digest: string }
