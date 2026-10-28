/** Drain every already-demanded history in adjacent pairs before reporting a failure. */
export async function readHistoryPairs<T>(
  numbers: readonly number[],
  read: (number: number) => Promise<T>,
): Promise<T[]> {
  const outcomes: PromiseSettledResult<T>[] = []
  for (let index = 0; index < numbers.length; index += 2) {
    const pair = numbers.slice(index, index + 2)
    outcomes.push(...(await Promise.allSettled(pair.map(async (number) => read(number)))))
  }
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason
    return outcome.value
  })
}
