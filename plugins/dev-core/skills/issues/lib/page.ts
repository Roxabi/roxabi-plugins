import type { WorkspaceProject } from '../../shared/ports/workspace'
import {
  branchCIRows,
  escHtml,
  issueRow,
  PRIORITY_VALUES,
  prRows,
  renderBranchCI,
  renderBranchesAndWorktrees,
  renderPRs,
  renderVercelDeployments,
  renderWorkflowRuns,
  roadmapRow,
  SIZE_VALUES,
  STATUS_VALUES,
  vercelCards,
  workflowRunCards,
} from './components'
import { buildDepGraph, renderDepGraph } from './graph'
import { PAGE_STYLES } from './page-styles'
import type { Branch, BranchCI, Issue, PR, VercelDeployment, WorkflowRun, Worktree } from './types'

// ---------------------------------------------------------------------------
// Per-project column helpers
// ---------------------------------------------------------------------------

const COLUMN_SCHEMA = {
  technical: { col2: { label: 'Size', icon: '📐' }, col3: { label: 'Pri', icon: '🔥' } },
  company: { col2: { label: 'Quarter', icon: '📅' }, col3: { label: 'Pillar', icon: '🏛' } },
} as const

export function columnLabel(p: WorkspaceProject, slot: 'col2' | 'col3') {
  return COLUMN_SCHEMA[p.type ?? 'technical'][slot]
}

export const showCI = (p: WorkspaceProject): boolean => (p.type ?? 'technical') !== 'company'
export const showDevLinks = (p: WorkspaceProject): boolean => (p.type ?? 'technical') !== 'company'
export const showSubIssues = (p: WorkspaceProject): boolean => (p.type ?? 'technical') !== 'company'

export function defaultSort(p: WorkspaceProject): string {
  return (p.type ?? 'technical') === 'company' ? 'col2-asc' : 'priority-desc'
}

/** Build JSON for `data-field-sections` attribute — drives per-project context menu. */
function buildFieldSections(project?: WorkspaceProject): string {
  const c2 = project ? columnLabel(project, 'col2') : { label: 'Size', icon: '📐' }
  const c3 = project ? columnLabel(project, 'col3') : { label: 'Pri', icon: '🔥' }
  const statusOpts = project?.fieldIds?.statusOptions ? Object.keys(project.fieldIds.statusOptions) : [...STATUS_VALUES]
  const col2Opts = project?.fieldIds?.col2Options
    ? Object.keys(project.fieldIds.col2Options)
    : project?.type === 'company'
      ? []
      : [...SIZE_VALUES]
  const col3Opts = project?.fieldIds?.col3Options
    ? Object.keys(project.fieldIds.col3Options)
    : project?.type === 'company'
      ? []
      : [...PRIORITY_VALUES]
  return JSON.stringify([
    { label: 'Status', field: 'status', options: statusOpts },
    { label: c2.label, field: 'col2', options: col2Opts },
    { label: c3.label, field: 'col3', options: col3Opts },
  ])
}

const INITIAL_VISIBLE = 8

function splitIssueRows(issues: Issue[], showProject = false) {
  return {
    visibleRows: issues
      .slice(0, INITIAL_VISIBLE)
      .map((i) => issueRow(i, 0, '', showProject))
      .join(''),
    hiddenRows: issues
      .slice(INITIAL_VISIBLE)
      .map((i) => issueRow(i, 0, '', showProject))
      .join(''),
    hasMore: issues.length > INITIAL_VISIBLE,
    hiddenCount: issues.length - INITIAL_VISIBLE,
  }
}

function buildTabBar(projects: WorkspaceProject[], activeTab: string, hasRoadmap = false): string {
  const roadmapTab = hasRoadmap
    ? `<button class="tab${activeTab === 'Roadmap' ? ' active' : ''}" onclick="switchTab('Roadmap')">Roadmap</button>`
    : ''
  const allTab = `<button class="tab${activeTab === 'All' ? ' active' : ''}" onclick="switchTab('All')">All</button>`
  const projectTabs = projects.map((p) => buildProjectTab(p.label, p.repo, activeTab)).join('\n')
  return `<div class="tab-bar" id="tab-bar">${roadmapTab}\n${allTab}\n${projectTabs}\n${buildAddButton()}</div>`
}

function buildProjectTab(label: string, repo: string, activeTab: string): string {
  return `<button class="tab${label === activeTab ? ' active' : ''}" data-repo="${escHtml(label)}" data-slug="${escHtml(repo)}" onclick="switchTab('${escHtml(label)}')">${escHtml(label)}<span class="tab-close" onclick="event.stopPropagation();removeProject('${escHtml(repo)}')">&#215;</span></button>`
}

function buildAddButton(): string {
  return `<button class="tab add-btn" onclick="openAddDialog()" title="Add project">+</button>`
}

