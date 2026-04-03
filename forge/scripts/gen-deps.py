#!/usr/bin/env python3
"""
gen-deps.py — generate tab-dependencies.html from roadmap-deps.json.

Usage:
  python3 gen-deps.py [data.json] [--out path/to/tab-dependencies.html]
  python3 gen-deps.py --github-sync   # pull closed dates from gh CLI, update JSON status
"""

import json
import os
import re
import sys
import subprocess
from pathlib import Path
from collections import defaultdict

FORGE_DIR = Path(os.environ.get('FORGE_DIR', os.environ.get('DIAGRAMS_DIR', Path.home() / '.roxabi' / 'forge')))
DEFAULT_DATA = FORGE_DIR / "lyra/visuals/deps/roadmap-deps.json"
DEFAULT_OUT  = FORGE_DIR / "lyra/visuals/tabs/lyra-status/tab-dependencies.html"

# ── Styles ──────────────────────────────────────────────────────────────────

CROSS_PHASE_STYLE = (
    "fill:#0f172a,color:#94a3b8,stroke:#6366f1,"
    "stroke-width:1px,stroke-dasharray:4 3"
)

VIRTUAL_STYLE = (
    "fill:#1e1a2e,color:#94a3b8,stroke:#6d28d9,"
    "stroke-width:1px,stroke-dasharray:3 3"
)

def domain_style(domain, domains):
    d = domains.get(domain, {"fill":"#6366f1","text":"#fff","stroke":"#4338ca"})
    return f"fill:{d['fill']},color:{d['text']},stroke:{d['stroke']},stroke-width:2px"

def node_style(issue, domains):
    status = issue.get("status", "open")
    domain = issue.get("domain", "")
    d = domains.get(domain, {"fill":"#6366f1","text":"#fff","stroke":"#4338ca"})
    if status == "done_recent":
        return f"fill:#374151,color:#9ca3af,stroke:{d['stroke']},stroke-width:2px,stroke-dasharray:5 5"
    if status == "deferred":
        return "fill:#1a1000,color:#fbbf24,stroke:#ca8a04,stroke-width:2px,stroke-dasharray:4 3"
    if status == "external":
        return "fill:#ef4444,color:#fff,stroke:#b91c1c,stroke-width:2px"
    if status == "virtual":
        return VIRTUAL_STYLE
    return domain_style(domain, domains)


# ── Helpers ──────────────────────────────────────────────────────────────────

def mid(issue_id: str) -> str:
    """Safe Mermaid node ID."""
    return "N" + re.sub(r"[^a-zA-Z0-9]", "_", str(issue_id))

def node_label(issue: dict) -> str:
    label = issue.get("label", issue["id"])
    status = issue.get("status", "open")
    if status == "done_recent":
        return f"done {label}"
    if status == "deferred":
        return f"{label} (deferred)"
    return label

def phase_short(phase_id: str) -> str:
    """ph3a → Ph3a"""
    return phase_id.replace("ph", "Ph")


# ── Mermaid generation ───────────────────────────────────────────────────────

