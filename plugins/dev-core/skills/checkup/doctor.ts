#!/usr/bin/env bun
/**
 * Doctor CLI — standalone health check for dev-core configuration.
 * Outputs formatted report (default) or JSON (--json).
 * Exit code: 0 = all pass, 1 = any failure.
 */

import { checkPrereqs } from '../shared/prereqs'
import {
  checkBranchProtection,
  checkCIPermissions,
  checkDeadGates,
  checkDefaultWorkflowPermissions,
  checkGitHubConfig,
  checkRulesets,
  checkSecretScanning,
  checkSecrets,
  checkWorkflows,
  fetchRepoMeta,
} from './doctor-github'
import {
  checkPrereqsSection,
  checkProjectStructure,
  checkPullRequestTarget,
  checkSecurity,
  checkStandardsPaths,
  checkVercel,
} from './doctor-local'
import { formatText, type Section } from './doctor-shared'
import { checkWorkflowDrift } from './workflow-drift'

// --- Main ---

const jsonFlag = process.argv.includes('--json')

const prereqs = checkPrereqs()
const ghOk = prereqs.gh.ok
const owner = prereqs.gitRemote.owner
const repo = prereqs.gitRemote.repo

// Fetched once, shared by every check needing repo settings (visibility,
// default branch, secret scanning) — previously 3 separate calls.
const meta = fetchRepoMeta(ghOk, owner, repo)

const sections: Section[] = [
  checkPrereqsSection(prereqs),
  checkGitHubConfig(ghOk, owner, repo),
  checkWorkflows(ghOk, owner, repo),
  { name: 'Workflow drift', checks: checkWorkflowDrift() },
  checkSecrets(ghOk, owner, repo),
  checkBranchProtection(ghOk, owner, repo),
  checkRulesets(ghOk, owner, repo, meta),
  checkSecretScanning(ghOk, meta),
  checkDefaultWorkflowPermissions(ghOk, owner, repo),
  checkProjectStructure(),
  checkStandardsPaths(),
  checkSecurity(),
  checkVercel(),
  checkCIPermissions(meta),
  checkPullRequestTarget(),
  checkDeadGates(ghOk, owner, repo),
]

if (jsonFlag) {
  console.log(JSON.stringify(sections, null, 2))
} else {
  console.log(formatText(sections))
}

// Exit code: only hard failures trigger non-zero (warnings are informational)
const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
process.exit(hasFail ? 1 : 0)
