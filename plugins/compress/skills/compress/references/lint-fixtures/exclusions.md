---
title: Exclusions fixture
filters: status ∈ open || closed
---

# Fixture — Exclusions

Every plant inside the four regions below sits INSIDE a hard-excluded region: a correct lint run reports zero findings inside them. One additional plant sits deliberately OUTSIDE every excluded region, after the boundary heading below, to prove the heading-exclusion rule doesn't over-extend past its own close — a correct lint run fires exactly that one finding. The frontmatter above carries `||` on a notation-glyph line (or-drift bait, excluded as frontmatter). Fictional.

## Fenced block

```
pipeline: intake → → review
```

## Inline spans

The deprecation record cites `⇔` and the doubled arrow `→ → ` in inline code — both excluded as inline code spans.

## Spawn template

Prose plant directly in this section: the handoff reads triage → → assign (excluded by the heading rule — /spawn/i extent runs to the next same-or-higher heading).

```
Task(
  subagent_type: "general-purpose",
  prompt: "chain: read → → summarize — planted inside a fenced Task( block"
)
```

## Boundary check

This same-level heading closes the spawn extent — renamed off `/spawn/i` on purpose: a heading literally titled "after the spawn section" would itself match the heading-exclusion regex and silently re-open an excluded region for the rest of the file, which would make the file's zero-findings claim pass vacuously instead of for the right reason. The handoff reads intake → → publish here (positive — outside every excluded region, this plant must fire).
