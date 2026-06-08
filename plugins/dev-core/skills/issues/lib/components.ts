import { PRIORITY_SHORT } from '../../shared/adapters/config-helpers'
import type { CICheck, Issue } from './types'

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

export const STATUS_VALUES = ['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'] as const
export { PRIORITY_VALUES } from '../../shared/adapters/config-helpers'
export const SIZE_VALUES = ['XS', 'S', 'M', 'L', 'XL'] as const

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function cleanTitle(title: string, stripTrailingSpace = true): string {
  return title
    .replace(/^(feat|chore|docs|fix|refactor)\(.*?\):\s*/i, '')
    .replace(/^Feature:\s*/i, '')
    .replace(/^LATER:\s*/i, '')
    .replace(stripTrailingSpace ? /\s*\(.*?\)\s*$/ : /\s*\(.*?\)$/, '')
}

export function shortTitle(title: string, max = 22): string {
  const cleaned = cleanTitle(title)
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
    parts.push(`<span class="dep dep-${b.state === 'OPEN' ? 'blocked' : 'done'}">${icon}#${b.number}</span>`)
  }
  for (const b of issue.blocking) {
    parts.push(`<span class="dep dep-blocking">\ud83d\udd13#${b.number}</span>`)
  }
  if (parts.length === 0) return '<span class="dep-none">-</span>'
  if (parts.length > 4) return `${parts.slice(0, 3).join(' ')} <span class="dep-overflow">[...]</span>`
  return parts.join(' ')
}