def build_mermaid(phase_id, all_issues, domains):
    """
    Generate a Mermaid flowchart for one phase.
    Includes intra-phase edges, incoming cross-phase ghost nodes,
    and outgoing cross-phase ghost nodes.
    """
    phase_issues = {
        iid: iss for iid, iss in all_issues.items()
        if iss.get("phase") == phase_id and iss.get("status") != "done_old"
    }

    if not phase_issues:
        return 'flowchart TD\n    EMPTY["(no active issues)"]\n'

    # Collect edges and ghost nodes
    edges = []           # (from_nid, to_nid)
    ghost_in  = {}       # ghost_nid -> (style, label)
    ghost_out = {}       # ghost_nid -> (style, label)

    for iid, issue in phase_issues.items():
        nid = mid(iid)

        # Outgoing: this issue blocks something else
        for blocked_id in issue.get("blocks", []):
            blocked = all_issues.get(blocked_id)
            if not blocked or blocked.get("status") == "done_old":
                continue
            if blocked.get("phase") == phase_id:
                # Intra-phase
                edges.append((nid, mid(blocked_id)))
            else:
                # Cross-phase outgoing ghost
                gid = f"XO_{mid(blocked_id)}"
                if gid not in ghost_out:
                    ph = phase_short(blocked.get("phase", "?"))
                    lbl = blocked.get("label", f"#{blocked_id}")
                    ghost_out[gid] = (CROSS_PHASE_STYLE, f"&#8594; {ph} {lbl}")
                edges.append((nid, gid))

        # Incoming: this issue is blocked by something in another phase
        for blocker_id in issue.get("blocked_by", []):
            blocker = all_issues.get(blocker_id)
            if not blocker or blocker.get("status") == "done_old":
                continue
            if blocker.get("phase") != phase_id:
                # Cross-phase incoming ghost
                gid = f"XI_{mid(blocker_id)}"
                if gid not in ghost_in:
                    ph = phase_short(blocker.get("phase", "?"))
                    lbl = blocker.get("label", f"#{blocker_id}")
                    ghost_in[gid] = (CROSS_PHASE_STYLE, f"&#8592; {ph} {lbl}")
                edges.append((gid, nid))

    lines = ["flowchart TD"]

    # Declare nodes (phase issues first, then ghosts)
    for iid, issue in phase_issues.items():
        lines.append(f'    {mid(iid)}["{node_label(issue)}"]')
    for gid, (_, lbl) in {**ghost_in, **ghost_out}.items():
        lines.append(f'    {gid}["{lbl}"]')

    for a, b in edges:
        lines.append(f'    {a} --> {b}')

    for iid, issue in phase_issues.items():
        lines.append(f'    style {mid(iid)} {node_style(issue, domains)}')
    for gid, (style, _) in {**ghost_in, **ghost_out}.items():
        lines.append(f'    style {gid} {style}')

    return "\n".join(lines) + "\n    "


def incoming_banner(phase_id, all_issues, phases_by_id):
    """Auto-derive the incoming dep banner text from cross-phase blocked_by."""
    seen = {}
    for iss in all_issues.values():
        if iss.get("phase") != phase_id or iss.get("status") == "done_old":
            continue
        for blocker_id in iss.get("blocked_by", []):
            blocker = all_issues.get(blocker_id)
            if not blocker or blocker.get("phase") == phase_id or blocker.get("status") == "done_old":
                continue
            ph = phase_short(blocker["phase"])
            lbl = blocker.get("label", f"#{blocker_id}")
            key = (blocker["phase"], blocker_id)
            if key not in seen:
                seen[key] = f"<strong>{lbl}</strong> ({ph})"

    if not seen:
        return "&#8649; no hard blockers &#8212; can start immediately"
    return "&#8592; " + " &middot; ".join(seen.values())


# ── Progress cards ────────────────────────────────────────────────────────────

