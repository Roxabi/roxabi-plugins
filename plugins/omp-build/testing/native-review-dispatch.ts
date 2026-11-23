type Handler = (...args: unknown[]) => unknown

export async function dispatchInitialCommand(
  commands: Map<string, Handler>,
  tools: Map<string, Handler>,
  mode: 'review-only' | 'fix-pr' | 'fix-issue',
  context: unknown,
): Promise<void> {
  if (mode === 'review-only') {
    // `/dev-review` runs as instructions; the native review starts through its model-lane tool.
    const review = tools.get('omp_build_start_review')
    if (review === undefined) throw new Error('review-tool-unregistered')
    await review('review-start', { pr: 7 }, undefined, undefined, context)
    return
  }
  const fix = commands.get('fix')
  if (fix === undefined) throw new Error('fix-command-unregistered')
  await fix(`${mode === 'fix-pr' ? '#7' : '#42'} preserve the selected region`, context)
}
