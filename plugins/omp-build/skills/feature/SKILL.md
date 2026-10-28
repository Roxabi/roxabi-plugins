---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject> | init | pause #N | abandon #N | resume #N | new #N | material-decision #N]'
description: Reference for the installed /feature command: controls, human decisions, and where records live.
version: 0.1.12
---

# Feature

The installed `/feature` command owns selection and continuation. `omp/index.ts` registers it and calls `runInstalledFeatureCommand` in `roxabi/feature-entry.ts`. That registered command does not dump this file into the turn. Explicit `skill://feature` or `/skill:feature` access supplies reference material, not another lifecycle or execution authority. A session `/goal` is not authority.

Package `0.13.0` in this tree is not evidence of installation, activation or runtime qualification. This reference grants no campaign or hosted-activation authority.

One issue, one branch, one worktree, one PR. The body carries a proposed own Spec in the sole English-heading grammar documented in the plugin README; author-language statements are preserved. Accepted Spec comes from the applicable `/3` mandate and its authenticated assessment/operator chain, not from a manual body edit. Ancestor Spec is not applicable until the separate inheritance work.

## Operator controls

`parseFeatureCommand` is the word list. A known transition does not ask again.

| Command | Boundary |
|---|---|
| `/feature <reference>` | Publishes the first valid mandate, or reuses an applicable one. No routine confirmation. Legacy normalization requires approval of the exact proposal before the same request can continue. |
| `/feature resume <reference>` | Resumes an ordinary confirmed pause. A review-bound or safety stop is not a pause. |
| `/feature pause <reference>` | Inhibits local continuation and publishes the control. Confirmed only after observed disarm. |
| `/feature abandon <reference>` | Revokes the mandate. No automatic renewal. |
| `/feature new <reference>` | Successor over an intact abandoned or revoked mandate. `publishSuccessorMandate` names the antecedent and publishes `select-successor`. `preserveSuccessorBinding` rebinds the same open PR when its binding names the antecedent or is absent. A missing antecedent or a foreign binding does not mint. Not renewal of `/feature <reference>`. `new init` is this control, not init. |
| `/feature material-decision <reference>` | Opens the context-bound operator UI for the exact authenticated material or unknown proposal. `accept`/`reject` argv is not authority and is refused. `/uw accept-material <reference>` uses the same acceptance chain. |
| `/feature init` | Preview of the invoking checkout. Not a subject, not framing, not a mandate, not a native task. |

From the Principal, or when the session cwd is not the intended worktree, select, resume, and new return `session-cwd` and `/move <path>`. They publish no mandate, branch binding, or native work. When the workflow stops or hands back work instead, the Principal sends one `feature-stopped: principal-dispatch-refused: <reason>` message and starts nothing. The reason is the workflow's stop, for example `operator-decision:needs-scope`, or the refused `workflow-result: <kind>`. `needs-framing` guidance is sent as is: moving would not change it. After `/move`, the same `/feature <reference>` is continuation, not a second approval. Pause and abandon of existing remote authority may still run without native work. There is no `/wt`.

`/dev-review` and `/fix` do not grant landing. A fix-only mandate never lands. Landing authority is `requireLandingMandate` in `engine/workflow-landing-admission.ts`, used by `landPr` and the trusted CI gate. The landing binding is the confirmed `workflow-binding` on the PR. A closing keyword, issue body, or branch name is not that binding. T5 is not authorized here. That gate must read issue bodies, comments, and explicit parent scopes with the App token. Live App Issues: read is unverified; do not claim it is missing and do not change the token. The check is in the plugin README.

## Init

`/feature init` and `/feature init --dry-run` are the same preview. The host captures `git rev-parse --show-toplevel`. A failed capture stops and does not frame. Otherwise it runs `bun --no-env-file <plugin>/skills/feature/feature-init.ts --dir <that root>` with Bun's cwd set to the script directory. It forwards only the operator's tokens. It does not add `--approve` or `--operator-approval`.

The preview prints proposed stack additions, conflicts, the tracker plan, and a digest, then `digest is not authorization`. It does not run `worktree-bootstrap.sh`, write the stack, or write tracker labels. A printed digest is not an init reference and not an approval.

Explicit apply is the operator's own reply, forwarded verbatim:

```text
/feature init --approve <digest> --operator-approval '<operator reply>'
```

`feature-init.ts` refuses a missing reply, a reply that is the digest, a digest that does not match the preview, a plan that changed, and a Principal checkout. A decline, silence, or a later agent turn applies nothing. An unchanged proposal reports `init=noop`.

## Human decisions the command will not invent

