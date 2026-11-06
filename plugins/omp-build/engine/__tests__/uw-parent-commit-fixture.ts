type CommitInput = {
  p0: string
  merges: readonly [string, string, string]
  heads: readonly [string, string, string]
  parentHead: string
  firstBaseTree: string
  git: { trees: readonly string[]; mergeTrees: readonly string[]; parentTree: string }
  reviews: readonly { head: string; base: string; merge: string }[]
}

export function parentCommitFacts(input: CommitInput) {
  const { p0, parentHead, firstBaseTree, git, reviews } = input
  const [firstMerge, secondMerge, thirdMerge] = input.merges
  const [firstHead, secondHead, thirdHead] = input.heads
  const parents = new Map<string, string[]>([
    [p0, []],
    [firstHead, [p0]],
    [firstMerge, [p0, firstHead]],
    [secondHead, [firstMerge]],
    [secondMerge, [firstMerge, secondHead]],
    [thirdHead, [secondMerge]],
    [thirdMerge, [secondMerge, thirdHead]],
    [parentHead, [thirdMerge]],
  ])
  const reachable = (start: string) => {
    const found = new Set<string>()
    const todo = [start]
    while (todo.length) {
      const sha = todo.pop()
      if (sha === undefined) throw new Error('Missing commit to traverse')
      if (found.has(sha)) continue
      const edges = parents.get(sha)
      if (!edges) throw new Error(`Undeclared commit ${sha}`)
      found.add(sha)
      todo.push(...edges)
    }
    return found
  }
  const commits = [
    { sha: p0, parents: [], tree: firstBaseTree, subject: 'fixture base', paths: [], config: null },
    ...reviews.flatMap((entry, index) => {
      const tree = git.trees[index]
      const mergeTree = git.mergeTrees[index]
      if (!tree || !mergeTree) throw new Error(`Missing declared commit trees ${index}`)
      return [
        {
          sha: entry.head,
          parents: [entry.base],
          tree,
          subject: `feat: implement fixture (#${201 + index})`,
          paths: ['fixture.txt'],
          config: null,
        },
        {
          sha: entry.merge,
          parents: [entry.base, entry.head],
          tree: mergeTree,
          subject: `merge child ${index + 1}`,
          paths: ['fixture.txt'],
          config: null,
        },
      ]
    }),
    {
      sha: parentHead,
      parents: [thirdMerge],
      tree: git.parentTree,
      subject: 'feat: integrate children (#200)',
      paths: ['fixture.txt'],
      config: null,
    },
  ]
  const comparisons = commits.flatMap(({ sha: base }) =>
    commits.flatMap(({ sha: head }) => {
      const after = reachable(head)
      if (!after.has(base)) return []
      const before = reachable(base)
      const difference = [...after].filter((sha) => !before.has(sha))
      return [
        {
          base,
          head,
          status: difference.length === 0 ? ('identical' as const) : ('ahead' as const),
          commits: difference,
        },
      ]
    }),
  )
  return { commits, comparisons }
}
