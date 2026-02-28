import type { Branch, BranchCI, Issue, PR, VercelDeployment, WorkflowRun, Worktree } from './types'

const PRIORITY_SHORT: Record<string, string> = {
  'P0 - Urgent': 'P0',
  'P1 - High': 'P1',
  'P2 - Medium': 'P2',
  'P3 - Low': 'P3',
}

const STATUS_SHORT: Record<string, string> = {
  'In Progress': 'In Prog',
}

const BLOCK_ICON: Record<string, string> = {
  ready: '\u2705',
  blocked: '\u26d4',
  blocking: '\ud83d\udd13',
}

const PRIORITY_CLASS: Record<string, string> = {
  'P0 - Urgent': 'pri-p0',
  'P1 - High': 'pri-p1',
  'P2 - Medium': 'pri-p2',
  'P3 - Low': 'pri-p3',
}

const STATUS_CLASS: Record<string, string> = {
  'In Progress': 'status-progress',
  Review: 'status-review',
  Specs: 'status-specs',
  Analysis: 'status-analysis',
  Backlog: 'status-backlog',
  Done: 'status-done',
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function shortTitle(title: string, max = 22): string {
  const cleaned = title
    .replace(/^(feat|chore|docs|fix|refactor)\(.*?\):\s*/i, '')
    .replace(/^Feature:\s*/i, '')
    .replace(/^LATER:\s*/i, '')
    .replace(/\s*\(.*?\)\s*$/, '')
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}...` : cleaned
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatDeps(issue: Issue): string {
  const parts: string[] = []
  for (const b of issue.blockedBy) {
    const icon = b.state === 'OPEN' ? '\u26d4' : '\u2705'
    parts.push(
      `<span class="dep dep-${b.state === 'OPEN' ? 'blocked' : 'done'}">${icon}#${b.number}</span>`
    )
  }
  for (const b of issue.blocking) {
    parts.push(`<span class="dep dep-blocking">\ud83d\udd13#${b.number}</span>`)
  }
  return parts.length > 0 ? parts.join(' ') : '<span class="dep-none">-</span>'
}

export function issueRow(issue: Issue, indent = 0, prefix = ''): string {
  const pri = PRIORITY_SHORT[issue.priority] ?? issue.priority
  const status = STATUS_SHORT[issue.status] ?? issue.status
  const priClass = PRIORITY_CLASS[issue.priority] ?? ''
  const statusClass = STATUS_CLASS[issue.status] ?? ''
  const blockIcon = BLOCK_ICON[issue.blockStatus] ?? ''
  const blockClass = `block-${issue.blockStatus}`

  const titleHtml =
    indent > 0
      ? `<span class="tree-prefix">${prefix}</span><a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a> ${escHtml(issue.title)}`
      : `<a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a> ${escHtml(issue.title)}`

  let html = `<tr class="issue-row depth-${indent} ${blockClass}" data-issue="${issue.number}" data-status="${escHtml(issue.status)}" data-size="${escHtml(issue.size)}" data-priority="${escHtml(issue.priority)}">
    <td class="col-num">${indent === 0 ? `<a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a>` : ''}</td>
    <td class="col-title">${titleHtml}</td>
    <td class="col-status"><span class="badge ${statusClass}">${escHtml(status)}</span></td>
    <td class="col-size">${escHtml(issue.size)}</td>
    <td class="col-pri"><span class="badge ${priClass}">${escHtml(pri)}</span></td>
    <td class="col-block">${blockIcon}</td>
    <td class="col-deps">${formatDeps(issue)}</td>
  </tr>\n`

  for (let i = 0; i < issue.children.length; i++) {
    const isLast = i === issue.children.length - 1
    const childPrefix = isLast ? '\u2514 ' : '\u251c '
    html += issueRow(issue.children[i], indent + 1, childPrefix)
  }

  return html
}