type ProjectMeta = {
  prs: PR[]
  branchCI: BranchCI[]
  workflowRuns: WorkflowRun[]
  deployments: VercelDeployment[]
  branches: Branch[]
  worktrees: Worktree[]
}

function buildAllView(byProject: Map<string, Issue[]>, workspaceProjects?: WorkspaceProject[]): string {
  if (byProject.size === 0) {
    return '<div class="empty-state">No projects registered — click + to add one</div>'
  }

  // "All" tab: no issues (user navigates per-project tabs for issues)
  const allViewHtml = '<div data-project="All"></div>'

  // Per-project tables (shown when that project's tab is active)
  const projectViews = [...byProject.entries()]
    .map(([label, issues]) => {
      const project = workspaceProjects?.find((p) => p.label === label)
      // Tag issues with projectLabel for context menu
      const tagged = issues.map((i) => ({ ...i, projectLabel: label }))
      const depNodes = buildDepGraph(tagged)
      const graphHtml =
        (!project || showSubIssues(project)) && depNodes.length > 0
          ? `<div class="section graph-subsection">
        <h3>Dependency Graph</h3>
        <div class="graph-container">${renderDepGraph(depNodes, tagged)}</div>
      </div>`
          : ''
      return `<div data-project="${escHtml(label)}" style="display:none;">
      ${tagged.length === 0 ? '<p class="no-issues">No open issues</p>' : buildIssueTable(tagged, project)}
      ${graphHtml}
    </div>`
    })
    .join('\n')

  return `${allViewHtml}\n${projectViews}`
}

function buildIssueTable(issues: Issue[], project?: WorkspaceProject): string {
  const { visibleRows, hiddenRows, hasMore, hiddenCount } = splitIssueRows(issues)
  const c2 = project ? columnLabel(project, 'col2') : { label: 'Size', icon: '📐' }
  const c3 = project ? columnLabel(project, 'col3') : { label: 'Pri', icon: '🔥' }
  const fieldSections = escHtml(buildFieldSections(project))
  const projectLabel = project ? ` data-project-label="${escHtml(project.label)}"` : ''
  return `<table data-field-sections="${fieldSections}"${projectLabel}>
    <thead>
      <tr>
        <th>#</th>
        <th>Title</th>
        <th>Status</th>
        <th>${c2.icon} ${c2.label}</th>
        <th>${c3.icon} ${c3.label}</th>
        <th>&#9889;</th>
        <th>Deps</th>
      </tr>
    </thead>
    <tbody>
      ${visibleRows}
      ${
        hasMore
          ? `<tr class="show-more-row"><td colspan="7" style="text-align:center;padding:12px;">
        <button class="show-more-btn" onclick="var tb=this.closest('table').querySelector('.hidden-issues-body');tb.style.display='';this.parentElement.parentElement.style.display='none';">
          Show ${hiddenCount} more issue${hiddenCount > 1 ? 's' : ''}
        </button>
      </td></tr>`
          : ''
      }
    </tbody>
    <tbody class="hidden-issues-body" style="display:none;">
      ${hiddenRows}
      <tr class="show-less-row"><td colspan="7" style="text-align:center;padding:12px;">
        <button class="show-more-btn" onclick="var tbl=this.closest('table');tbl.querySelector('.hidden-issues-body').style.display='none';tbl.querySelector('.show-more-row').style.display='';">
          Show less
        </button>
      </td></tr>
    </tbody>
  </table>`
}

function buildWorkspaceDialog(): string {
  return `
<dialog id="add-project-dialog">
  <form method="dialog">
    <h3>Add project to workspace</h3>
    <label>Repo (owner/name): <input type="text" id="add-repo-input" placeholder="Roxabi/my-repo" /></label>
    <div class="dialog-actions">
      <button type="button" onclick="submitAddProject()">Add</button>
      <button type="button" onclick="document.getElementById('add-project-dialog').close()">Cancel</button>
    </div>
  </form>
</dialog>
<script>
function openAddDialog() { document.getElementById('add-project-dialog').showModal() }
async function submitAddProject() {
  var repo = document.getElementById('add-repo-input').value.trim()
  if (!repo) return
  var res = await fetch('/api/workspace/add', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo}) })
  var data = await res.json()
  if (!data.ok) { alert('Error: ' + data.error); return }
  document.getElementById('add-project-dialog').close()
}
async function removeProject(repo) {
  if (!confirm('Remove ' + repo + ' from workspace?')) return
  await fetch('/api/workspace/remove', {method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo})})
}
</script>`
}

function buildRoadmapView(items: Issue[]): string {
  if (items.length === 0) {
    return '<div class="empty-state">No roadmap items yet</div>'
  }
  const rows = items.map((i) => roadmapRow(i)).join('')
  return `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>Title</th>
        <th>Repo</th>
        <th>Status</th>
        <th>Priority</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`
}

