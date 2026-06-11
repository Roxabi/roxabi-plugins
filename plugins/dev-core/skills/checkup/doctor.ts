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
  checkDefaultWorkflowPermissions,
  checkGitHubConfig,
  checkPullRequestTarget,
  checkRulesets,
  checkSecretScanning,
  checkSecrets,
  checkWorkflows,
} from './doctor-github'
import {
  checkPrereqsSection,
  checkProjectStructure,
  checkSecurity,
  checkStandardsPaths,
  checkVercel,
} from './doctor-local'
import { formatText, type Section } from './doctor-shared'

// --- Main ---

const jsonFlag = process.argv.includes('--json')

const prereqs = checkPrereqs()
const ghOk = prereqs.gh.ok
const owner = prereqs.gitRemote.owner
const repo = prereqs.gitRemote.repo

const sections: Section[] = [
  checkPrereqsSection(prereqs),
  checkGitHubConfig(ghOk, owner, repo),
  checkWorkflows(ghOk, owner, repo),
  checkSecrets(ghOk, owner, repo),
  checkBranchProtection(ghOk, owner, repo),
  checkRulesets(ghOk, owner, repo),
  checkSecretScanning(ghOk, owner, repo),
  checkDefaultWorkflowPermissions(ghOk, owner, repo),
  checkProjectStructure(),
  checkStandardsPaths(),
  checkSecurity(),
  checkVercel(),
  checkCIPermissions(ghOk, owner, repo),
  checkPullRequestTarget(),
]

if (jsonFlag) {
  console.log(JSON.stringify(sections, null, 2))
} else {
  console.log(formatText(sections))
}

// Exit code: only hard failures trigger non-zero (warnings are informational)
const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
process.exit(hasFail ? 1 : 0)
