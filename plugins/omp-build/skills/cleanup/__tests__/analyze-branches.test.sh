#!/usr/bin/env bash
# Integration test for analyze-branches.sh using a temporary git fixture.
set -euo pipefail

# Isolate from any inherited git context. This fixture builds a throwaway repo
# via mktemp + cd + git init and relies on cwd-based repo discovery — but a git
# hook (e.g. pre-push, which runs this suite) exports GIT_DIR/GIT_WORK_TREE into
# the environment, and those override cwd discovery. Without clearing them the
# fixture's `git branch -M main`, `git worktree add`, etc. would target the
# caller's REAL repository instead of the temp one below.
unset $(git rev-parse --local-env-vars)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE="${SCRIPT_DIR}/../analyze-branches.sh"

TMPDIR_FIXTURE="$(mktemp -d)"
WT_DIR="${TMPDIR_FIXTURE}/wt-i18n"
trap 'rm -rf "$TMPDIR_FIXTURE" "${ORIGIN_ROOT:-}" "${GREP_ROOT:-}"' EXIT

cd "$TMPDIR_FIXTURE"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"

echo "base" > README.md
git add README.md
git commit -q -m "chore: init main"
git branch -M main

echo "merged" > merged.txt
git checkout -q -b feat/19-auth
git add merged.txt
git commit -q -m "feat: auth (#19)"
git checkout -q main
git merge -q --no-ff feat/19-auth -m "Merge pull request #19 from feat/19-auth"

echo "wip" > wip.txt
git checkout -q -b feat/33-i18n
git add wip.txt
git commit -q -m "feat: i18n work in progress"

git checkout -q main
git worktree add -q "$WT_DIR" feat/33-i18n

# Scope-collision fixture (#2 / F1-style): a branch whose number *contains*
# 19 as a substring but is a different issue — must not leak into --scope 19.
echo "unrelated" > other.txt
git checkout -q -b feat/319-other-thing
git add other.txt
git commit -q -m "chore: unrelated branch (#319)"
git checkout -q main

DEBUG_JSON=""
assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label expected '$expected', got '$actual'" >&2
    echo "$DEBUG_JSON" | jq . >&2
    exit 1
  fi
}

result="$("$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$result"

safe_local="$(echo "$result" | jq -r '.safe_local | join(",")')"
safe_remote="$(echo "$result" | jq -r '.safe_remote | join(",")')"
i18n_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .action')"
auth_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .action')"
auth_merged="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .merged')"
i18n_worktree="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .worktree')"

assert_eq "safe_local includes feat/19-auth" "feat/19-auth" "$safe_local"
assert_eq "feat/19-auth action" "safe_delete" "$auth_action"
assert_eq "feat/19-auth merged" "true" "$auth_merged"
assert_eq "feat/33-i18n action" "unmerged" "$i18n_action"
assert_eq "feat/33-i18n has worktree" "true" "$(if [ "$i18n_worktree" != "null" ] && [ -n "$i18n_worktree" ]; then echo true; else echo false; fi)"
assert_eq "safe_remote empty without origin" "" "$safe_remote"
assert_eq "unscoped run sees all 3 local branches" "3" "$(echo "$result" | jq '.local_branches | length')"

# --scope 19 (F2): must include only feat/19-auth — excluding both
# feat/33-i18n (different issue) and feat/319-other-thing (substring
# collision: "19" ⊂ "319", would false-match an unanchored scope filter).
result_scoped="$("$ANALYZE" --json --no-fetch --scope 19)"
DEBUG_JSON="$result_scoped"

scoped_scope="$(echo "$result_scoped" | jq -r '.scope')"
scoped_names="$(echo "$result_scoped" | jq -r '[.local_branches[].name] | join(",")')"

assert_eq "--scope 19 echoed in JSON" "19" "$scoped_scope"
assert_eq "--scope 19 includes only feat/19-auth (excludes #33, #319)" "feat/19-auth" "$scoped_names"

# --scope with a leading '#' (as the operator passes it: `/cleanup --scope #N`).
result_hash_scoped="$("$ANALYZE" --json --no-fetch --scope "#19")"
DEBUG_JSON="$result_hash_scoped"
assert_eq "--scope #19 strips the leading #" "19" "$(echo "$result_hash_scoped" | jq -r '.scope')"

# Regression: base present only as origin/<base>, not checked out locally (the
# worktree-per-issue norm). branch_merged must resolve origin/<base> and must NOT
# mis-classify an unmerged branch as safe_delete just because no LOCAL base branch
# exists. Before the BASE_REF fix, `git log staging..feat/50-thing` errored (no
# local staging) -> empty stdout -> merged=true -> safe_delete.
ORIGIN_ROOT="$(mktemp -d)"
git init -q --bare "${ORIGIN_ROOT}/origin.git"
git init -q "${ORIGIN_ROOT}/work"
cd "${ORIGIN_ROOT}/work"
git config user.email "test@example.com"
git config user.name "Test User"
git remote add origin "${ORIGIN_ROOT}/origin.git"
echo base > f.txt
git add f.txt
git commit -q -m "chore: base"
git branch -M staging
git push -q -u origin staging
echo wip > wip.txt
git checkout -q -b feat/50-thing
git add wip.txt
git commit -q -m "feat: wip (#50)"
git checkout -q -b scratch        # sit off the feature so it is not the current branch
git branch -q -D staging          # only origin/staging remains as the base ref
git fetch -q origin               # ensure the origin/staging tracking ref exists

result_origin="$("$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$result_origin"
origin_base="$(echo "$result_origin" | jq -r '.base_branch')"
feat50_action="$(echo "$result_origin" | jq -r '.local_branches[] | select(.name == "feat/50-thing") | .action')"
feat50_merged="$(echo "$result_origin" | jq -r '.local_branches[] | select(.name == "feat/50-thing") | .merged')"

