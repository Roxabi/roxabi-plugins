# Release Safety Gate

The safety gate wraps every release of the fictional Beacon service. Most of this document is verbatim-class content: the exact commands and the safety rules must survive any rewrite unchanged.

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

The gate refuses to promote when the smoke suite has not run within the last six hours. A promotion that fails halfway leaves the release in the quarantine state, and a quarantined release can only be retried after the check step passes again. Timeouts on the smoke step count as failures, not as skips. The gate writes one audit line per attempt to the release journal.