export function buildHtml(
  issues: Issue[],
  prs: PR[],
  branches: Branch[],
  worktrees: Worktree[],
  deployments: VercelDeployment[],
  branchCI: BranchCI[],
  workflowRuns: WorkflowRun[],
  fetchMs: number,
  updatedAt: number,
  byProject?: Map<string, Issue[]>,
  workspaceProjects?: WorkspaceProject[],
  byProjectMeta?: Map<string, ProjectMeta>,
  roadmapItems?: Issue[],
  roadmapProject?: { label: string; projectId: string },
  truncatedProjects?: string[],
): string {
  const isMultiProject = byProject !== undefined && byProject.size > 0
  const allIssues = isMultiProject && byProject ? [...byProject.values()].flat() : issues
  const totalCount = allIssues.reduce((sum, i) => sum + 1 + i.children.length, 0)

  const { visibleRows, hiddenRows, hasMore, hiddenCount } = splitIssueRows(issues)
  const depNodes = isMultiProject ? [] : buildDepGraph(allIssues)
  const depGraphHtml = isMultiProject ? '' : renderDepGraph(depNodes, allIssues)
  const branchesHtml =
    isMultiProject && byProjectMeta
      ? (() => {
          const groups = [...byProjectMeta.entries()]
            .filter(([, m]) => {
              const featureBranches = m.branches.filter((b) => b.name !== 'main' && b.name !== 'master')
              return featureBranches.length > 0 || m.worktrees.length > 1
            })
            .map(
              ([l, m]) =>
                `<div data-project="${escHtml(l)}"><div class="project-sep-inline">${escHtml(l)}</div>${renderBranchesAndWorktrees(m.branches, m.worktrees)}</div>`,
            )
            .join('')
          return groups || '<p class="empty-state">No feature branches</p>'
        })()
      : renderBranchesAndWorktrees(branches, worktrees)

  // In multi-project mode, build combined sections with per-project [data-project] groups
  // so switchTab can show/hide across ALL sections uniformly.
  const projectFor = (l: string): WorkspaceProject | undefined => workspaceProjects?.find((p) => p.label === l)

  const vercelHtml =
    isMultiProject && byProjectMeta
      ? (() => {
          const withV = [...byProjectMeta.entries()].filter(([l, m]) => {
            const p = projectFor(l)
            return m.deployments.length > 0 && (!p || showDevLinks(p))
          })
          if (withV.length === 0) return ''
          const groups = withV
            .map(
              ([l, m]) =>
                `<div data-project="${escHtml(l)}"><div class="project-sep-inline">${escHtml(l)}</div>${vercelCards(m.deployments)}</div>`,
            )
            .join('')
          return `<div class="section"><h2>\u25b2 Vercel Deployments</h2><div class="vd-list">${groups}</div></div>`
        })()
      : renderVercelDeployments(deployments)
  const wrHtml =
    isMultiProject && byProjectMeta
      ? (() => {
          const withWR = [...byProjectMeta.entries()].filter(([l, m]) => {
            const p = projectFor(l)
            return m.workflowRuns.length > 0 && (!p || showCI(p))
          })
          if (withWR.length === 0) return ''
          const groups = withWR
            .map(
              ([l, m]) =>
                `<div data-project="${escHtml(l)}"><div class="project-sep-inline">${escHtml(l)}</div>${workflowRunCards(m.workflowRuns)}</div>`,
            )
            .join('')
          return `<div class="section"><h2>Workflow Runs</h2><div class="wr-cards">${groups}</div></div>`
        })()
      : renderWorkflowRuns(workflowRuns)
  const prsHtml =
    isMultiProject && byProjectMeta
      ? (() => {
          const withPRs = [...byProjectMeta.entries()].filter(([l, m]) => {
            const p = projectFor(l)
            return m.prs.length > 0 && (!p || showDevLinks(p))
          })
          if (withPRs.length === 0) return ''
          const bodies = withPRs
            .map(
              ([l, m]) =>
                `<tbody data-project="${escHtml(l)}"><tr class="project-sep-row"><td colspan="6">${escHtml(l)}</td></tr>${prRows(m.prs)}</tbody>`,
            )
            .join('')
          return `<table class="sub-table"><thead><tr>
    <th>#</th><th>Title</th><th>Status</th><th>CI</th><th>Changes</th><th>Updated</th>
  </tr></thead>${bodies}</table>`
        })()
      : renderPRs(prs)
  const ciHtml =
    isMultiProject && byProjectMeta
      ? (() => {
          const withCI = [...byProjectMeta.entries()].filter(([l, m]) => {
            const p = projectFor(l)
            return shouldShowCI(m.branchCI) && (!p || showCI(p))
          })
          if (withCI.length === 0) return ''
          const bodies = withCI
            .map(
              ([l, m]) =>
                `<tbody data-project="${escHtml(l)}"><tr class="project-sep-row"><td colspan="5">${escHtml(l)}</td></tr>${branchCIRows(m.branchCI, l)}</tbody>`,
            )
            .join('')
          return `<table class="sub-table"><thead><tr>
    <th>Branch</th><th>Status</th><th>CI</th><th>Commit</th><th>Updated</th>
  </tr></thead>${bodies}</table>`
        })()
      : renderBranchCI(branchCI)
  const showCISection = isMultiProject ? !!ciHtml : shouldShowCI(branchCI)
  const showPRs = isMultiProject ? !!prsHtml : prs.length > 0

  const hasRoadmap = roadmapItems !== undefined
  const defaultTab = hasRoadmap ? 'Roadmap' : 'All'
  const tabBarHtml =
    isMultiProject && byProject
      ? buildTabBar(
          workspaceProjects ?? [...byProject.keys()].map((label) => ({ label, repo: label, projectId: '' })),
          defaultTab,
          hasRoadmap,
        )
      : ''
  const roadmapHtml = hasRoadmap
    ? `<div id="section-roadmap" class="section">
      <h2>Roadmap</h2>
      ${buildRoadmapView(roadmapItems ?? [])}
    </div>`
    : ''

  const issuesSectionHtml =
    isMultiProject && byProject
      ? buildAllView(byProject, workspaceProjects)
      : `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>Title</th>
        <th>Status</th>
        <th>Size</th>
        <th>Pri</th>
        <th>&#9889;</th>
        <th>Deps</th>
      </tr>
    </thead>
    <tbody id="issues-visible">
      ${visibleRows}
      ${
        hasMore
          ? `<tr id="show-more-row"><td colspan="7" style="text-align:center;padding:12px;">
        <button id="show-more-btn" onclick="document.getElementById('hidden-issues').style.display='';document.getElementById('show-less-row').style.display='';this.parentElement.parentElement.style.display='none';">
          Show ${hiddenCount} more issue${hiddenCount > 1 ? 's' : ''}
        </button>
      </td></tr>`
          : ''
      }
    </tbody>
    <tbody id="hidden-issues" style="display:none;">
      ${hiddenRows}
      <tr id="show-less-row" style="display:none;"><td colspan="7" style="text-align:center;padding:12px;">
        <button onclick="document.getElementById('hidden-issues').style.display='none';document.getElementById('show-less-row').style.display='none';document.getElementById('show-more-row').style.display='';">
          Show less
        </button>
      </td></tr>
    </tbody>
  </table>`

  const workspaceDialogHtml = isMultiProject ? buildWorkspaceDialog() : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issues Dashboard</title>
<style>
${PAGE_STYLES}
${LIVE_STYLES}
</style>
</head>
<body data-updated-at="${updatedAt}" data-ws-projects="${escHtml(
    JSON.stringify([
      ...(workspaceProjects ?? []).map((p) => ({
        label: p.label,
        repo: p.repo,
        projectId: p.projectId,
        isRoadmap: p.type === 'company',
      })),
      ...(roadmapProject
        ? [{ label: roadmapProject.label, repo: '', projectId: roadmapProject.projectId, isRoadmap: true }]
        : []),
    ]),
  )}">
  <header>
    <h1>Issues Dashboard</h1>
    <span id="issue-count" class="count">${totalCount} issues</span>
    <span class="meta">
      <span id="live-indicator" class="live-dot connecting" title="Connecting..."></span>
      <span id="live-status">Connecting...</span>
      &middot; <span id="fetch-time">Fetched in ${fetchMs}ms</span>
    </span>
  </header>

  ${
    truncatedProjects && truncatedProjects.length > 0
      ? `<div class="truncation-warning">⚠️ Some issues may not be displayed — projects exceeding 100 items are truncated: <strong>${truncatedProjects.map(escHtml).join(', ')}</strong></div>`
      : ''
  }

  ${tabBarHtml}

  ${roadmapHtml}

  <div id="section-vercel"${hasRoadmap ? ' style="display:none;"' : ''}>${vercelHtml}</div>

  <div id="section-workflow-runs"${hasRoadmap ? ' style="display:none;"' : ''}>${wrHtml}</div>

  <div id="section-ci"${hasRoadmap ? ' style="display:none;"' : ''}>${showCISection ? `<div class="section"><h2>CI Status</h2>${ciHtml}</div>` : ''}</div>

  <div id="section-prs"${hasRoadmap ? ' style="display:none;"' : ''}>${showPRs ? `<div class="section"><h2>Pull Requests</h2>${prsHtml}</div>` : ''}</div>

  <div id="section-issues" class="section"${isMultiProject || hasRoadmap ? ' style="display:none;"' : ''}>
    <h2>Issues</h2>
    <div id="section-issues-content">${issuesSectionHtml}</div>
  </div>

  <div class="legend"${isMultiProject ? ' style="display:none;"' : ''}>
    <span>\u26d4 blocked</span>
    <span>\ud83d\udd13 blocking</span>
    <span>\u2705 ready</span>
  </div>

  <div id="section-graph"${isMultiProject ? ' style="display:none;"' : ''}>${
    isMultiProject
      ? ''
      : `<div class="section">
    <h2>Dependency Graph</h2>
    <div class="graph-container">${depGraphHtml}</div>
  </div>`
  }</div>

  <div id="section-branches" class="section"${hasRoadmap ? ' style="display:none;"' : ''}>
    <h2>Branches &amp; Worktrees</h2>
    ${branchesHtml}
  </div>

  ${workspaceDialogHtml}

  <!-- Context menu — rebuilt dynamically from table's data-field-sections on each open -->
  <div id="ctx-menu" class="ctx-menu">
    <div class="ctx-header">#<span id="ctx-issue-num"></span></div>
    <div id="ctx-body"></div>
  </div>
  <div id="toast" class="toast"></div>

  <script>
  window.__wsProjects = JSON.parse(document.body.dataset.wsProjects || '[]');
  function switchTab(label) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab[data-repo]').forEach(function(t) {
      if (t.dataset.repo === label) t.classList.add('active');
    });
    if (label === 'All' || label === 'Roadmap') {
      document.querySelectorAll('.tab:not([data-repo]):not(.add-btn)').forEach(function(t) {
        if (t.textContent.trim() === label) t.classList.add('active');
      });
    }

    var roadmapSec = document.getElementById('section-roadmap');
    var issuesSec = document.getElementById('section-issues');
    var legendSec = document.querySelector('.legend');
    var graphSec = document.getElementById('section-graph');

    // Roadmap tab: show roadmap, hide everything else
    if (label === 'Roadmap') {
      if (roadmapSec) roadmapSec.style.display = '';
      if (issuesSec) issuesSec.style.display = 'none';
      if (legendSec) legendSec.style.display = 'none';
      if (graphSec) graphSec.style.display = 'none';
      ['section-vercel', 'section-workflow-runs', 'section-ci', 'section-prs', 'section-branches'].forEach(function(id) {
        var sec = document.getElementById(id);
        if (sec) sec.style.display = 'none';
      });
      return;
    }

    // Non-roadmap tabs: hide roadmap
    if (roadmapSec) roadmapSec.style.display = 'none';

    // Issues section: hide on All tab (no issues), show per-project view on project tabs
    if (label === 'All') {
      if (issuesSec) issuesSec.style.display = 'none';
      if (legendSec) legendSec.style.display = 'none';
      if (graphSec) graphSec.style.display = 'none';
    } else {
      if (issuesSec) issuesSec.style.display = '';
      if (legendSec) legendSec.style.display = '';
      if (graphSec) graphSec.style.display = '';
    }
    document.querySelectorAll('#section-issues-content > [data-project]').forEach(function(el) {
      el.style.display = (label === 'All' ? el.dataset.project === 'All' : el.dataset.project === label) ? '' : 'none';
    });

    // Other sections with [data-project] groups (CI, PRs, Vercel, workflow runs, branches)
    var tabSections = '#section-ci [data-project], #section-prs [data-project], #section-vercel [data-project], #section-workflow-runs [data-project], #section-branches [data-project]';
    var tabSectionIds = ['section-ci', 'section-prs', 'section-vercel', 'section-workflow-runs'];
    if (label === 'All') {
      document.querySelectorAll(tabSections).forEach(function(el) { el.style.display = ''; });
      tabSectionIds.forEach(function(id) {
        var sec = document.getElementById(id);
        if (sec) sec.style.display = '';
      });
    } else {
      document.querySelectorAll(tabSections).forEach(function(el) {
        el.style.display = el.dataset.project === label ? '' : 'none';
      });
      tabSectionIds.forEach(function(id) {
        var sec = document.getElementById(id);
        if (!sec) return;
        var projEls = sec.querySelectorAll('[data-project]');
        if (projEls.length === 0) return;
        var hasVisible = Array.from(projEls).some(function(el) { return el.style.display !== 'none'; });
        sec.style.display = hasVisible ? '' : 'none';
      });
    }

    // Restore branches and dev sections visibility for non-Roadmap tabs
    var branchesSec = document.getElementById('section-branches');
    if (branchesSec) branchesSec.style.display = '';

    // Show-more / collapse state
    if (label === 'All') {
      document.querySelectorAll('.hidden-issues-body').forEach(function(b) { b.style.display = 'none'; });
      document.querySelectorAll('.show-more-row').forEach(function(tr) { tr.style.display = ''; });
    } else {
      // Expand all issues for the active project
      document.querySelectorAll('[data-project="' + label + '"] .hidden-issues-body').forEach(function(b) { b.style.display = ''; });
      document.querySelectorAll('[data-project="' + label + '"] .show-more-row').forEach(function(tr) { tr.style.display = 'none'; });
      document.querySelectorAll('[data-project="' + label + '"] .show-less-row').forEach(function(tr) { tr.style.display = 'none'; });
    }
  }

  function toggleCI(id) {
    var row = document.getElementById(typeof id === 'number' ? 'ci-' + id : id);
    if (!row) return;
    row.style.display = row.style.display === 'none' ? '' : 'none';
  }

  (function() {
    var ctxMenu = document.getElementById('ctx-menu');
    var ctxNum = document.getElementById('ctx-issue-num');
    var toast = document.getElementById('toast');
    var ctxIssue = null;

    var ctxBody = document.getElementById('ctx-body');
    // Default field sections (technical project fallback)
    var DEFAULT_SECTIONS = [
      { label: 'Status', field: 'status', options: ${JSON.stringify([...STATUS_VALUES])} },
      { label: 'Size', field: 'col2', options: ${JSON.stringify([...SIZE_VALUES])} },
      { label: 'Pri', field: 'col3', options: ${JSON.stringify([...PRIORITY_VALUES])} },
    ];

    // -----------------------------------------------------------------------
    // Context menu
    // -----------------------------------------------------------------------
    document.addEventListener('contextmenu', function(e) {
      var row = e.target.closest('.issue-row');
      if (!row) { ctxMenu.classList.remove('visible'); return; }

      e.preventDefault();
      // col2 value stored in data-size (legacy field name), col3 in data-priority
      ctxIssue = {
        number: row.dataset.issue,
        status: row.dataset.status,
        col2: row.dataset.size,
        col3: row.dataset.priority,
        projectLabel: row.dataset.projectLabel || (row.closest('table') ? row.closest('table').dataset.projectLabel : null),
        inProjects: row.dataset.inProjects || '',
        repo: row.dataset.repo || '',
      };
      ctxNum.textContent = ctxIssue.number;

      // Read per-project sections from the containing table, fall back to defaults
      var table = row.closest('table');
      var sections = DEFAULT_SECTIONS;
      if (table && table.dataset.fieldSections) {
        try { sections = JSON.parse(table.dataset.fieldSections); } catch (ex) { /* use default */ }
      }

      // Rebuild menu body from sections
      var html = '';
      sections.forEach(function(s) {
        html += '<div class="ctx-section">' + s.label + '</div>';
        s.options.forEach(function(v) {
          var isActive = (s.field === 'status' && v === ctxIssue.status) ||
                         (s.field === 'col2' && v === ctxIssue.col2) ||
                         (s.field === 'col3' && v === ctxIssue.col3);
          html += '<div class="ctx-item' + (isActive ? ' active' : '') +
            '" data-field="' + s.field + '" data-value="' + v.replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '">' +
            v.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</div>';
        });
      });
      // Projects section — add to / remove from any workspace project
      var allProjects = window.__wsProjects || [];
      if (allProjects.length > 0) {
        var inProjectsList = (ctxIssue.inProjects || '').split(',').filter(Boolean);
        html += '<div class="ctx-section">Projects</div>';
        allProjects.forEach(function(p) {
          var isIn = inProjectsList.indexOf(p.label) !== -1;
          html += '<div class="ctx-item ctx-project-item' + (isIn ? ' active' : '') + '"' +
            ' data-action="' + (isIn ? 'remove' : 'add') + '"' +
            ' data-proj-label="' + p.label.replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '">' +
            p.label.replace(/&/g,'&amp;').replace(/</g,'&lt;') +
            '</div>';
        });
      }
      ctxBody.innerHTML = html;

      ctxMenu.style.left = e.clientX + 'px';
      ctxMenu.style.top = e.clientY + 'px';
      ctxMenu.classList.add('visible');

      var rect = ctxMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });

    document.addEventListener('click', function() { ctxMenu.classList.remove('visible'); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') ctxMenu.classList.remove('visible'); });

    ctxMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.ctx-item');
      if (!item || !ctxIssue) return;
      e.stopPropagation();

      // Handle add/remove from project
      if (item.classList.contains('ctx-project-item')) {
        var action = item.dataset.action;
        var projLabel = item.dataset.projLabel;
        item.classList.add('loading');
        fetch('/api/project-item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issueNumber: Number(ctxIssue.number), projectLabel: projLabel, action: action, issueRepo: ctxIssue.repo }),
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data.ok) showToast('#' + ctxIssue.number + (action === 'add' ? ' added to ' : ' removed from ') + projLabel);
          else showToast('Error: ' + data.error, true);
          item.classList.remove('loading');
        })
        .catch(function(err) {
          showToast('Failed: ' + err.message, true);
          item.classList.remove('loading');
        });
        ctxMenu.classList.remove('visible');
        return;
      }

      if (item.classList.contains('active')) { ctxMenu.classList.remove('visible'); return; }

      var field = item.dataset.field;
      var value = item.dataset.value;
      item.classList.add('loading');

      var payload = { issueNumber: Number(ctxIssue.number), field: field, value: value };
      if (ctxIssue.projectLabel) payload.projectLabel = ctxIssue.projectLabel;

      fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) {
          showToast('#' + ctxIssue.number + ' ' + field + ' \\u2192 ' + value);
          // SSE will trigger the refresh automatically
        } else {
          showToast('Error: ' + data.error, true);
          item.classList.remove('loading');
        }
      })
      .catch(function(err) {
        console.error('Context menu update failed:', err);
        showToast('Failed: ' + err.message, true);
        item.classList.remove('loading');
      });

      ctxMenu.classList.remove('visible');
    });

    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = 'toast visible' + (isError ? ' error' : '');
      clearTimeout(toast._tid);
      toast._tid = setTimeout(function() { toast.classList.remove('visible'); }, 2500);
    }

    // -----------------------------------------------------------------------
    // SSE live updates
    // -----------------------------------------------------------------------
    var indicator = document.getElementById('live-indicator');
    var statusEl = document.getElementById('live-status');
    var updatedAt = Number(document.body.dataset.updatedAt) || Date.now();
    var refreshing = false;

    function setLiveState(state) {
      indicator.className = 'live-dot ' + state;
      if (state === 'connected') {
        indicator.title = 'Live — connected';
        updateRelativeTime();
      } else if (state === 'connecting') {
        indicator.title = 'Connecting...';
        statusEl.textContent = 'Connecting...';
      } else {
        indicator.title = 'Disconnected';
        statusEl.textContent = 'Disconnected';
      }
    }

    function updateRelativeTime() {
      var diff = Math.floor((Date.now() - updatedAt) / 1000);
      if (diff < 5) statusEl.textContent = 'Live';
      else if (diff < 60) statusEl.textContent = 'Updated ' + diff + 's ago';
      else if (diff < 3600) statusEl.textContent = 'Updated ' + Math.floor(diff / 60) + 'm ago';
      else statusEl.textContent = 'Updated ' + Math.floor(diff / 3600) + 'h ago';
    }

    // Update relative time every 5s
    setInterval(updateRelativeTime, 5000);

    function patchDOM(freshDoc) {
      // Capture active tab label (multi-project mode)
      var activeTabEl = document.querySelector('.tab.active[data-repo]');
      var activeTabLabel = activeTabEl ? activeTabEl.dataset.repo : null;
      if (!activeTabLabel) {
        var genericActive = document.querySelector('.tab.active');
        if (genericActive) {
          var txt = genericActive.textContent.trim();
          if (txt === 'Roadmap' || txt === 'All') activeTabLabel = txt;
        }
      }

      // Preserve show/hide state of hidden issues (single-project mode only)
      var hiddenEl = document.getElementById('hidden-issues');
      var hiddenVisible = hiddenEl ? hiddenEl.style.display !== 'none' : false;

      // Preserve CI expand/collapse state
      var expandedCIs = [];
      document.querySelectorAll('.ci-details-row').forEach(function(row) {
        if (row.style.display !== 'none') expandedCIs.push(row.id);
      });

      // Patch sections
      var selectors = ['#tab-bar', '#section-roadmap', '#section-issues-content', '#section-vercel', '#section-workflow-runs', '#section-ci', '#section-prs', '#section-graph', '#section-branches', '#issue-count', '#fetch-time'];
      for (var s = 0; s < selectors.length; s++) {
        var sel = selectors[s];
        var freshEl = freshDoc.querySelector(sel);
        var currentEl = document.querySelector(sel);
        if (freshEl && currentEl) {
          while (currentEl.firstChild) currentEl.removeChild(currentEl.firstChild);
          while (freshEl.firstChild) currentEl.appendChild(freshEl.firstChild);
        }
      }

      // Restore active tab (multi-project mode)
      if (activeTabLabel) {
        switchTab(activeTabLabel);
      }

      // Restore show/hide state (single-project mode only)
      if (hiddenVisible) {
        var hiddenIssues = document.getElementById('hidden-issues');
        if (hiddenIssues) hiddenIssues.style.display = '';
        var showMoreRow = document.getElementById('show-more-row');
        if (showMoreRow) showMoreRow.style.display = 'none';
        var showLessRow = document.getElementById('show-less-row');
        if (showLessRow) showLessRow.style.display = '';
      }

      // Restore CI expand/collapse state
      for (var ci = 0; ci < expandedCIs.length; ci++) {
        var ciRow = document.getElementById(expandedCIs[ci]);
        if (ciRow) ciRow.style.display = '';
      }

      // Update timestamp
      var newUpdatedAt = freshDoc.body.dataset.updatedAt;
      if (newUpdatedAt) updatedAt = Number(newUpdatedAt);
      updateRelativeTime();

      // Refresh workspace projects for context menu
      var newWsProjects = freshDoc.body.dataset.wsProjects;
      if (newWsProjects) { try { window.__wsProjects = JSON.parse(newWsProjects); } catch {} }

      updateMultiProjectBadges();
    }

    function connectSSE() {
      var es = new EventSource('/api/events');

      es.onopen = function() {
        setLiveState('connected');
      };

      es.onmessage = function(e) {
        if (e.data === 'connected') {
          setLiveState('connected');
          return;
        }
        if (e.data !== 'refresh' || refreshing) return;
        refreshing = true;

        fetch('/', { headers: { Accept: 'text/html' } })
          .then(function(res) { return res.text(); })
          .then(function(html) {
            var parser = new DOMParser();
            var freshDoc = parser.parseFromString(html, 'text/html');
            patchDOM(freshDoc);
            if (freshDoc.body && freshDoc.body.dataset.stale === 'true') {
              var fetchTimeEl = document.getElementById('fetch-time');
              if (fetchTimeEl && fetchTimeEl.textContent.indexOf('(stale)') === -1) {
                fetchTimeEl.textContent += ' (stale)';
              }
            }
            refreshing = false;
          })
          .catch(function(err) {
            console.error('[dashboard] patch failed:', err);
            refreshing = false;
          });
      };

      es.onerror = function() {
        setLiveState('disconnected');
        // EventSource auto-reconnects, but update UI state
        // When it reconnects, onopen fires again
      };
    }

    connectSSE();

    // -----------------------------------------------------------------------
    // Multi-project badge: show "×N" on issues belonging to >1 non-roadmap project
    // -----------------------------------------------------------------------
    function updateMultiProjectBadges() {
      var allProjects = window.__wsProjects || [];
      var roadmapLabels = allProjects.filter(function(p) { return p.isRoadmap; }).map(function(p) { return p.label; });
      document.querySelectorAll('.issue-row[data-in-projects]').forEach(function(row) {
        var inProjects = row.dataset.inProjects.split(',').filter(Boolean);
        var nonRoadmap = inProjects.filter(function(l) { return roadmapLabels.indexOf(l) === -1; });
        var numCell = row.querySelector('.col-num');
        if (!numCell) return;
        var existing = numCell.querySelector('.multi-proj-badge');
        if (existing) existing.remove();
        if (nonRoadmap.length > 1) {
          var badge = document.createElement('span');
          badge.className = 'multi-proj-badge';
          badge.title = nonRoadmap.join(', ');
          badge.textContent = '\u00d7' + nonRoadmap.length;
          numCell.appendChild(badge);
        }
      });
    }
    updateMultiProjectBadges();
  })();
  </script>