def render_chain_card(chain, all_issues, domains):
    cid     = chain["id"]
    label   = chain["label"]
    color   = chain.get("color", "#6366f1")
    issues  = chain.get("issues", [])

    # Complete card
    if chain.get("complete"):
        return f"""
  <div class="card" style="border-left:3px solid var(--green)">
    <div class="card-header">
      <span class="card-title" style="color:var(--green)">{label}</span>
      <span class="card-version">&#10003; complete</span>
    </div>
    <div class="card-body" style="font-size:13px">
      <div style="margin-bottom:8px">
        <div style="background:var(--surface2);border-radius:99px;height:8px;overflow:hidden">
          <div style="background:var(--green);height:100%;width:100%;border-radius:99px"></div>
        </div>
      </div>
      <ul style="list-style:none;padding:0">
        <li style="color:var(--green)">&#10003; {chain.get('complete_note','')}</li>
      </ul>
      <div style="margin-top:8px;font-size:11px;color:var(--text-dim)">{chain.get('note','')}</div>
    </div>
  </div>"""

    # Count done vs open
    done_ids = [i for i in issues if all_issues.get(i, {}).get("status") == "done_recent"]
    open_ids = [i for i in issues if all_issues.get(i, {}).get("status") not in ("done_recent", "done_old")]
    total = len(issues)
    done_count = len(done_ids)
    pct = int(done_count / total * 100) if total else 0

    # Done list display
    done_labels = [all_issues[i]["label"] for i in done_ids if i in all_issues]
    open_labels = [all_issues[i]["label"] for i in open_ids if i in all_issues]

    done_row = ""
    if done_labels:
        done_row = f'<li style="color:var(--green)">&#10003; {", ".join(done_labels)}</li>'
    open_row = ""
    if open_labels:
        open_row = f'<li style="color:var(--text-dim)">&#9675; {", ".join(open_labels[:6])}{"&hellip;" if len(open_labels)>6 else ""}</li>'

    # Footer note
    if chain.get("blocked_note"):
        footer = f"""
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;font-family:var(--font-mono);display:flex;flex-wrap:wrap;align-items:center;gap:5px">
        <span style="color:#6366f1;margin-right:2px">&#8592; waiting on:</span>
        {_ghost_badges(chain['blocked_note'])}
      </div>"""
    elif chain.get("next_note"):
        footer = f'<div style="margin-top:8px;font-size:11px;color:var(--text-dim)"><strong>Next:</strong> {chain["next_note"]}</div>'
    else:
        footer = ""

    # Unlock row: find cross-phase outgoing deps for issues in this chain
    unlocks = _compute_unlocks(issues, all_issues, set(issues))
    unlock_row = ""
    if unlocks:
        badges = "".join(_badge_span(lbl) for lbl in unlocks)
        # Describe "when X done" trigger
        trigger = _unlock_trigger(chain, all_issues)
        unlock_row = f"""
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;font-family:var(--font-mono);display:flex;flex-wrap:wrap;align-items:center;gap:5px">
        <span style="color:#6366f1;margin-right:2px">&#8680; {trigger}:</span>
        {badges}
      </div>"""

    # Done recent closed items (ops-style)
    done_recent_rows = ""
    for d in chain.get("done_recent", []):
        done_recent_rows += f'<li style="color:var(--green)">&#10003; {d} &#8212; closed recently</li>'

    open_count_label = f"{done_count}/{total} done" if total else "0 open"

    return f"""
  <div class="card{'  card--active' if pct > 0 and pct < 100 else ''}" style="border-left:3px solid {color}">
    <div class="card-header">
      <span class="card-title" style="color:{color}">{label}</span>
      <span class="card-version">{open_count_label}</span>
    </div>
    <div class="card-body" style="font-size:13px">
      <div style="margin-bottom:8px">
        <div style="background:var(--surface2);border-radius:99px;height:8px;overflow:hidden">
          <div style="background:{color};height:100%;width:{pct}%;border-radius:99px"></div>
        </div>
      </div>
      <ul style="list-style:none;padding:0">
        {done_row}
        {open_row}
        {done_recent_rows}
      </ul>
      {footer}
      {unlock_row}
    </div>
  </div>"""


def _badge_span(lbl: str) -> str:
    return f'<span style="background:#0f172a;color:#94a3b8;border:1px dashed #6366f1;border-radius:4px;padding:2px 6px">{lbl}</span>'


def _ghost_badges(note_str):
    """Convert a plain text note into ghost badge spans."""
    return "".join(_badge_span(p.strip()) for p in note_str.split("+"))


def _compute_unlocks(chain_issue_ids, all_issues, chain_set):
    """Return ghost badge labels for cross-chain/cross-phase unlocks."""
    seen = set()
    for iid in chain_issue_ids:
        issue = all_issues.get(iid)
        if not issue:
            continue
        for blocked_id in issue.get("blocks", []):
            if blocked_id in chain_set:
                continue  # intra-chain, skip
            blocked = all_issues.get(blocked_id)
            if not blocked or blocked.get("status") == "done_old":
                continue
            ph = phase_short(blocked.get("phase", "?"))
            lbl = f"{ph} {blocked.get('label', blocked_id)}"
            seen.add(lbl)
    return list(seen)


def _unlock_trigger(chain, all_issues):
    """Describe the trigger condition for the unlock row."""
    # Find the last terminal node of the chain (most downstream)
    issues = chain.get("issues", [])
    for iid in reversed(issues):
        iss = all_issues.get(iid)
        if iss and iss.get("status") not in ("done_recent", "done_old"):
            return f"when {iss.get('label', iid)} done"
    return "when complete"


