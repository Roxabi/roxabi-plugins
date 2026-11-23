type Handler = (...args: unknown[]) => unknown

export async function dispatchInitialCommand(
  fix: Handler,
  tools: Map<string, Handler>,
  mode: 'feature' | 'review-only' | 'fix-pr' | 'fix-issue',
  context: unknown,
  feature: Handler,
): Promise<void> {
  if (mode === 'review-only') {
    // `/dev-review` runs as instructions; the native review starts through its model-lane tool.
    const review = tools.get('omp_build_start_review')
    if (review === undefined) throw new Error('review-tool-unregistered')
    await review('review-start', { pr: 7 }, undefined, undefined, context)
  } else if (mode === 'fix-pr' || mode === 'fix-issue') {
    // `/dev-fix` runs as instructions; the native correction keeps its host dispatcher until #1037 removes it.
    await fix(`${mode === 'fix-pr' ? '#7' : '#42'} preserve the selected region`, context)
  } else {
    await feature('#42', context)
  }
}
