<!-- compress: level=L2 src-sha=0d0ef87438b30117e1266a06c0f3db7fc7aed8a7 glossary=none -->
<!-- min-N demo: 4 non-L0 items < 8 — read-back on this triple yields "insufficient sample — human-gated" -->

# Release Safety Gate

Wraps every release of the fictional Beacon service. The safety rules and commands below are L0 (verbatim class — no anchors); only the operating notes are non-L0.

## Safety rules

1. Never release while an incident is open.
2. Never edit the release manifest by hand.
3. Never skip the smoke suite, even for documentation-only changes.
4. Always keep the previous artifact available for rollback.

## Commands

Run the gate exactly like this:

```
beacon gate check --release <tag>
beacon gate smoke --release <tag> --timeout 900
beacon gate promote --release <tag>
```

## Operating notes

<!-- INV-thresh-1 -->
- ¬promote when the smoke suite has not run within the last 6 hours
<!-- INV-cond-2 -->
- promotion fails halfway → release enters quarantine; a quarantined release retries only after the check step passes again
<!-- INV-edge-3 -->
- timeouts on the smoke step count as failures, not as skips
<!-- INV-rule-4 -->
- one audit line per attempt is written to the release journal