# ── Critical paths ────────────────────────────────────────────────────────────

def render_critical_paths(critical_paths, all_issues):
    html = ""
    for path in critical_paths:
        badges = ""
        for step in path["steps"]:
            sid = step.get("id")
            iss = all_issues.get(sid) if sid else None
            lbl = step.get("label") or (iss["label"] if iss else sid)
            st  = step.get("status", iss.get("status","planned") if iss else "planned")
            if st in ("done", "done_recent"):
                badges += f'<span class="badge badge--done" style="opacity:0.6">{lbl} &#10003;</span>\n'
            elif st == "north-star":
                badges += f'<span style="color:var(--green);font-weight:600">{lbl}</span>\n'
            else:
                badges += f'<span class="badge badge--planned">{lbl}</span>\n'
            if step != path["steps"][-1]:
                badges += '<span class="flow-arrow">&#8594;</span>\n'

        html += f"""    <div style="font-family:var(--font-mono);font-size:12px;color:var(--text-dim);margin-bottom:8px">{path['label']}</div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;font-family:var(--font-mono);margin-bottom:12px">
      {badges}
    </div>\n"""
    return html


# ── Full tab render ──────────────────────────────────────────────────────────

CTRL_BUTTONS = '<button class="dep-ctrl dep-zi">+</button><button class="dep-ctrl dep-zo">-</button><button class="dep-ctrl dep-ft" style="width:auto;padding:0 10px;font-size:11px">Fit</button>'

def render_tab(data):
    all_issues  = {i["id"]: i for i in data["issues"]}
    phases      = data["phases"]
    phases_by_id= {p["id"]: p for p in phases}
    domains     = data["domains"]
    chains      = data.get("chains", [])
    cp          = data.get("critical_paths", [])
    meta        = data.get("_meta", {})
    updated     = meta.get("updated", "")
    total       = meta.get("total_tracked", "?")
    done_days   = meta.get("done_visible_days", 7)

    # ── Legend ──
    domain_legend = ""
    for dom, cfg in domains.items():
        domain_legend += (
            f'<div style="display:flex;align-items:center;gap:6px">'
            f'<div style="width:12px;height:12px;border-radius:3px;background:{cfg["fill"]}"></div>'
            f' {dom.capitalize()}</div>\n'
        )

    # ── Phase blocks ──
    phase_blocks = ""
    for phase in phases:
        pid   = phase["id"]
        pname = phase["name"]
        pcolor= phase["color"]
        pnote = phase.get("note", "")
        note_span = f' <span style="font-size:11px;color:var(--green);font-weight:400;margin-left:8px">{pnote}</span>' if pnote else ""

        banner = incoming_banner(pid, all_issues, phases_by_id)
        mermaid = build_mermaid(pid, all_issues, domains)

        phase_blocks += f"""
  <!-- ── {pname} ── -->
  <div class="dep-phase" style="--phase-color:{pcolor}">
    <div class="dep-phase__incoming">{banner}</div>
    <div class="dep-phase__header">{pname}{note_span}</div>
    <div class="dep-phase__viewer"><div class="dep-controls-overlay">{CTRL_BUTTONS}</div><div class="dep-phase__svg"><pre class="mermaid">
{mermaid}</pre></div></div>
  </div>
"""

    # ── Progress cards ──
    cards_html = ""
    for chain in chains:
        cards_html += render_chain_card(chain, all_issues, domains)

    # ── Critical paths ──
    cp_html = render_critical_paths(cp, all_issues)

    # ── Footer ──
    n_done = sum(1 for i in all_issues.values() if i.get("status") == "done_recent")
    n_chains = len(chains)

    return f"""<!-- Tab: Dependencies — auto-generated by gen-deps.py from roadmap-deps.json -->
<!-- DO NOT EDIT BY HAND — edit roadmap-deps.json then run gen-deps.py -->

<h2 class="sec-title"><span class="icon">&#9670;</span> Issue Dependencies</h2>
<p class="sec-desc">Each phase is a horizontal band with its own dependency tree. <span style="color:#6366f1">Indigo dashed</span> = cross-phase dep. <span style="color:#fbbf24">Amber dashed</span> = deferred.</p>

<!-- ── Legend ── -->
<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:var(--space-xl);font-size:12px;font-family:var(--font-mono);color:var(--text-dim)">
  {domain_legend}
  <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:3px;background:#374151;border:2px dashed #6b7280"></div> Done</div>
  <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:3px;background:#0f172a;border:2px dashed #6366f1"></div> Cross-phase dep</div>
  <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:3px;background:#1a1000;border:2px dashed #ca8a04"></div> Deferred</div>
  <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:3px;background:#1e1a2e;border:2px dashed #6d28d9"></div> No issue yet</div>
</div>

<!-- ── Phase bands ── -->
<div id="dep-board">
{phase_blocks}
</div>

<!-- ── Progress by Chain ── -->
<h3 class="sec-subtitle">Progress by Chain</h3>
<div class="card-grid" style="margin-bottom:var(--space-xl)">
{cards_html}
</div>

<!-- ── Critical Paths ── -->
<h3 class="sec-subtitle">Critical Paths</h3>
<div class="card" style="border-color:var(--accent);margin-bottom:var(--space-lg)">
  <div class="card-body">
{cp_html}  </div>
</div>

<p style="font-size:12px;color:var(--text-dim);font-family:var(--font-mono);text-align:center">
  ~{total} tracked issues &middot; {n_done} done recently &middot; {n_chains} chains &middot; generated {updated}
</p>
"""


