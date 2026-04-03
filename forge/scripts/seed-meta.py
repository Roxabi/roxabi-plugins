#!/usr/bin/env python3
"""seed-meta.py — inject diagram:* meta tags into every diagram HTML file.

Run once to bootstrap. After that, edit meta tags directly in each file,
then run gen-manifest.py to regenerate manifest.json.
"""
import os, re
from pathlib import Path

DIR = Path(os.environ.get('FORGE_DIR', os.environ.get('DIAGRAMS_DIR', Path.home() / '.roxabi' / 'forge')))

# Source of truth: one entry per diagram file.
# kb is omitted — gen-manifest.py computes it from actual file size.
DATA = [
    # User Guide
    {'f':'lyra-user-guide-v11.html',  't':'Lyra — User Guide v11',                          'd':'2026-03-18', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':['latest']},
    {'f':'lyra-user-guide-v10.html',  't':'Lyra — User Guide v10',                          'd':'2026-03-18', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide-v8.html',   't':'Lyra User Guide v8',                             'd':'2026-03-18', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':['split']},
    {'f':'lyra-user-guide-v7.html',   't':'Lyra — Documentation v7',                        'd':'2026-03-18', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':['split']},
    {'f':'lyra-user-guide-v6.html',   't':'Lyra — Documentation v6',                        'd':'2026-03-16', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide-v5.html',   't':'Lyra — Complete User Guide v5',                  'd':'2026-03-16', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide-v4.html',   't':'Lyra — Complete User Guide v4',                  'd':'2026-03-15', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide-v3.html',   't':'Lyra — Complete User Guide v3',                  'd':'2026-03-15', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide-v2.html',   't':'Lyra — Complete User Guide v2',                  'd':'2026-03-15', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    {'f':'lyra-user-guide.html',      't':'Lyra — Complete User Guide v1',                  'd':'2026-03-14', 'cat':'guide', 'cl':'User Guide',       'c':'amber', 'b':[]},
    # Lyra Docs
    {'f':'lyra-architecture-v3.html',           't':'Lyra — Architecture Flow & Domain Map',         'd':'2026-03-16', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':['latest']},
    {'f':'lyra-architecture-v2.html',           't':'Lyra — Architecture Deep Dive',                 'd':'2026-03-16', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-architecture.html',              't':'Lyra Engine — Architecture Visual Explainer',   'd':'2026-03-12', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'architecture-visual-explainer.html',  't':'Lyra — Architecture',                           'd':'2026-03-12', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-command-routing.html',           't':'Lyra — Command Routing Architecture',           'd':'2026-03-15', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-e2e-happy-paths.html',           't':'Lyra — End-to-End Happy Paths',                 'd':'2026-03-15', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-happy-paths.html',               't':'Lyra — 26 End-to-End Happy Paths',              'd':'2026-03-15', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-voice-flow.html',                't':'Lyra — Voice Flow (flux complet)',               'd':'2026-03-15', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-project-roadmap.html',           't':'Lyra Engine — Project Master Plan',             'd':'2026-03-12', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-recap-2w-mar15.html',            't':'Lyra — Project Recap (Mar 1–15)',               'd':'2026-03-15', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'lyra-recap-march-2026.html',          't':'Lyra — Project Recap · March 2026',             'd':'2026-03-12', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    {'f':'44-event-driven-monitoring-plan.html','t':'Issue #44 — Event-Driven Agent Monitoring',     'd':'2026-03-14', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':['plan']},
    {'f':'83-memory-agent-integration-plan.html','t':'#83 — Memory Agent Integration Plan',          'd':'2026-03-14', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':['plan']},
    {'f':'backend-architecture-audit.html',     't':'Roxabi Backend Architecture Audit',             'd':'2026-03-10', 'cat':'lyra', 'cl':'Lyra Docs', 'c':'blue', 'b':[]},
    # Visual Explainer
    {'f':'ve-01-core-workflow.html', 't':'VE — Core Generation Workflow', 'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-02-slides.html',        't':'VE — Slide Deck Generation',    'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-03-diff-review.html',   't':'VE — Diff Review Process',      'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-04-plan-review.html',   't':'VE — Plan Review Process',      'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-05-project-recap.html', 't':'VE — Project Recap Process',    'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-06-visual-plan.html',   't':'VE — Visual Plan Generation',   'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-07-fact-check.html',    't':'VE — Fact Check Process',       'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    {'f':'ve-08-share.html',         't':'VE — Share Process',            'd':'2026-03-12', 'cat':'ve', 'cl':'Visual Explainer', 'c':'purple', 'b':[]},
    # External
    {'f':'benchmark-2026.html',             't':'AI Agent Workflow Benchmark 2026',                   'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'agent-teams-lite.html',           't':'Agent Teams Lite',                                   'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'alphaclaw.html',                  't':'AlphaClaw',                                          'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'cli-anything-architecture.html',  't':'CLI-Anything — Agent-Native Software',               'd':'2026-03-12', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'decapod.html',                    't':'Decapod',                                            'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'droid-cli-orchestrator.html',     't':'Droid CLI Orchestrator',                             'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'forgeflow.html',                  't':'Forgeflow',                                          'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'fractals.html',                   't':'Fractals',                                           'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'get-shit-done.html',              't':'Get Shit Done',                                      'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'gstack.html',                     't':'gstack',                                             'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'jido.html',                       't':'Jido',                                               'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'library-meta-skill-recap.html',   't':'The Library Meta-Skill — Video Recap',               'd':'2026-03-16', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'mission-control.html',            't':'Mission Control',                                    'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'oh-my-openagent.html',            't':'Oh My OpenAgent',                                    'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'opencode-workflow.html',          't':'OpenCode Workflow',                                  'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'orchestra.html',                  't':'Open Orchestra',                                     'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'paperclip.html',                  't':'Paperclip',                                          'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'pi-mono.html',                    't':'Pi Monorepo',                                        'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'pro-workflow.html',               't':'Pro Workflow',                                       'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'qaya-visual.html',                't':'Qaya — Architecture cognitive persistante',           'd':'2026-03-10', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'spec-kit.html',                   't':'Spec Kit',                                           'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'superpowers.html',                't':'Superpowers',                                        'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'symphony.html',                   't':'Symphony',                                           'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'upstream-diff-review.html',       't':'Upstream Diff Review: roxabi-dashboard vs boilerplate','d':'2026-03-10','cat':'ext','cl':'External','c':'green','b':[]},
    {'f':'valora-ai-v2.html',               't':'VALORA v2',                                          'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':['latest']},
    {'f':'valora-ai.html',                  't':'VALORA.AI v1',                                       'd':'2026-03-12', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'valora-vs-pi.html',               't':'VALORA.AI vs Pi Agent — Comparison',                 'd':'2026-03-12', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
    {'f':'wshobson-agents.html',            't':'wshobson/agents — Visual Explainer',                 'd':'2026-03-13', 'cat':'ext', 'cl':'External', 'c':'green', 'b':[]},
]

START = '<!-- diagram-meta:start -->'
END   = '<!-- diagram-meta:end -->'
BLOCK_RE = re.compile(r'\s*' + re.escape(START) + r'.*?' + re.escape(END) + r'\n?', re.DOTALL)


def build_block(e):
    badges = ','.join(e['b'])
    lines = [
        START,
        f'<meta name="diagram:title"     content="{e["t"]}">',
        f'<meta name="diagram:date"      content="{e["d"]}">',
        f'<meta name="diagram:category"  content="{e["cat"]}">',
        f'<meta name="diagram:cat-label" content="{e["cl"]}">',
        f'<meta name="diagram:color"     content="{e["c"]}">',
    ]
    if badges:
        lines.append(f'<meta name="diagram:badges"    content="{badges}">')
    lines.append(END)
    return '\n'.join(lines) + '\n'


def inject(filepath, block):
    text = filepath.read_text(encoding='utf-8')
    # Remove existing block
    text = BLOCK_RE.sub('', text)
    # Insert before </head>
    text = text.replace('</head>', block + '</head>', 1)
    filepath.write_text(text, encoding='utf-8')


ok, skip = 0, 0
for entry in DATA:
    fp = DIR / entry['f']
    if not fp.exists():
        print(f'SKIP (not found): {entry["f"]}')
        skip += 1
        continue
    inject(fp, build_block(entry))
    print(f'OK: {entry["f"]}')
    ok += 1

print(f'\nDone: {ok} injected, {skip} skipped.')
print('Next: python3 gen-manifest.py')
