export function patchFixtureIssue(
  issues: Map<number, { title: string; body: string }>,
  args: string[],
  number: number,
): string {
  const issue = issues.get(number)
  if (!issue) throw new Error(`cannot patch issue ${number}`)
  for (const [index, arg] of args.entries()) {
    if (arg !== '--raw-field') continue
    const field = args[index + 1] ?? ''
    if (field.startsWith('title=')) issue.title = field.slice(6)
    else if (field.startsWith('body=')) issue.body = field.slice(5)
    else throw new Error(`unexpected field ${field}`)
  }
  return '{}'
}