</body>
</html>`
}

const TWO_MINUTES = 2 * 60 * 1000
const CI_FAILING_STATES = ['FAILURE', 'ERROR', 'ACTION_REQUIRED', 'TIMED_OUT']
const CI_RUNNING_STATES = ['PENDING', 'EXPECTED']
const CI_KNOWN_STATES = ['SUCCESS', ...CI_FAILING_STATES, ...CI_RUNNING_STATES]

function shouldShowCI(branchCI: BranchCI[]): boolean {
  if (branchCI.length === 0) return false
  const now = Date.now()
  return branchCI.some((b) => {
    if (CI_FAILING_STATES.includes(b.overallState)) return true
    if (CI_RUNNING_STATES.includes(b.overallState)) return true
    if (!CI_KNOWN_STATES.includes(b.overallState)) return true // unknown state — always show
    if (b.committedAt && now - new Date(b.committedAt).getTime() < TWO_MINUTES) return true
    return false
  })
}

const LIVE_STYLES = `
  .project-header {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 18px 0 4px;
    padding: 0 2px;
  }
  .project-sep-row td {
    background: var(--surface-2, #1a1a1a);
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 4px 10px;
    border-top: 1px solid var(--border, #333);
  }
  .project-sep-inline {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 10px 0 4px;
  }
  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
    transition: background 0.3s;
  }
  .live-dot.connected {
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }
  .live-dot.connecting {
    background: var(--orange);
    animation: pulse 1.5s infinite;
  }
  .live-dot.disconnected {
    background: var(--red);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
`
