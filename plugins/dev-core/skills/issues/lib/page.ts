import {
  issueRow,
  renderBranchCI,
  renderBranchesAndWorktrees,
  renderPRs,
  renderVercelDeployments,
  renderWorkflowRuns,
} from './components'
import { buildDepGraph, renderDepGraph } from './graph'
import { PAGE_STYLES } from './page-styles'
import type { Branch, BranchCI, Issue, PR, VercelDeployment, WorkflowRun, Worktree } from './types'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildTabBar(projects: Array<{label: string, repo: string}>, activeTab: string): string {
  const allTab = `<button class="tab${activeTab === 'All' ? ' active' : ''}" onclick="switchTab('All')">All</button>`
  const projectTabs = projects.map(p => buildProjectTab(p.label, p.repo, activeTab)).join('\n')
  return `<div class="tab-bar" id="tab-bar">${allTab}\n${projectTabs}\n${buildAddButton()}</div>`
}

function buildProjectTab(label: string, repo: string, activeTab: string): string {
  return `<button class="tab${label === activeTab ? ' active' : ''}" data-repo="${escapeHtml(label)}" data-slug="${escapeHtml(repo)}" onclick="switchTab('${escapeHtml(label)}')">${escapeHtml(label)}<span class="tab-close" onclick="event.stopPropagation();removeProject('${escapeHtml(repo)}')">&#215;</span></button>`
}

function buildAddButton(): string {
  return `<button class="tab add-btn" onclick="openAddDialog()" title="Add project">+</button>`
}

function buildAllView(byProject: Map<string, Issue[]>, issueTableFn: (issues: Issue[]) => string): string {
  if (byProject.size === 0) {
    return '<div class="empty-state">No projects registered — click + to add one</div>'
  }
  return [...byProject.entries()].map(([label, issues]) =>
    `<section class="project-group" data-project="${escapeHtml(label)}">
      <h2 class="project-header">${escapeHtml(label)}</h2>
      ${issues.length === 0 ? '<p class="no-issues">No open issues</p>' : issueTableFn(issues)}
    </section>`
  ).join('\n')
}

