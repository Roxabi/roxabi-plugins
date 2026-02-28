export const PAGE_STYLES = `
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --orange: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --pink: #f778ba;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 10px 6px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
    flex-wrap: wrap;
  }

  header h1 {
    font-size: 20px;
    font-weight: 600;
  }

  .count {
    font-size: 13px;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 2px 10px;
  }

  .meta {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-muted);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  thead th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 1;
  }

  tbody td {
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .issue-row:hover { background: var(--surface); }

  .col-num { width: 50px; color: var(--text-muted); }
  .col-num a { color: var(--text-muted); text-decoration: none; }
  .col-num a:hover { color: var(--accent); }
  .col-title { min-width: 300px; white-space: normal; word-break: break-word; }
  .col-title a { color: var(--accent); text-decoration: none; }
  .col-title a:hover { text-decoration: underline; }
  .col-status { width: 90px; }
  .col-size { width: 50px; text-align: center; }
  .col-pri { width: 50px; text-align: center; }
  .col-block { width: 36px; text-align: center; }
  .col-deps { min-width: 120px; font-size: 12px; }

  .issue-row:not(.depth-0) td { border-bottom: none; padding-top: 2px; padding-bottom: 2px; }
  .depth-1 .col-title { padding-left: 28px; color: var(--text-muted); font-size: 12px; }
  .depth-2 .col-title { padding-left: 48px; color: var(--text-muted); font-size: 12px; }
  .depth-3 .col-title { padding-left: 68px; color: var(--text-muted); font-size: 12px; }
  .tree-prefix { color: var(--border); margin-right: 4px; font-family: monospace; }

  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid var(--border);
    color: var(--text-muted);
  }

  .pri-p0 { background: rgba(248,81,73,.15); color: var(--red); border-color: rgba(248,81,73,.4); }
  .pri-p1 { background: rgba(210,153,34,.15); color: var(--orange); border-color: rgba(210,153,34,.4); }
  .pri-p2 { background: rgba(88,166,255,.1); color: var(--accent); border-color: rgba(88,166,255,.3); }
  .pri-p3 { background: rgba(139,148,158,.1); color: var(--text-muted); border-color: var(--border); }

  .status-progress { background: rgba(63,185,80,.15); color: var(--green); border-color: rgba(63,185,80,.4); }
  .status-review { background: rgba(188,140,255,.15); color: var(--purple); border-color: rgba(188,140,255,.4); }
  .status-specs { background: rgba(247,120,186,.15); color: var(--pink); border-color: rgba(247,120,186,.4); }
  .status-analysis { background: rgba(210,153,34,.15); color: var(--orange); border-color: rgba(210,153,34,.4); }
  .status-backlog { }
  .status-done { background: rgba(63,185,80,.15); color: var(--green); border-color: rgba(63,185,80,.4); }

  .block-blocked { }
  .block-blocking { }
  .block-ready { }

  .dep { margin-right: 6px; white-space: nowrap; }
  .dep-blocked { color: var(--red); }
  .dep-blocking { color: var(--orange); }
  .dep-done { color: var(--green); }
  .dep-none { color: var(--text-muted); }

  .legend {
    margin-top: 16px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 20px;
  }

  kbd {
    font-family: monospace;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 11px;
  }

  /* Sections */
  .section {
    margin-top: 32px;
  }

  .section h2 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .section-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    margin-top: 32px;
  }

  .section-grid .section { margin-top: 0; }

  /* Dependency graph */
  .graph-container {
    overflow-x: auto;
    padding: 8px 0;
  }

  .dep-graph rect { cursor: default; }
  .dep-graph rect:hover { filter: brightness(1.2); }

  /* Sub-tables (PRs) */
  .sub-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .sub-table thead th {
    text-align: left;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .sub-table tbody td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
  }

  .sub-table a { color: var(--accent); text-decoration: none; }
  .sub-table a:hover { text-decoration: underline; }
  .sub-table code { font-size: 12px; color: var(--text-muted); background: var(--surface); padding: 1px 6px; border-radius: 4px; }
  .pr-branch { margin-top: 2px; font-size: 12px; color: var(--text-muted); }
  .sub-table .col-pr-title { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* CI checks */
  .col-ci { white-space: nowrap; }
  .ci-toggle {
    background: none;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    color: var(--text-muted);
    transition: border-color 0.15s, background 0.15s;
  }
  .ci-toggle:hover { border-color: var(--accent); background: rgba(88,166,255,.08); }
  .ci-toggle.ci-success { color: var(--green); border-color: rgba(63,185,80,.3); }
  .ci-toggle.ci-failure { color: var(--red); border-color: rgba(248,81,73,.3); }
  .ci-toggle.ci-running { color: var(--orange); border-color: rgba(210,153,34,.3); }
  .ci-toggle.ci-pending { color: var(--text-muted); }
  .ci-toggle .ci-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: ci-spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 3px;
  }
  @keyframes ci-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .ci-details-row td { padding: 0 10px 8px 10px !important; border-bottom: 1px solid var(--border); }
  .ci-checks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 4px;
    padding: 6px 0 2px 24px;
  }
  .ci-check {
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ci-check a { color: inherit; text-decoration: none; }
  .ci-check a:hover { text-decoration: underline; }
  .ci-check.ci-success { color: var(--green); }
  .ci-check.ci-failure { color: var(--red); background: rgba(248,81,73,.08); }
  .ci-check.ci-running { color: var(--orange); }
  .ci-check.ci-running .ci-spinner,
  .ci-check.ci-pending .ci-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: ci-spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 4px;
  }
  @keyframes ci-spin {
    to { transform: rotate(360deg); }
  }
  .ci-check.ci-pending { color: var(--text-muted); }
  .ci-check.ci-cancelled { color: var(--text-muted); opacity: 0.7; }
  .ci-check.ci-skipped { color: var(--text-muted); opacity: 0.6; }

  /* Vercel deployments */
  .vd-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vd-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .vd-card:hover { border-color: var(--accent); }
  .vd-card.vd-building { border-color: rgba(210,153,34,.4); }
  .vd-card.vd-error { border-color: rgba(248,81,73,.4); }
  .vd-card.vd-ready { border-color: rgba(63,185,80,.3); }
  .vd-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .vd-state { min-width: 100px; font-weight: 500; }
  .vd-building .vd-state { color: var(--orange); }
  .vd-queued .vd-state { color: var(--text-muted); }
  .vd-ready .vd-state { color: var(--green); }
  .vd-error .vd-state { color: var(--red); }
  .vd-env-prod { background: rgba(63,185,80,.15); color: var(--green); border-color: rgba(63,185,80,.4); }
  .vd-env-preview { background: rgba(88,166,255,.1); color: var(--accent); border-color: rgba(88,166,255,.3); }
  .vd-url { color: var(--accent); text-decoration: none; font-size: 12px; }
  .vd-url:hover { text-decoration: underline; }
  .vd-branch { font-size: 11px; color: var(--text-muted); background: var(--bg); padding: 1px 6px; border-radius: 4px; }
  .vd-msg { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 300px; }
  .vd-age { margin-left: auto; font-size: 11px; }
  .vd-inspect { color: var(--text-muted); text-decoration: none; font-size: 14px; padding: 0 4px; }
  .vd-inspect:hover { color: var(--accent); }

  /* Build pipeline */
  .vd-pipeline {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px 8px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    flex-wrap: wrap;
  }
  .vd-step {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .vd-step-done { color: var(--green); }
  .vd-step-running { color: var(--orange); background: rgba(210,153,34,.1); }
  .vd-step-pending { color: var(--text-muted); opacity: 0.5; }
  .vd-step-error { color: var(--red); background: rgba(248,81,73,.1); }
  .vd-step-arrow { color: var(--border); font-size: 10px; }
  .vd-step .ci-spinner {
    width: 10px;
    height: 10px;
    border-width: 1.5px;
  }

  .changes { font-family: monospace; font-size: 12px; }
  .additions { color: var(--green); }
  .deletions { color: var(--red); }
  .text-muted { color: var(--text-muted); }

  /* Branches & Worktrees */
  .branch-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .branch-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
  }

  .branch-item:hover { border-color: var(--accent); }

  .branch-icon { font-size: 14px; }
  .branch-issue { color: var(--accent); font-size: 12px; }
  .wt-path { font-size: 11px; color: var(--text-muted); margin-left: auto; }

  #show-more-btn {
    background: var(--surface);
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 20px;
    font-size: 13px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  #show-more-btn:hover {
    border-color: var(--accent);
    background: rgba(88,166,255,.1);
  }

  .empty-state {
    color: var(--text-muted);
    font-size: 13px;
    font-style: italic;
    padding: 12px 0;
  }

  /* Context menu */
  .ctx-menu {
    display: none;
    position: fixed;
    z-index: 1000;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 0;
    min-width: 180px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    font-size: 13px;
  }
  .ctx-menu.visible { display: block; }

  .ctx-header {
    padding: 6px 12px 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    border-bottom: 1px solid var(--border);
    margin-bottom: 2px;
  }

  .ctx-section {
    padding: 6px 12px 2px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }

  .ctx-item {
    padding: 4px 12px 4px 28px;
    cursor: pointer;
    position: relative;
    color: var(--text);
    white-space: nowrap;
  }
  .ctx-item:hover {
    background: rgba(88,166,255,.15);
    color: var(--accent);
  }
  .ctx-item.active::before {
    content: '\\2713';
    position: absolute;
    left: 10px;
    color: var(--green);
    font-weight: 600;
  }
  .ctx-item.loading {
    opacity: 0.5;
    pointer-events: none;
  }

  /* Toast notification */
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: var(--surface);
    color: var(--green);
    border: 1px solid var(--green);
    border-radius: 8px;
    padding: 8px 20px;
    font-size: 13px;
    opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    z-index: 1001;
    pointer-events: none;
  }
  .toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.error { color: var(--red); border-color: var(--red); }

  /* Workflow runs */
  .wr-cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wr-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .wr-card:hover { border-color: var(--accent); }
  .wr-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .wr-badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    border: 1px solid var(--border);
    min-width: 90px;
    text-align: center;
    white-space: nowrap;
  }
  .wr-badge-running { color: var(--orange); border-color: rgba(210,153,34,.4); background: rgba(210,153,34,.1); }
  .wr-badge-queued { color: var(--text-muted); border-color: var(--border); }
  .wr-badge-success { color: var(--green); border-color: rgba(63,185,80,.4); background: rgba(63,185,80,.1); }
  .wr-badge-failure { color: var(--red); border-color: rgba(248,81,73,.4); background: rgba(248,81,73,.1); }
  .wr-badge-cancelled { color: var(--text-muted); border-color: var(--border); opacity: 0.7; }
  .wr-name { color: var(--accent); text-decoration: none; font-weight: 500; }
  .wr-name:hover { text-decoration: underline; }
  .wr-event { font-size: 10px; color: var(--text-muted); }
`
