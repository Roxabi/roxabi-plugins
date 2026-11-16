type Handler = (...args: unknown[]) => unknown

export async function dispatchInitialCommand(
  commands: Map<string, Handler>,
  mode: 'feature' | 'review-only' | 'fix-pr' | 'fix-issue',
  context: unknown,
  feature: Handler,
): Promise<void> {
  if (mode === 'review-only') {
    const review = commands.get('dev-review')
    if (review === undefined) throw new Error('review-command-unregistered')
    await review('7', context)
  } else if (mode === 'fix-pr' || mode === 'fix-issue') {
    const fix = commands.get('fix')
    if (fix === undefined) throw new Error('fix-command-unregistered')
    await fix(`${mode === 'fix-pr' ? '#7' : '#42'} preserve the selected region`, context)
  } else {
    await feature('#42', context)
  }
}
