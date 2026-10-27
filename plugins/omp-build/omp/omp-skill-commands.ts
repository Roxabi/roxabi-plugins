export type SkillCommand = {
  name: string
  skill?: string
  description: string
  requires: readonly string[]
}

/** Slash commands with a skill body; native review, correction, and feature have real host pipelines. */
export const SKILL_COMMANDS: readonly SkillCommand[] = [
  {
    name: 'feature',
    description: 'OMP-only feature cycle — frame, GitHub issue, worktree, implement, bounded review/fix, land.',
    requires: ['dev-review', 'fix'],
  },
  {
    name: 'dev-review',
    description: 'Prepare and dispatch a host-authorized native structured review.',
    requires: ['dev-review'],
  },
  {
    name: 'fix',
    description: 'Prepare and dispatch a host-authorized native correction from confirmed review records.',
    requires: ['fix'],
  },
  {
    // The optional tail (#495). Offered after a ticket lands, never chained.
    name: 'promote',
    description: 'Promote staging→main — pre-flight, version, changelog, PR, tag',
    requires: [],
  },
  {
    name: 'cleanup',
    description: 'Clean merged branches, worktrees and remotes after verification',
    requires: [],
  },
  {
    name: 'ci-watch',
    description: 'Watch every check on a PR head, then the merge, until the script deadline',
    requires: [],
  },
]
