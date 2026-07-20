/**
 * Workflow file push / local write I/O.
 * Imports pure generators from workflow-generators.ts.
 * Used by dev-init /init; not consumed by /checkup drift.
 */

import { run } from '../adapters/github-adapter'
import {
  generateAutoMergeYml,
  generateAutoReleaseYml,
  generateCiYml,
  generateContextLintYml,
  generateDeployYml,
  generatePrTitleYml,
} from './workflow-generators'
import { normalizeWorkflowOpts, type WorkflowOpts } from './workflow-types'
import {
  generateCloudflareDeployYml,
  generateDependabotAutomergeYml,
  generateDependabotYml,
  generateMergeOnGreenYml,
  generateSecretScanYml,
} from './workflows-fleet'

async function getToken(): Promise<string> {
  return (await run(['gh', 'auth', 'token'])).trim()
}

/** Push a single file to a repo via the GH contents API (create-or-update).
 *  `path` is the full repo-relative path (e.g. `.github/workflows/ci.yml`).
 *  With `skipExisting`, a file already present is left untouched ('skipped') —
 *  repos evolve their workflows past the templates, so overwrite must be opt-in. */
export async function pushWorkflowFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  opts: { branch: string; message?: string; skipExisting?: boolean },
): Promise<'created' | 'updated' | 'skipped'> {
  const token = await getToken()
  const { branch } = opts
  const b64 = Buffer.from(content).toString('base64')
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const checkRes = await fetch(url, { headers })
  const existing = checkRes.ok ? ((await checkRes.json()) as { sha: string }) : null
  if (existing && opts.skipExisting) return 'skipped'

  const body: Record<string, string> = {
    message: opts?.message ?? `chore: ${existing ? 'update' : 'add'} ${path}`,
    content: b64,
    branch,
  }
  if (existing?.sha) body.sha = existing.sha

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = (await res.json()) as { message?: string }
    throw new Error(`Failed to push ${path}: ${err.message ?? JSON.stringify(err)}`)
  }

  return existing ? 'updated' : 'created'
}

export interface PushResult {
  file: string
  status: 'created' | 'updated' | 'skipped'
}

interface WorkflowFile {
  /** Report name — the basename, as callers and the SKILL.md orchestrator refer to it. */
  name: string
  /** Repo-relative path — `.github/dependabot.yml` does not live under `workflows/`. */
  path: string
  content: string
  message?: string
}

/** The full file set for a stack. Single source for both the REST pusher and the local
 *  writer — the two paths must emit the same files, or one silently ships a subset. */
function workflowFileSet(o: Required<WorkflowOpts>): WorkflowFile[] {
  const mergeFile =
    o.merge === 'merge-on-green'
      ? { name: 'merge-on-green.yml', content: generateMergeOnGreenYml(o) }
      : { name: 'auto-merge.yml', content: generateAutoMergeYml() }
  const workflows: Array<{ name: string; content: string }> = [
    mergeFile,
    { name: 'pr-title.yml', content: generatePrTitleYml() },
    { name: 'context-lint.yml', content: generateContextLintYml() },
    { name: 'secret-scan.yml', content: generateSecretScanYml() },
    { name: 'ci.yml', content: generateCiYml(o) },
    { name: 'dependabot-automerge.yml', content: generateDependabotAutomergeYml() },
  ]
  if (o.deploy === 'vercel') {
    workflows.push({ name: 'deploy-preview.yml', content: generateDeployYml(o) })
  }
  if (o.deploy === 'cloudflare') {
    workflows.push({ name: 'deploy-cloudflare.yml', content: generateCloudflareDeployYml() })
  }
  // N18 (#371) — trunk repos get the merge-to-main auto-release workflow; staging-train repos never do.
  if (o.release.model === 'trunk') {
    workflows.push({ name: 'auto-release.yml', content: generateAutoReleaseYml(o) })
  }

  const files: WorkflowFile[] = workflows.map(({ name, content }) => ({
    name,
    path: `.github/workflows/${name}`,
    content,
  }))
  files.push({
    name: 'dependabot.yml',
    path: '.github/dependabot.yml',
    content: generateDependabotYml({ stack: o.stack }),
    message: 'chore: add dependabot.yml (ecosystem + github-actions)',
  })
  return files
}

/** Push only context-lint.yml (always updates — safe to re-run after generator changes). */
export async function pushContextLintYml(
  owner: string,
  repo: string,
  branch: string,
): Promise<'created' | 'updated' | 'skipped'> {
  return pushWorkflowFile(owner, repo, '.github/workflows/context-lint.yml', generateContextLintYml(), {
    branch,
    message: 'chore: update context-lint.yml (Grok + Claude harness paths)',
    skipExisting: false,
  })
}

/** Push all workflow files to a remote repo via GitHub REST API. No local git required.
 *  Default is TOP-UP: files already present on the repo are skipped (repos evolve
 *  their ci.yml far past the template). `force` overwrites. */
export async function pushWorkflows(
  owner: string,
  repo: string,
  opts: WorkflowOpts,
  branch: string,
  force = false,
): Promise<PushResult[]> {
  const o = normalizeWorkflowOpts(opts)
  const results: PushResult[] = []
  for (const { name, path, content, message } of workflowFileSet(o)) {
    const status = await pushWorkflowFile(owner, repo, path, content, {
      branch,
      message,
      skipExisting: !force,
    })
    results.push({ file: name, status })
  }
  return results
}

/** Push a specific subset of workflow files (e.g. only the generic ones).
 *  Same top-up default as pushWorkflows: existing files are skipped unless `force`. */
export async function pushGenericWorkflows(
  owner: string,
  repo: string,
  branch: string,
  force = false,
): Promise<PushResult[]> {
  const files = [
    { name: 'auto-merge.yml', content: generateAutoMergeYml() },
    { name: 'pr-title.yml', content: generatePrTitleYml() },
    { name: 'context-lint.yml', content: generateContextLintYml() },
  ]
  const results: PushResult[] = []
  for (const { name, content } of files) {
    const status = await pushWorkflowFile(owner, repo, `.github/workflows/${name}`, content, {
      branch,
      skipExisting: !force,
    })
    results.push({ file: name, status })
  }
  return results
}

/** Write workflow files under the cwd's `.github/` (offline use — no gh auth, no remote).
 *  Same top-up default as pushWorkflows: existing files are skipped unless `force`.
 *  Every file in the set is reported, including `.github/dependabot.yml`. */
export async function writeWorkflows(opts: WorkflowOpts, force = false): Promise<PushResult[]> {
  const fs = require('node:fs')
  fs.mkdirSync('.github/workflows', { recursive: true })
  const o = normalizeWorkflowOpts(opts)

  const results: PushResult[] = []
  for (const { name, path, content } of workflowFileSet(o)) {
    const existing = fs.existsSync(path)
    if (existing && !force) {
      results.push({ file: name, status: 'skipped' })
      continue
    }
    fs.writeFileSync(path, content)
    results.push({ file: name, status: existing ? 'updated' : 'created' })
  }
  return results
}