function getPRDisplay(pr: PR): { label: string; cssClass: string } {
  if (pr.mergeable === 'CONFLICTING') return { label: 'Conflict', cssClass: 'pri-p0' }
  if (pr.isDraft) return { label: 'Draft', cssClass: 'status-backlog' }
  if (pr.reviewDecision === 'APPROVED') return { label: 'Approved', cssClass: 'status-done' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { label: 'Changes', cssClass: 'pri-p1' }
  if (pr.labels.some((l) => l.toLowerCase() === 'reviewed'))
    return { label: 'Reviewed', cssClass: 'status-review' }
  return { label: 'Review', cssClass: 'status-progress' }
}

const CI_SPINNER = '<span class="ci-spinner"></span>'

function ciIcon(status: string, conclusion: string): string {
  if (status === 'COMPLETED' || status === 'SUCCESS') {
    if (conclusion === 'SUCCESS' || conclusion === '') return '\u2705'
    if (conclusion === 'FAILURE' || conclusion === 'ERROR') return '\u274c'
    if (conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') return '\u26d4'
    if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return '\u23ed'
    return '\u2753'
  }
  if (status === 'IN_PROGRESS') return CI_SPINNER
  if (status === 'QUEUED' || status === 'WAITING' || status === 'PENDING' || status === 'REQUESTED')
    return CI_SPINNER
  // StatusContext states
  if (status === 'SUCCESS') return '\u2705'
  if (status === 'FAILURE' || status === 'ERROR') return '\u274c'
  if (status === 'PENDING' || status === 'EXPECTED') return CI_SPINNER
  return '\u2753'
}

function ciClass(status: string, conclusion: string): string {
  if (status === 'COMPLETED' || status === 'SUCCESS') {
    if (conclusion === 'SUCCESS' || conclusion === '') return 'ci-success'
    if (conclusion === 'FAILURE' || conclusion === 'ERROR') return 'ci-failure'
    if (conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') return 'ci-cancelled'
    if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'ci-skipped'
  }
  if (status === 'IN_PROGRESS') return 'ci-running'
  if (status === 'SUCCESS') return 'ci-success'
  if (status === 'FAILURE' || status === 'ERROR') return 'ci-failure'
  return 'ci-pending'
}

function ciSummary(checks: PR['checks']): { icon: string; label: string; cssClass: string } {
  if (checks.length === 0) return { icon: '', label: '', cssClass: '' }
  const total = checks.length
  const pass = checks.filter(
    (c) =>
      c.conclusion === 'SUCCESS' ||
      (c.status === 'SUCCESS' && !c.conclusion) ||
      c.conclusion === 'SKIPPED' ||
      c.conclusion === 'NEUTRAL'
  ).length
  const fail = checks.filter(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.conclusion === 'ERROR' ||
      c.status === 'FAILURE' ||
      c.status === 'ERROR'
  ).length
  const running = checks.filter((c) => c.status === 'IN_PROGRESS').length

  if (fail > 0) return { icon: '\u274c', label: `${fail}/${total} failed`, cssClass: 'ci-failure' }
  if (running > 0 || (pass < total && fail === 0)) {
    // Show progress: how many done so far out of total
    if (pass === 0 && running > 0)
      return { icon: CI_SPINNER, label: `0/${total} passed`, cssClass: 'ci-running' }
    return { icon: CI_SPINNER, label: `${pass}/${total} passed`, cssClass: 'ci-running' }
  }
  if (pass === total) return { icon: '\u2705', label: `${total} passed`, cssClass: 'ci-success' }
  return {
    icon: CI_SPINNER,
    label: `${pass}/${total} passed`,
    cssClass: 'ci-pending',
  }
}

export function renderPRs(prs: PR[]): string {
  if (prs.length === 0) return '<p class="empty-state">No open pull requests</p>'

  let html = `<table class="sub-table"><thead><tr>
    <th>#</th><th>Title</th><th>Status</th><th>CI</th><th>Changes</th><th>Updated</th>
  </tr></thead><tbody>`

  for (const pr of prs) {
    const { label: statusLabel, cssClass: statusClass } = getPRDisplay(pr)
    const age = timeAgo(pr.updatedAt)
    const summary = ciSummary(pr.checks)
    const hasChecks = pr.checks.length > 0

    html += `<tr class="pr-row" data-pr="${pr.number}">
      <td><a href="${escHtml(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a></td>
      <td class="col-pr-title" title="${escHtml(pr.title)}">
        ${escHtml(pr.title)}
        <div class="pr-branch"><span class="tree-prefix">\u2514</span><code>${escHtml(pr.branch)}</code></div>
      </td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td class="col-ci">${hasChecks ? `<button class="ci-toggle ${summary.cssClass}" onclick="toggleCI(${pr.number})" title="Toggle CI details">${summary.icon} ${summary.label}</button>` : '<span class="text-muted">-</span>'}</td>
      <td class="changes"><span class="additions">+${pr.additions}</span> <span class="deletions">-${pr.deletions}</span></td>
      <td class="text-muted">${age}</td>
    </tr>`

    if (hasChecks) {
      html += `<tr class="ci-details-row" id="ci-${pr.number}" style="display:none;">
        <td colspan="6">
          <div class="ci-checks">`
      for (const check of pr.checks) {
        const icon = ciIcon(check.status, check.conclusion)
        const cls = ciClass(check.status, check.conclusion)
        const nameHtml = check.detailsUrl
          ? `<a href="${escHtml(check.detailsUrl)}" target="_blank" rel="noopener">${escHtml(check.name)}</a>`
          : escHtml(check.name)
        html += `<div class="ci-check ${cls}">${icon} ${nameHtml}</div>`
      }
      html += `</div></td></tr>`
    }
  }
  html += `</tbody></table>`
  return html
}

export function renderBranchesAndWorktrees(branches: Branch[], worktrees: Worktree[]): string {
  const featureBranches = branches.filter((b) => b.name !== 'main' && b.name !== 'master')
  if (featureBranches.length === 0) return '<p class="empty-state">No feature branches</p>'

  // Index worktrees by branch name for quick lookup
  const wtByBranch = new Map<string, Worktree>()
  for (const wt of worktrees) {
    if (wt.branch) wtByBranch.set(wt.branch, wt)
  }

  let html = '<div class="branch-list">'
  for (const b of featureBranches) {
    const issueMatch = b.name.match(/(\d+)/)
    const issueNum = issueMatch ? `#${issueMatch[1]}` : ''
    const wt = wtByBranch.get(b.name)
    const shortPath = wt ? wt.path.replace(/^\/home\/[^/]+\/projects\//, '~/') : ''

    html += `<div class="branch-item">
      <span class="branch-icon">&#9095;</span>
      <code>${escHtml(b.name)}</code>
      ${issueNum ? `<span class="branch-issue">${issueNum}</span>` : ''}
      ${b.isCurrent ? '<span class="badge status-progress">current</span>' : ''}
      ${wt ? `<span class="wt-path">${escHtml(shortPath)}</span>` : ''}
    </div>`
  }
  html += '</div>'
  return html
}

const DEPLOY_STATE_DISPLAY: Record<string, { icon: string; label: string; cls: string }> = {
  BUILDING: { icon: '<span class="ci-spinner"></span>', label: 'Building', cls: 'vd-building' },
  QUEUED: { icon: '<span class="ci-spinner"></span>', label: 'Queued', cls: 'vd-queued' },
  INITIALIZING: {
    icon: '<span class="ci-spinner"></span>',
    label: 'Initializing',
    cls: 'vd-queued',
  },
  READY: { icon: '\u2705', label: 'Ready', cls: 'vd-ready' },
  ERROR: { icon: '\u274c', label: 'Error', cls: 'vd-error' },
  CANCELED: { icon: '\u26d4', label: 'Canceled', cls: 'vd-error' },
}

const STEP_ICON: Record<string, string> = {
  done: '\u2705',
  running: '<span class="ci-spinner"></span>',
  pending: '\u25cb',
  error: '\u274c',
}

function renderBuildPipeline(steps: VercelDeployment['buildSteps']): string {
  if (steps.length === 0) return ''
  return steps
    .map(
      (s) =>
        `<span class="vd-step vd-step-${s.status}">${STEP_ICON[s.status]} ${escHtml(s.name)}</span>`
    )
    .join('<span class="vd-step-arrow">\u2192</span>')
}

const OVERALL_STATE_DISPLAY: Record<string, { icon: string; label: string; cls: string }> = {
  SUCCESS: { icon: '\u2705', label: 'Passing', cls: 'ci-success' },
  FAILURE: { icon: '\u274c', label: 'Failing', cls: 'ci-failure' },
  ERROR: { icon: '\u274c', label: 'Error', cls: 'ci-failure' },
  PENDING: { icon: CI_SPINNER, label: 'Pending', cls: 'ci-running' },
  EXPECTED: { icon: CI_SPINNER, label: 'Running', cls: 'ci-running' },
}

export function renderBranchCI(branches: BranchCI[]): string {
  if (branches.length === 0) return '<p class="empty-state">No CI data</p>'

  let html = `<table class="sub-table"><thead><tr>
    <th>Branch</th><th>Status</th><th>CI</th><th>Commit</th><th>Updated</th>
  </tr></thead><tbody>`

  for (const b of branches) {
    const stateDisplay = OVERALL_STATE_DISPLAY[b.overallState] ?? {
      icon: '\u2753',
      label: b.overallState || 'Unknown',
      cls: 'ci-pending',
    }
    const summary = ciSummary(b.checks)
    const hasChecks = b.checks.length > 0
    const branchId = `branch-ci-${b.branch}`
    const age = b.committedAt ? timeAgo(b.committedAt) : ''
    const branchBadgeCls = b.branch === 'main' ? 'status-done' : 'status-review'

    html += `<tr class="pr-row">
      <td><span class="badge ${branchBadgeCls}">${escHtml(b.branch)}</span></td>
      <td><span class="${stateDisplay.cls}">${stateDisplay.icon} ${stateDisplay.label}</span></td>
      <td class="col-ci">${hasChecks ? `<button class="ci-toggle ${summary.cssClass}" onclick="toggleCI('${branchId}')" title="Toggle CI details">${summary.icon} ${summary.label}</button>` : '<span class="text-muted">-</span>'}</td>
      <td class="text-muted">${b.commitSha ? `<code title="${escHtml(b.commitMessage)}">${escHtml(b.commitSha)}</code> ${escHtml(shortTitle(b.commitMessage, 30))}` : '-'}</td>
      <td class="text-muted">${age}</td>
    </tr>`

    if (hasChecks) {
      html += `<tr class="ci-details-row" id="${branchId}" style="display:none;">
        <td colspan="5">
          <div class="ci-checks">`
      for (const check of b.checks) {
        const icon = ciIcon(check.status, check.conclusion)
        const cls = ciClass(check.status, check.conclusion)
        const nameHtml = check.detailsUrl
          ? `<a href="${escHtml(check.detailsUrl)}" target="_blank" rel="noopener">${escHtml(check.name)}</a>`
          : escHtml(check.name)
        html += `<div class="ci-check ${cls}">${icon} ${nameHtml}</div>`
      }
      html += `</div></td></tr>`
    }
  }
  html += `</tbody></table>`
  return html
}

export function renderVercelDeployments(deployments: VercelDeployment[]): string {
  if (deployments.length === 0) return ''

  let html = `<div class="section">
    <h2>\u25b2 Vercel Deployments</h2>
    <div class="vd-list">`

  for (const d of deployments) {
    const display = DEPLOY_STATE_DISPLAY[d.state] ?? {
      icon: '\u2753',
      label: d.state,
      cls: '',
    }
    const env = d.target === 'production' ? 'prod' : 'preview'
    const envCls = d.target === 'production' ? 'vd-env-prod' : 'vd-env-preview'
    const branch = d.meta.githubCommitRef ?? ''
    const msg = d.meta.githubCommitMessage ? shortTitle(d.meta.githubCommitMessage, 40) : ''
    const age = d.createdAt ? timeAgo(new Date(d.createdAt).toISOString()) : ''
    const deployUrl = `https://${d.url}`
    const inspectUrl = d.inspectorUrl || `https://vercel.com`
    const pipeline = renderBuildPipeline(d.buildSteps)

    html += `<div class="vd-card ${display.cls}">
      <div class="vd-item">
        <span class="vd-state">${display.icon} ${display.label}</span>
        <span class="badge ${envCls}">${env}</span>
        <a href="${escHtml(deployUrl)}" target="_blank" rel="noopener" class="vd-url">${escHtml(d.url)}</a>
        ${branch ? `<code class="vd-branch">${escHtml(branch)}</code>` : ''}
        ${msg ? `<span class="vd-msg">${escHtml(msg)}</span>` : ''}
        <span class="text-muted vd-age">${age}</span>
        <a href="${escHtml(inspectUrl)}" target="_blank" rel="noopener" class="vd-inspect" title="Inspect on Vercel">\u2197</a>
      </div>
      ${pipeline ? `<div class="vd-pipeline">${pipeline}</div>` : ''}
    </div>`
  }

  html += '</div></div>'
  return html
}

const WR_STATUS_DISPLAY: Record<string, { icon: string; label: string; cls: string }> = {
  in_progress: { icon: '\ud83d\udd04', label: 'Running', cls: 'wr-badge-running' },
  queued: { icon: '\u23f3', label: 'Queued', cls: 'wr-badge-queued' },
}

const WR_CONCLUSION_DISPLAY: Record<string, { icon: string; label: string; cls: string }> = {
  success: { icon: '\u2705', label: 'Success', cls: 'wr-badge-success' },
  failure: { icon: '\u274c', label: 'Failed', cls: 'wr-badge-failure' },
  cancelled: { icon: '\u2298', label: 'Cancelled', cls: 'wr-badge-cancelled' },
  skipped: { icon: '\u23ed', label: 'Skipped', cls: 'wr-badge-cancelled' },
}

const WR_EVENT_LABEL: Record<string, string> = {
  workflow_dispatch: 'manual',
  pull_request: 'PR',
  push: 'push',
}

export function renderWorkflowRuns(runs: WorkflowRun[]): string {
  if (runs.length === 0) return ''

  let html = `<div class="section"><h2>Workflow Runs</h2><div class="wr-cards">`

  for (const run of runs) {
    let badge: { icon: string; label: string; cls: string }
    if (run.status === 'completed') {
      badge = WR_CONCLUSION_DISPLAY[run.conclusion ?? ''] ?? {
        icon: '\u2753',
        label: run.conclusion ?? run.status,
        cls: 'wr-badge-queued',
      }
    } else {
      badge = WR_STATUS_DISPLAY[run.status] ?? {
        icon: '\u2753',
        label: run.status,
        cls: 'wr-badge-queued',
      }
    }

    const eventLabel = WR_EVENT_LABEL[run.event] ?? run.event
    const age = timeAgo(run.updatedAt)
    const commitText = run.displayTitle || run.headCommitMessage

    html += `<div class="wr-card">
      <div class="wr-item">
        <span class="wr-badge ${badge.cls}">${badge.icon} ${badge.label}</span>
        <a href="${escHtml(run.htmlUrl)}" target="_blank" rel="noopener" class="wr-name">${escHtml(run.name)}</a>
        ${run.headBranch ? `<code class="vd-branch">${escHtml(run.headBranch)}</code>` : ''}
        ${commitText ? `<span class="vd-msg">${escHtml(commitText)}</span>` : ''}
        <span class="wr-event badge">${escHtml(eventLabel)}</span>
        <span class="text-muted vd-age">${age}</span>
      </div>
    </div>`
  }

  html += '</div></div>'
  return html
}