assert_eq "origin-only base resolves to staging" "staging" "$origin_base"
assert_eq "unmerged branch NOT safe_delete when base only on origin/*" "unmerged" "$feat50_action"
assert_eq "unmerged branch merged=false when base only on origin/*" "false" "$feat50_merged"

# Regression (#536 F1): a commit on BASE that merely *mentions* `#50` is not
# evidence that feat/50-thing shipped — any commit can type the number. The
# branch below has a real, unmerged commit and is pushed to origin. Before the
# merge_reason fix, the grep hit set merged=true, the branch landed in
# `safe_remote`, and Step 6e's `git push origin --delete` deleted the only copy
# of the work that was still on the server — a deletion no git-side check
# refuses and no local branch can recover.
GREP_ROOT="$(mktemp -d)"
git init -q --bare "${GREP_ROOT}/origin.git"
git init -q "${GREP_ROOT}/work"
cd "${GREP_ROOT}/work"
git config user.email "test@example.com"
git config user.name "Test User"
git remote add origin "${GREP_ROOT}/origin.git"
echo base > f.txt
git add f.txt
git commit -q -m "chore: base"
git branch -M staging
echo note > note.txt
git add note.txt
git commit -q -m "docs: describe the plan for #50"   # mentions the issue; merges nothing
git push -q -u origin staging

git checkout -q -b feat/50-thing
echo wip > wip.txt
git add wip.txt
git commit -q -m "feat: real work (#50)"
git push -q -u origin feat/50-thing
git checkout -q -b scratch        # sit off the feature so it is not the current branch

result_grep="$("$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$result_grep"

grep_local="$(echo "$result_grep" | jq -r '.local_branches[] | select(.name == "feat/50-thing")')"
grep_remote="$(echo "$result_grep" | jq -r '.remote_branches[] | select(.name == "feat/50-thing")')"

assert_eq "grep hit is not proof of merge" "false" "$(echo "$grep_local" | jq -r '.merged')"
assert_eq "grep hit is labelled as such" "squash_grep" "$(echo "$grep_local" | jq -r '.merge_reason')"
assert_eq "commits ahead of base are surfaced" "1" "$(echo "$grep_local" | jq -r '.commits_ahead')"
assert_eq "grep hit gets its own action, not safe_delete" "probably_merged" "$(echo "$grep_local" | jq -r '.action')"
assert_eq "remote row too" "probably_merged" "$(echo "$grep_remote" | jq -r '.action')"
assert_eq "grep hit never reaches safe_remote" "false" \
  "$(echo "$result_grep" | jq -r '.safe_remote | index("feat/50-thing") != null')"
assert_eq "grep hit never reaches safe_local" "false" \
  "$(echo "$result_grep" | jq -r '.safe_local | index("feat/50-thing") != null')"
assert_eq "it is still reported, on the list that says verify" "true" \
  "$(echo "$result_grep" | jq -r '.probably_remote | index("feat/50-thing") != null')"

# The other half of the same contract: a squash merge IS provable, and the proof
# is `MERGED` plus ancestry — the PR's head SHA reachable from the commit that
# merged it. `gh` is stubbed rather than called: the assertion is about what the
# analyser does with the PR record, and a fixture repo has no GitHub.
STUB_BIN="${GREP_ROOT}/bin"
mkdir -p "$STUB_BIN"
stub_gh() {
  # $1 = headRefOid, $2 = mergeCommit oid
  cat > "${STUB_BIN}/gh" <<EOF
#!/usr/bin/env bash
case "\$*" in
  "pr list --state all"*) printf '%s' '[{"headRefName":"feat/50-thing","number":50,"state":"MERGED","title":"feat: real work","headRefOid":"$1","mergeCommit":{"oid":"$2"}}]' ;;
  *) printf '%s' '[]' ;;
esac
EOF
  chmod +x "${STUB_BIN}/gh"
}

HEAD_SHA="$(git rev-parse feat/50-thing)"
git checkout -q staging 2>/dev/null || git checkout -q -b staging origin/staging
git merge -q --no-ff feat/50-thing -m "Merge pull request #50 from feat/50-thing"
MERGE_SHA="$(git rev-parse HEAD)"
git reset -q --hard HEAD~1   # base drops it again: only the PR record can prove the merge
git checkout -q scratch

stub_gh "$HEAD_SHA" "$MERGE_SHA"
verified="$(PATH="${STUB_BIN}:$PATH" "$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$verified"
assert_eq "verified squash is proof" "true" \
  "$(echo "$verified" | jq -r '.remote_branches[] | select(.name == "feat/50-thing") | .merged')"
assert_eq "verified squash is labelled squash_pr" "squash_pr" \
  "$(echo "$verified" | jq -r '.remote_branches[] | select(.name == "feat/50-thing") | .merge_reason')"
assert_eq "verified squash reaches safe_remote" "true" \
  "$(echo "$verified" | jq -r '.safe_remote | index("feat/50-thing") != null')"

# Same PR record, merge commit that does not contain the head: MERGED is a label,
# not evidence about these commits.
stub_gh "$HEAD_SHA" "$(git rev-parse staging)"
unverified="$(PATH="${STUB_BIN}:$PATH" "$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$unverified"
assert_eq "MERGED without ancestry is not proof" "squash_pr_unverified" \
  "$(echo "$unverified" | jq -r '.remote_branches[] | select(.name == "feat/50-thing") | .merge_reason')"
assert_eq "MERGED without ancestry stays out of safe_remote" "false" \
  "$(echo "$unverified" | jq -r '.safe_remote | index("feat/50-thing") != null')"

echo "PASS: analyze-branches.test.sh"