# ── GitHub sync ───────────────────────────────────────────────────────────────

def github_sync(data_file: Path):
    """Pull closed dates from gh CLI and update issue statuses in JSON."""
    from datetime import datetime, timezone

    data = json.loads(data_file.read_text())
    all_issues = {i["id"]: i for i in data["issues"]}
    done_days  = data.get("_meta", {}).get("done_visible_days", 7)

    # Collect numeric IDs
    numeric_ids = [iid for iid in all_issues if iid.isdigit()]
    if not numeric_ids:
        print("No numeric issue IDs found.")
        return

    print(f"Syncing {len(numeric_ids)} issues from GitHub...")
    result = subprocess.run(
        ["gh", "issue", "list", "--state", "all",
         "--json", "number,state,closedAt", "--limit", "500"],
        capture_output=True, text=True, cwd=Path.home() / "projects/lyra"
    )
    if result.returncode != 0:
        print(f"gh error: {result.stderr}", file=sys.stderr)
        return

    gh_issues = {str(i["number"]): i for i in json.loads(result.stdout)}
    today = datetime.now(timezone.utc)

    changed = 0
    for iid, issue in all_issues.items():
        if not iid.isdigit():
            continue
        gh = gh_issues.get(iid)
        if not gh:
            continue
        if gh["state"] == "OPEN":
            new_status = issue.get("status", "open")
            if new_status in ("done_recent", "done_old"):
                issue["status"] = "open"
                changed += 1
        elif gh["state"] == "CLOSED":
            closed_at = datetime.fromisoformat(gh["closedAt"].replace("Z", "+00:00"))
            days_ago = (today - closed_at).days
            new_status = "done_recent" if days_ago <= done_days else "done_old"
            if issue.get("status") != new_status:
                issue["status"] = new_status
                issue["closed_days_ago"] = days_ago
                changed += 1

    if changed:
        data_file.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        print(f"Updated {changed} issue statuses in {data_file}")
    else:
        print("No status changes.")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if "--github-sync" in args:
        data_file = Path(next((a for a in args if not a.startswith("--")), DEFAULT_DATA))
        github_sync(data_file)
        args = [a for a in args if a not in ("--github-sync",)]
        if not args:
            return

    data_file = Path(args[0]) if args else DEFAULT_DATA
    out_arg = next((args[i+1] for i, a in enumerate(args) if a == "--out" and i+1 < len(args)), None)
    out_file = Path(out_arg) if out_arg else DEFAULT_OUT

    data = json.loads(data_file.read_text())
    html = render_tab(data)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(html)
    print(f"Generated {out_file} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
