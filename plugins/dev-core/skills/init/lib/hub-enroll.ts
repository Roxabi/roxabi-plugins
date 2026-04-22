/**
 * hub-enroll.ts — Enroll a repository into the Roxabi Hub project.
 *
 * Steps:
 *  1. Verify 10 org Issue Types exist (prerequisite: hub-bootstrap)
 *  2. Push auto-add-to-project workflow (idempotent)
 *  3. Check milestones M0/M1/M2 — warn if missing, no mutation
 *  4. Verify at least one item is in the hub project (lightweight probe)
 */

import { ghGraphQL, listOrgIssueTypes } from '../../shared/adapters/github-adapter'
import { MILESTONE_QUERY, REPO_DEFAULT_BRANCH_QUERY, VERIFY_PROJECT_ITEMS_QUERY } from '../../shared/queries'
import { generateAutoAddToProjectYml, pushWorkflowFile } from './workflows'

async function getRepoDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = (await ghGraphQL(REPO_DEFAULT_BRANCH_QUERY, { owner, repo })) as {
    data?: { repository?: { defaultBranchRef?: { name?: string } | null } | null }
  }
  const name = res?.data?.repository?.defaultBranchRef?.name
  if (!name) {
    throw new Error(`Unable to resolve default branch for ${owner}/${repo}`)
  }
  return name
}

export interface EnrollResult {
  enrolled: boolean
  milestonesMissing: string[]
  verified: boolean
  dryRun?: boolean
}

const REQUIRED_ISSUE_TYPE_NAMES = new Set([
  'fix',
  'feat',
  'docs',
  'test',
  'chore',
  'ci',
  'perf',
  'epic',
  'research',
  'refactor',
])

const REQUIRED_MILESTONES = ['M0', 'M1', 'M2']

export async function enrollRepo(opts: {
  org: string
  repo: string
  projectUrl: string
  projectId: string
  dryRun?: boolean
}): Promise<EnrollResult> {
  const { org, repo, projectUrl, projectId, dryRun = false } = opts

  // Step 1: Verify all 10 Issue Types exist
  const types = await listOrgIssueTypes(org)
  const presentNames = new Set(types.map((t) => t.name))
  const missingTypes = [...REQUIRED_ISSUE_TYPE_NAMES].filter((name) => !presentNames.has(name))
  if (missingTypes.length > 0) {
    throw new Error(
      `Issue Types prerequisite not met — run hub-bootstrap first. Missing issue types: ${missingTypes.join(', ')}`,
    )
  }

  // Step 2: dry-run short-circuit — no mutations
  if (dryRun) {
    return { enrolled: true, dryRun: true, milestonesMissing: [], verified: false }
  }

  // Step 3: Push auto-add workflow (idempotent create-or-update) to the repo's default branch.
  // GitHub Actions reads issue-scoped workflows from the default branch only — pushing to any
  // other branch is a silent failure.
  const defaultBranch = await getRepoDefaultBranch(org, repo)
  await pushWorkflowFile(org, repo, '.github/workflows/hub-add.yml', generateAutoAddToProjectYml(projectUrl), {
    branch: defaultBranch,
  })

  // Step 4: Check milestones M0/M1/M2 — warn only, no mutation
  const milestonesResult = (await ghGraphQL(MILESTONE_QUERY, { owner: org, repo })) as {
    data?: { repository?: { milestones?: { nodes: Array<{ title: string }> } } }
  }
  const presentMilestones = new Set(milestonesResult?.data?.repository?.milestones?.nodes?.map((n) => n.title) ?? [])
  const milestonesMissing = REQUIRED_MILESTONES.filter((m) => !presentMilestones.has(m))
  if (milestonesMissing.length > 0) {
    console.warn(`[${org}/${repo}] milestones missing: ${milestonesMissing.join(',')} — run make milestones-sync`)
  }

  // Step 5: Verify project has items (lightweight probe — first 1 item)
  const verifyResult = (await ghGraphQL(VERIFY_PROJECT_ITEMS_QUERY, { projectId })) as {
    data?: { node?: { items?: { nodes: Array<{ id: string }> } } }
  }
  const items = verifyResult?.data?.node?.items?.nodes ?? []
  const verified = items.length > 0

  // Step 6: Return result
  return { enrolled: true, milestonesMissing, verified }
}
