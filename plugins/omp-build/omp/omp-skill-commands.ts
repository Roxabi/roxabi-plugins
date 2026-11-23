export type SkillCommand = {
  name: string
  skill?: string
  description: string
  requires: readonly string[]
}

/** Slash commands with a skill body; `/feature` has its own host pipeline. */
export const SKILL_COMMANDS: readonly SkillCommand[] = [
  {
    name: 'feature',
    description: 'OMP-only feature cycle — frame, GitHub issue, worktree, implement, bounded review/fix, land.',
    requires: ['dev-review', 'dev-fix'],
  },
  {
    name: 'dev-review',
    description:
      'Independent review of an open PR head: reviewer agents, findings on the PR, verdict line when approved.',
    requires: ['dev-review'],
  },
  {
    name: 'dev-fix',
    description:
      'Fix the latest /dev-review findings and failing checks on an open PR head, push the exact tip, then review again.',
    requires: ['dev-fix', 'dev-review'],
  },
  {
    // The optional tail (#495). Offered after a ticket lands, never chained.
    name: 'promote',
    description: 'Promote staging→main — pre-flight, version, changelog, PR, tag',
    requires: [],
  },
  {
    name: 'cleanup',
    description: 'Inventory worktrees; manually approve local-data discard with --force, preserving branches',
    requires: [],
  },
  {
    name: 'ci-watch',
    description: 'Watch every check on a PR head, then the merge, until the script deadline',
    requires: [],
  },
]