function buildIssueTable(issues: Issue[]): string {
  const INITIAL_VISIBLE = 8
  const visibleRows = issues.slice(0, INITIAL_VISIBLE).map((i) => issueRow(i)).join('')
  const hiddenRows = issues.slice(INITIAL_VISIBLE).map((i) => issueRow(i)).join('')
  const hasMore = issues.length > INITIAL_VISIBLE
  const hiddenCount = issues.length - INITIAL_VISIBLE
  return `<table>
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
    <tbody>
      ${visibleRows}
      ${hasMore ? `<tr><td colspan="7" style="text-align:center;padding:12px;">
        <button class="show-more-btn" onclick="var tb=this.closest('table').querySelector('.hidden-issues-body');tb.style.display='';this.parentElement.parentElement.style.display='none';">
          Show ${hiddenCount} more issue${hiddenCount > 1 ? 's' : ''}
        </button>
      </td></tr>` : ''}
    </tbody>
    <tbody class="hidden-issues-body" style="display:none;">
      ${hiddenRows}
      <tr><td colspan="7" style="text-align:center;padding:12px;">
        <button class="show-more-btn" onclick="var tb=this.closest('table').querySelector('.hidden-issues-body');tb.style.display='none';">
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
<\/script>`
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
  workspaceProjects?: Array<{label: string, repo: string}>
): string {
  const isMultiProject = byProject !== undefined && byProject.size > 0
  const allIssues = isMultiProject
    ? [...byProject!.values()].flat()
    : issues
  const totalCount = allIssues.reduce((sum, i) => sum + 1 + i.children.length, 0)

  const INITIAL_VISIBLE = 8
  const visibleRows = issues
    .slice(0, INITIAL_VISIBLE)
    .map((i) => issueRow(i))
    .join('')
  const hiddenRows = issues
    .slice(INITIAL_VISIBLE)
    .map((i) => issueRow(i))
    .join('')
  const hasMore = issues.length > INITIAL_VISIBLE
  const hiddenCount = issues.length - INITIAL_VISIBLE
  const depNodes = buildDepGraph(allIssues)
  const depGraphHtml = renderDepGraph(depNodes, allIssues)
  const vercelHtml = renderVercelDeployments(deployments)
  const wrHtml = renderWorkflowRuns(workflowRuns)
  const prsHtml = renderPRs(prs)
  const branchesHtml = renderBranchesAndWorktrees(branches, worktrees)
  const ciHtml = renderBranchCI(branchCI)
  const showCI = shouldShowCI(branchCI)

  const tabBarHtml = isMultiProject
    ? buildTabBar(workspaceProjects ?? [...byProject!.keys()].map(label => ({label, repo: label})), 'All')
    : ''

  const issuesSectionHtml = isMultiProject
    ? buildAllView(byProject!, buildIssueTable)
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
        <button id="show-more-btn" onclick="document.getElementById('hidden-issues').style.display='none';document.getElementById('show-less-row').style.display='none';document.getElementById('show-more-row').style.display='';">
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
<body data-updated-at="${updatedAt}">
  <header>
    <h1>Issues Dashboard</h1>
    <span id="issue-count" class="count">${totalCount} issues</span>
    <span class="meta">
      <span id="live-indicator" class="live-dot connecting" title="Connecting..."></span>
      <span id="live-status">Connecting...</span>
      &middot; <span id="fetch-time">Fetched in ${fetchMs}ms</span>
    </span>
  </header>

  ${tabBarHtml}

  <div id="section-vercel">${vercelHtml}</div>

  <div id="section-workflow-runs">${wrHtml}</div>

  <div id="section-ci">${showCI ? `<div class="section"><h2>CI Status</h2>${ciHtml}</div>` : ''}</div>

  <div id="section-prs">${prs.length > 0 ? `<div class="section"><h2>Pull Requests</h2>${prsHtml}</div>` : ''}</div>

  <div id="section-issues" class="section">
    <h2>Issues</h2>
  </div>
  ${issuesSectionHtml}

  <div class="legend">
    <span>\u26d4 blocked</span>
    <span>\ud83d\udd13 blocking</span>
    <span>\u2705 ready</span>
  </div>

  <div id="section-graph" class="section">
    <h2>Dependency Graph</h2>
    <div class="graph-container">
      ${depGraphHtml}
    </div>
  </div>

  <div id="section-branches" class="section">
    <h2>Branches &amp; Worktrees</h2>
    ${branchesHtml}
  </div>

  ${workspaceDialogHtml}

  <!-- Context menu -->
  <div id="ctx-menu" class="ctx-menu">
    <div class="ctx-header">#<span id="ctx-issue-num"></span></div>
    <div class="ctx-section">Status</div>
    <div class="ctx-item" data-field="status" data-value="Backlog">Backlog</div>
    <div class="ctx-item" data-field="status" data-value="Analysis">Analysis</div>
    <div class="ctx-item" data-field="status" data-value="Specs">Specs</div>
    <div class="ctx-item" data-field="status" data-value="In Progress">In Progress</div>
    <div class="ctx-item" data-field="status" data-value="Review">Review</div>
    <div class="ctx-item" data-field="status" data-value="Done">Done</div>
    <div class="ctx-section">Size</div>
    <div class="ctx-item" data-field="size" data-value="XS">XS</div>
    <div class="ctx-item" data-field="size" data-value="S">S</div>
    <div class="ctx-item" data-field="size" data-value="M">M</div>
    <div class="ctx-item" data-field="size" data-value="L">L</div>
    <div class="ctx-item" data-field="size" data-value="XL">XL</div>
    <div class="ctx-section">Priority</div>
    <div class="ctx-item" data-field="priority" data-value="P0 - Urgent">P0 - Urgent</div>
    <div class="ctx-item" data-field="priority" data-value="P1 - High">P1 - High</div>
    <div class="ctx-item" data-field="priority" data-value="P2 - Medium">P2 - Medium</div>
    <div class="ctx-item" data-field="priority" data-value="P3 - Low">P3 - Low</div>
  </div>
  <div id="toast" class="toast"></div>

  <script>
  function switchTab(label) {
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab[data-repo]').forEach(function(t) {
      if (t.dataset.repo === label) t.classList.add('active');
    });
    if (label === 'All') {
      document.querySelectorAll('.tab:not([data-repo]):not(.add-btn)').forEach(function(t) {
        if (t.textContent.trim() === 'All') t.classList.add('active');
      });
      document.querySelectorAll('.project-group').forEach(function(s) {
        s.style.display = '';
        s.querySelectorAll('.hidden-issues-body').forEach(function(b) { b.style.display = 'none'; });
        s.querySelectorAll('tbody:not(.hidden-issues-body) tr').forEach(function(tr) {
          if (tr.querySelector('.show-more-btn')) tr.style.display = '';
        });
      });
      document.querySelectorAll('.single-project-view').forEach(function(s) { s.style.display = ''; });
    } else {
      document.querySelectorAll('.project-group').forEach(function(s) {
        var isActive = s.dataset.project === label;
        s.style.display = isActive ? '' : 'none';
        if (isActive) {
          s.querySelectorAll('.hidden-issues-body').forEach(function(b) { b.style.display = ''; });
          s.querySelectorAll('tbody:not(.hidden-issues-body) tr').forEach(function(tr) {
            if (tr.querySelector('.show-more-btn')) tr.style.display = 'none';
          });
        }
      });
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

    // -----------------------------------------------------------------------
    // Context menu
    // -----------------------------------------------------------------------
    document.addEventListener('contextmenu', function(e) {
      var row = e.target.closest('.issue-row');
      if (!row) { ctxMenu.classList.remove('visible'); return; }

      e.preventDefault();
      ctxIssue = {
        number: row.dataset.issue,
        status: row.dataset.status,
        size: row.dataset.size,
        priority: row.dataset.priority,
      };
      ctxNum.textContent = ctxIssue.number;

      ctxMenu.querySelectorAll('.ctx-item').forEach(function(item) {
        item.classList.remove('active', 'loading');
        var field = item.dataset.field;
        var value = item.dataset.value;
        if (field === 'status' && value === ctxIssue.status) item.classList.add('active');
        if (field === 'size' && value === ctxIssue.size) item.classList.add('active');
        if (field === 'priority' && value === ctxIssue.priority) item.classList.add('active');
      });

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
      if (item.classList.contains('active')) { ctxMenu.classList.remove('visible'); return; }

      var field = item.dataset.field;
      var value = item.dataset.value;
      item.classList.add('loading');

      fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueNumber: Number(ctxIssue.number), field: field, value: value }),
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
      // Preserve show/hide state of hidden issues
      var hiddenVisible = document.getElementById('hidden-issues').style.display !== 'none';

      // Preserve CI expand/collapse state
      var expandedCIs = [];
      document.querySelectorAll('.ci-details-row').forEach(function(row) {
        if (row.style.display !== 'none') expandedCIs.push(row.id);
      });

      // Patch issue tables
      var selectors = ['#tab-bar', '#issues-visible', '#hidden-issues', '#section-vercel', '#section-workflow-runs', '#section-ci', '#section-prs', '#section-graph', '#section-branches', '#issue-count', '#fetch-time'];
      for (var s = 0; s < selectors.length; s++) {
        var sel = selectors[s];
        var freshEl = freshDoc.querySelector(sel);
        var currentEl = document.querySelector(sel);
        if (freshEl && currentEl) {
          // For elements with children, replace all children
          while (currentEl.firstChild) currentEl.removeChild(currentEl.firstChild);
          while (freshEl.firstChild) currentEl.appendChild(freshEl.firstChild);
        }
      }

      // Restore show/hide state
      if (hiddenVisible) {
        document.getElementById('hidden-issues').style.display = '';
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
  })();
  </script>

</body>
</html>`
}

const TWO_MINUTES = 2 * 60 * 1000
const CI_FAILING_STATES = ['FAILURE', 'ERROR', 'ACTION_REQUIRED', 'TIMED_OUT']
const CI_RUNNING_STATES = ['PENDING', 'EXPECTED']

function shouldShowCI(branchCI: BranchCI[]): boolean {
  if (branchCI.length === 0) return false
  const now = Date.now()
  return branchCI.some((b) => {
    if (CI_FAILING_STATES.includes(b.overallState)) return true
    if (CI_RUNNING_STATES.includes(b.overallState)) return true
    if (b.committedAt && now - new Date(b.committedAt).getTime() < TWO_MINUTES) return true
    return false
  })
}

const LIVE_STYLES = `
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