export function issueRow(issue: Issue, indent = 0, prefix = '', showProject = false): string {
  const pri = PRIORITY_SHORT[issue.priority] ?? issue.priority
  const status = STATUS_SHORT[issue.status] ?? issue.status
  const priClass = PRIORITY_CLASS[issue.priority] ?? ''
  const statusClass = STATUS_CLASS[issue.status] ?? ''
  const blockIcon = BLOCK_ICON[issue.blockStatus] ?? ''
  const blockClass = `block-${issue.blockStatus}`
  const projLabel = issue.projectLabel ?? ''
  const projAttr = projLabel ? ` data-project-label="${escHtml(projLabel)}"` : ''
  const inProjectsAttr = issue.inProjects?.length ? ` data-in-projects="${escHtml(issue.inProjects.join(','))}"` : ''
  const fullRepo = issue.url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? ''
  const repoAttr = fullRepo ? ` data-repo="${escHtml(fullRepo)}"` : ''

  const titleHtml =
    indent > 0
      ? `<span class="tree-prefix">${prefix}</span><a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a> ${escHtml(issue.title)}`
      : `<a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a> ${escHtml(issue.title)}`

  const projectCol = showProject
    ? `<td class="col-project"><span class="badge project-label">${indent === 0 ? escHtml(projLabel) : ''}</span></td>`
    : ''

  let html = `<tr class="issue-row depth-${indent} ${blockClass}" data-issue="${issue.number}" data-status="${escHtml(issue.status)}" data-size="${escHtml(issue.size)}" data-priority="${escHtml(issue.priority)}"${projAttr}${inProjectsAttr}${repoAttr}>
    <td class="col-num">${indent === 0 ? `<a href="${issue.url}" target="_blank" rel="noopener">#${issue.number}</a>` : ''}</td>
    <td class="col-title">${titleHtml}</td>
    ${projectCol}<td class="col-status"><span class="badge ${statusClass}">${escHtml(status)}</span></td>
    <td class="col-size">${escHtml(issue.size)}</td>
    <td class="col-pri"><span class="badge ${priClass}">${escHtml(pri)}</span></td>
    <td class="col-block">${blockIcon}</td>
    <td class="col-deps">${formatDeps(issue)}</td>
  </tr>\n`

  for (let i = 0; i < issue.children.length; i++) {
    const isLast = i === issue.children.length - 1
    const childPrefix = isLast ? '\u2514 ' : '\u251c '
    html += issueRow(issue.children[i], indent + 1, childPrefix, showProject)
  }
  return html
}

function extractRepo(url: string): string {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\//)
  return match ? match[1].split('/')[1] : ''
}

export function roadmapRow(issue: Issue): string {
  const repo = extractRepo(issue.url)
  const status = STATUS_SHORT[issue.status] ?? issue.status
  const statusClass = STATUS_CLASS[issue.status] ?? ''
  const pri = PRIORITY_SHORT[issue.priority] ?? issue.priority
  const priClass = PRIORITY_CLASS[issue.priority] ?? ''
  const fullRepo = issue.url.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? ''
  const inProjectsAttr = issue.inProjects?.length ? ` data-in-projects="${escHtml(issue.inProjects.join(','))}"` : ''
  const repoAttr = fullRepo ? ` data-repo="${escHtml(fullRepo)}"` : ''

  return `<tr class="issue-row" data-issue="${issue.number}"${inProjectsAttr}${repoAttr}>
    <td class="col-num"><a href="${escHtml(issue.url)}" target="_blank" rel="noopener">#${issue.number}</a></td>
    <td class="col-title">${escHtml(issue.title)}</td>
    <td class="col-project"><span class="badge project-label">${escHtml(repo)}</span></td>
    <td class="col-status"><span class="badge ${statusClass}">${escHtml(status)}</span></td>
    <td class="col-pri"><span class="badge ${priClass}">${escHtml(pri)}</span></td>
  </tr>\n`
}

const CI_SPINNER = '<span class="ci-spinner"></span>'

export function ciIcon(status: string, conclusion: string): string {
  if (status === 'COMPLETED') {
    if (conclusion === 'SUCCESS' || conclusion === '') return '\u2705'
    if (conclusion === 'FAILURE' || conclusion === 'ERROR') return '\u274c'
    if (conclusion === 'CANCELLED' || conclusion === 'TIMED_OUT') return '\u26d4'
    if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return '\u23ed'
    return '\u2753'
  }
  if (status === 'IN_PROGRESS') return CI_SPINNER
  if (status === 'QUEUED' || status === 'WAITING' || status === 'PENDING' || status === 'REQUESTED') return CI_SPINNER
  // StatusContext states
  if (status === 'SUCCESS') return '\u2705'
  if (status === 'FAILURE' || status === 'ERROR') return '\u274c'
  if (status === 'PENDING' || status === 'EXPECTED') return CI_SPINNER
  return '\u2753'
}

export function ciClass(status: string, conclusion: string): string {
  if (status === 'COMPLETED') {
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

export function ciSummary(checks: CICheck[]): { icon: string; label: string; cssClass: string } {
  if (checks.length === 0) return { icon: '', label: '', cssClass: '' }
  const total = checks.length
  const pass = checks.filter(
    (c) =>
      c.conclusion === 'SUCCESS' ||
      (c.status === 'SUCCESS' && !c.conclusion) ||
      c.conclusion === 'SKIPPED' ||
      c.conclusion === 'NEUTRAL',
  ).length
  const fail = checks.filter((c) => c.conclusion === 'FAILURE' || c.status === 'FAILURE' || c.status === 'ERROR').length
  const running = checks.filter((c) => c.status === 'IN_PROGRESS').length

  if (fail > 0) return { icon: '\u274c', label: `${fail}/${total} failed`, cssClass: 'ci-failure' }
  if (running > 0 || (pass < total && fail === 0)) {
    // Show progress: how many done so far out of total
    if (pass === 0 && running > 0) return { icon: CI_SPINNER, label: `0/${total} passed`, cssClass: 'ci-running' }
    return { icon: CI_SPINNER, label: `${pass}/${total} passed`, cssClass: 'ci-running' }
  }
  if (pass === total) return { icon: '\u2705', label: `${total} passed`, cssClass: 'ci-success' }
  return {
    icon: CI_SPINNER,
    label: `${pass}/${total} passed`,
    cssClass: 'ci-pending',
  }
}