- Copy an init approval only from the operator's own reply.
- Material or unknown Spec: wait for the real operator UI on the exact authenticated proposal. The model supplies semantic classification; code still forces mechanical additions, withdrawals, exclusions, tier and accepted-child changes through material control. Editorial continuation requires the authenticated assessment chain.
- Repeating `/feature <reference>` does not renew an abandoned or revoked mandate. `/feature new <reference>` is the successor command, not automatic renewal.
- Mid-turn user interrupt (Esc/RPC while an assistant turn is streaming), session switch, and shutdown await the durable pause for a pausable owner. Ordinary idle settle does not. Confirmation is the read-back `pause-confirmed` control. A finished or confirmed-abandoned owner is released and is not paused again. An unconfirmed pause or a spent review bound is not a resumable pause. While only the host-owned CI watch is running with no model turn, Esc/RPC is not a workflow pause — use `/feature pause` or `/feature abandon`.
- After a confirmed merge, offer `/cleanup`. Offer `/promote` only when `.dev/stack.yml` declares `release.model: staging-train`. Leave both for the operator to invoke.
- `needs-framing` returns the named missing criterion, tier, open-question or native-graph diagnostics. A legacy body can receive a model-assisted, accounted normalization proposal; confirmation writes the same issue, reads it back, then continues the original request. Do not invent criteria or confirmation, create a replacement issue, or turn a body write into acceptance. Planning consumes canonical criteria, never a second heading/bullet extractor.

## Obligations the announced actions keep

The command dispatches the named actions. This file does not run a second loop. Policy lives in the named code.

| Obligation | Where |
|---|---|
| Tracker writes, labels, native relations | UW operations inject the importable issue-triage writer and κ rubric; the thin `/uw` command is not another workflow or an authorization source. Standalone issue-triage remains independent. Existing debt filing and epic fix-ticket paths retain the emitted CLI until their separate migration; init retains the emitted planner and `defaultInitDeps(repository, checkout)`. Native relations are real GitHub mutations, not closing prose. The generated `dist/issue-triage/` slice is committed with the plugin. |
| Plan | One read-only architect and adversarial round after criterion-to-code mapping. A blocking finding amends the plan before implementation and spends no PR fix round. `agents/R-workflow-plan.md`; `planAction` in `roxabi/workflow.ts`. |
| Implementation | Changed-path proof, affected docs, browser check or declared `commands.test_e2e`, task-owned Conventional commits ending `(#N)`. `agents/R-workflow-implement.md`. A model's commit list is a claim; the host binds captured commands and Git lineage. |
| Review input | `hashReviewInput` prefixes `omp-build:review-input/3` and captures the observed PR inputs and semantic context without producer parts. A stored null input is not approval; absent or older input formats refuse with `incompatible-format`. |
| Review, correction, landing, watch | `continueFeature` → `reconstructWorkflow` selects the next Feature lifecycle action. `nextReviewStep` retains PR review/bound policy; `landPr` and `applyCiWatchExit` execute guarded landing/watch actions. Actual landing also requires `requireLandingMandate`. The bound is sticky: a third non-approving review stays spent after a later green, and a third approving review followed by red CI stays spent after later green checks. |
| Epic | `skills/feature/epic-driver.ts` reads the confirmed mandate on the epic issue. The installed command calls `next`, `stop`, `review`, `mark-fix`, `hook`, `report`, and `control-disarm`. There is no `objective` and no goal file. A ticket stop lets independent children continue. The hook runs once at the current base commit; another commit is `hook-stale`. The report heading is `## Epic run`. Merged is not complete before the hook and report are observed. |
| Worktree bootstrap | `runWorktreeBootstrap` in `roxabi/workflow-checkout.ts` runs `skills/feature/worktree-bootstrap.sh` in the foreground after worktree identity is valid and before dispatch: successor, first mandate, and select/resume/new in a valid worktree. The marker `omp-build-bootstrapped` and lock `omp-build-bootstrap.lock` are environment cache, not business records. The script refuses the principal. `/feature init`, `prepareFeatureCheckout`, `session_start`, and `agent_start` do not run it. Do not shell it out as a second process. |

Wire names `goal-stop` and `goal-report` are `epic-event` payload values. They name a recorded transition. They do not authorize a run.

## Where continuation comes from

GitHub comments hold the business records. Git holds the code and committed workflow inputs. A confirmed checkpoint is a published record read back, plus the Git facts that bind it. There is no mandatory local business workflow store. Local environment files do exist and are reconstructible: dependency installs, indexes, and the per-git-dir bootstrap marker and lock. They are not authority. An OMP goal, transcript, or local session file is not authority either.

Cannot resume: unpublished commits, a result never published, an action whose effect is uncertain, a pause request without observed disarm, a local-only worktree change. A cold machine does not copy the marker, those caches, or a transcript. Moving machines needs the same operator identity, this plugin, GitHub auth, and the project tools, then `/feature <reference>` in the intended worktree. The environment is rebuilt there, not copied. There is no anti-tamper store and no second database. Comment edit or deletion remains an accepted risk, not a new prerequisite.

Graph, config, and landing policy: `engine/workflow-reconstruction-admission.ts` (`reconstructWorkflow`), `engine/workflow-landing-admission.ts` (`requireLandingMandate`), `roxabi/workflow-config.ts` (`parseWorkflowOverride`), `roxabi/workflow.ts` (`continueFeature`), and `adapters/github/**`. The only project override of the shipped workflow definition is `review.additional_requirements` in committed `.dev/stack.yml` on `refs/remotes/origin/<base>`: non-empty strings, or none when absent. Existing `landing`, `release`, and `commands` configuration remains in force. `review.graph` and `review.workflow` are refused. There is no `.omp-build/workflow.json`. The list does not override the shipped graph, a review bound, or landing admission.
