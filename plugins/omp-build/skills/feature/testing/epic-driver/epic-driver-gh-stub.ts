import { execFileSync } from 'node:child_process'

let runtime: { bun: string; ghStub: string } | undefined
export function epicRuntime() {
  if (runtime) return runtime
  const toolingReader = process.env.OMP_TEST_TOOLING_GH_PATH
  if (toolingReader === undefined) throw new Error('Integration tooling reader is required')
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  const ghStub = `#!/usr/bin/env bash
set -uo pipefail
S="$DRIVER_STATE"
ME="operator"
log() { printf '%s\\n' "$*" >> "$S/writes.log"; printf '%s\\n' "$*" >> "$S/trace.log"; printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$S/cwd.log"; }
query() { printf 'query %s\\n' "$1" >> "$S/trace.log"; }
if [[ "$1" == "api" && ( ( "\${2:-}" == "graphql" && "$*" == *"object(expression:"* && "$*" == *"owner=Roxabi"* && "$*" == *"name=roxabi-plugins"* ) || ( "\${2:-}" == "--method" && "\${3:-}" == "GET" && ( "\${4:-}" == repos/Roxabi/roxabi-plugins/git/blobs/* || "\${4:-}" =~ ^repos/Roxabi/roxabi-plugins/git/commits/[0-9a-f]{40}$ ) ) ) ]]; then
  exec ${JSON.stringify(toolingReader)} ${JSON.stringify(import.meta.dirname)} "$@"
fi
case "$1 \${2:-}" in
  "repo view")
    if [[ "$#" -eq 5 && "$4" == "--json" && "$5" == "nameWithOwner" ]]; then
      [[ "$3" == "https://github.com/o/r.git" || "$3" == "\${S%/state}/origin.git" ]] || {
        echo "stub gh: undeclared origin repository $3" >&2; exit 9
      }
      echo '{"nameWithOwner":"o/r"}'
    elif [[ "$#" -eq 4 && "$3" == "--json" && "$4" == "nameWithOwner" ]]; then
      echo '{"nameWithOwner":"o/r"}'
    elif [[ "$#" -eq 6 && "$3" == "--json" && "$4" == "nameWithOwner" && ( "$5" == "--jq" || "$5" == "-q" ) && "$6" == ".nameWithOwner" ]]; then
      echo "o/r"
    elif [[ "$#" -eq 6 && "$3" == "--json" && "$4" == "defaultBranchRef" && ( "$5" == "--jq" || "$5" == "-q" ) && "$6" == ".defaultBranchRef.name" ]]; then
      git --git-dir="\${S%/state}/origin.git" symbolic-ref --short HEAD || exit 9
    else echo "stub gh: undeclared repository query $*" >&2; exit 9; fi ;;
  "api user") if [[ "$*" == *--jq* ]]; then echo "$ME"; else echo '{"login":"operator","id":101,"type":"User"}'; fi ;;
  "api --include")
    if [[ "\${3:-}" == 'repos/o/r/actions/variables?per_page=100&page=1' ]]; then
      printf 'HTTP/2 200\\r\\nContent-Type: application/json\\r\\n\\r\\n%s\\n' '{"total_count":4,"variables":[{"name":"HEAD_AUTH_REPOSITORY_ID","value":"1"},{"name":"HEAD_AUTH_OPERATOR_IDS","value":"[101]"},{"name":"HEAD_AUTH_APP_ID","value":"200"},{"name":"HEAD_AUTH_BOT_USER_ID","value":"201"}]}'
    elif [[ "\${3:-}" =~ ^repos/o/r/issues/([0-9]+)/comments[?]per_page=100[\\&]page=([0-9]+)$ ]]; then
      issue="\${BASH_REMATCH[1]}"; page="\${BASH_REMATCH[2]}"; file="$S/comments-$issue.json"
      [[ -f "$file" ]] || { echo "stub gh: undeclared comment history for issue $issue" >&2; exit 9; }
      printf 'HTTP/2 200\\r\\nContent-Type: application/json\\r\\n'
      if (( $(jq 'length' "$file") > page * 100 )); then
        printf 'Link: <https://api.github.com/repos/o/r/issues/%s/comments?per_page=100&page=%s>; rel="next"\\r\\n' "$issue" "$((page + 1))"
      fi
      printf '\\r\\n'
      jq -c --argjson page "$page" '.[(($page - 1) * 100):($page * 100)]' "$file"
    else echo "stub gh: unhandled $*" >&2; exit 9; fi ;;
  "api graphql")
    q="$*"
    if [[ "$q" == *IssueComment* && "$q" == *lastEditedAt* ]]; then
      node=""
      for arg in "$@"; do [[ "$arg" == id=* ]] && node="\${arg#id=}"; done
      number=""
      for file in "$S"/comments-*.json; do
        [[ -f "$file" ]] || continue
        if jq -e --arg node "$node" 'any(.[]; .node_id == $node)' "$file" >/dev/null; then
          number="\${file##*/comments-}"; number="\${number%.json}"; break
        fi
      done
      [[ -n "$number" ]] || { echo '{"data":{"node":null}}'; exit 0; }
      id="\${node#IC_}"
      jq -cn --arg node "$node" --arg id "$id" --argjson number "$number" '{data:{node:{id:$node,fullDatabaseId:$id,lastEditedAt:null,repository:{fullDatabaseId:"1"},pullRequest:{number:$number,fullDatabaseId:((1000+$number)|tostring)}}}}'
      exit 0
    fi
    if [[ "$q" == *EpicContainmentBranch* || "$q" == *EpicContainmentPullRequest* || "$q" == *EpicContainmentIssue* || ( "$q" == *stateReason* && "$q" == *blockedBy* ) ]]; then
      [[ "$q" == *" owner=o "* && "$q" == *" name=r"* ]] || { echo "stub gh: wrong native graph repository" >&2; exit 9; }
      [[ "$q" != *" labelsCursor="* && "$q" != *" childrenCursor="* && "$q" != *" blockersCursor="* ]] || { echo "stub gh: undeclared graph page" >&2; exit 9; }
    fi
    if [[ "$q" == *'pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED])'* && "$q" == *' owner=o '* && "$q" == *' name=r'* ]]; then
      query delivery-pulls
      [[ "$q" != *" cursor="* ]] || { echo "stub gh: undeclared PR page" >&2; exit 9; }
      jq -se '[.[][]] | if any(.[]; .repository.nameWithOwner != "o/r") then error("foreign PR observation") else group_by(.number) | map(.[0] as $first | if all(.[]; . == $first) then $first else error("conflicting PR observations") end) | if length > 100 then error("undeclared PR pagination") else {data:{repository:{pullRequests:{pageInfo:{hasNextPage:false,endCursor:null},nodes:.}}}} end end' "$S"/branch-prs-*.json
    elif [[ "$q" == *EpicContainmentBranch* ]]; then
      query containment-branch
      branch=""
      for arg in "$@"; do
        [[ "$arg" == head=* ]] && branch="\${arg#head=}"
      done
      [[ ! -f "$S/branch-unavailable" ]] || { echo "stub gh: branch discovery unavailable" >&2; exit 9; }
      jq -s --arg branch "$branch" '{data:{repository:{pullRequests:{pageInfo:{hasNextPage:false},nodes:[.[][] | select(.headRefName == $branch and (.state == "OPEN" or .state == "CLOSED" or .state == "MERGED"))]}}}}' "$S"/branch-prs-*.json
    elif [[ "$q" == *EpicContainmentPullRequest* ]]; then
      query containment-pull-request
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ ]] || { echo "stub gh: invalid PR number" >&2; exit 9; }
      if [[ -f "$S/pr/$number.native.json" ]]; then
        jq -c '{data:{repository:{pullRequest:.}}}' "$S/pr/$number.native.json"
      else
        jq -s --argjson number "$number" '{data:{repository:{pullRequest:([.[][] | select(.number == $number)] | first // null)}}}' "$S"/branch-prs-*.json
      fi
    elif [[ "$q" == *EpicContainmentIssue* ]]; then
      query containment-issue
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ && -f "$S/uw-$number.json" && -f "$S/containment-$number.json" ]] || {
        echo "stub gh: missing containment issue $number" >&2
        exit 9
      }
      cat "$S/containment-$number.json"
    elif [[ "$q" == *stateReason* && "$q" == *blockedBy* ]]; then
      query uw-graph
      number=""
      for arg in "$@"; do
        [[ "$arg" == number=* ]] && number="\${arg#number=}"
      done
      [[ "$number" =~ ^[0-9]+$ && -f "$S/uw-$number.json" ]] || {
        echo "stub gh: missing strict graph for $number" >&2
        exit 9
      }
      cat "$S/uw-$number.json"
    elif [[ "$q" == *subIssues* ]]; then
      query subIssues
      n=$(( $(cat "$S/reads" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/reads"
      if [[ -f "$S/epic.json.$n" ]]; then cat "$S/epic.json.$n"; else cat "$S/epic.json"; fi
    elif [[ "$q" == *statusCheckRollup* ]]; then
      query statusCheckRollup
      if [[ -f "$S/rollup.json" ]]; then cat "$S/rollup.json"
      else echo '{"data":{"repository":{"object":{"statusCheckRollup":null}}}}'; fi
    else echo "stub gh: unhandled GraphQL query $*" >&2; exit 9; fi ;;
  "api repos/"*)
    resource="$2"
    comments_path='^repos/o/r/issues/([0-9]+)/comments[?]per_page=100[&]page=([0-9]+)$'
    commit_path='^repos/o/r/git/commits/([0-9a-f]{40})$'
    compare_path='^repos/o/r/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})[?]per_page=100[&]page=([0-9]+)$'
    if [[ "$resource" == "repos/o/r" ]]; then echo '{"id":1}'; exit 0; fi
    if [[ "$resource" == repos/o/r/git/ref/heads/* ]]; then
      ref="\${resource#repos/o/r/git/ref/heads/}"
      ref="\${ref//%2F//}"
      sha=$(git --git-dir="$S/../origin.git" rev-parse --verify "refs/heads/$ref") || exit 1
      jq -cn --arg ref "refs/heads/$ref" --arg sha "$sha" '{ref:$ref,object:{sha:$sha}}'
      exit 0
    fi
    if [[ "$resource" =~ ^repos/o/r/pulls/([0-9]+)$ ]]; then
      number="\${BASH_REMATCH[1]}"
      if [[ -f "$S/pr/$number.native.json" ]]; then
        raw=$(cat "$S/pr/$number.native.json")
      else
        raw=$(jq -s --argjson number "$number" '[.[][] | select(.number == $number)] | first // null' "$S"/branch-prs-*.json)
      fi
      jq -cn --argjson raw "$raw" --argjson number "$number" '{id:(1000+$number),number:$number,user:{id:101},head:{sha:$raw.headRefOid},base:{ref:$raw.baseRefName,sha:("b"*40),repo:{id:1}}}'
      exit 0
    fi
    if [[ "$resource" =~ $commit_path ]]; then
      sha="\${BASH_REMATCH[1]}"
      line="$(git --git-dir="$S/../origin.git" rev-list --parents -n1 "$sha")" || exit 9
      printf '%s\\n' "$line" | jq -R 'split(" ") | {sha:.[0],parents:(.[1:] | map({sha:.}))}'
    elif [[ "$resource" =~ $compare_path ]]; then
      base="\${BASH_REMATCH[1]}" head="\${BASH_REMATCH[2]}" page="\${BASH_REMATCH[3]}"
      [[ "$page" =~ ^[1-9][0-9]*$ ]] || { echo "stub gh: invalid comparison page" >&2; exit 9; }
      git --git-dir="$S/../origin.git" merge-base --is-ancestor "$base" "$head" || { echo "comparison is not an observed ancestor range" >&2; exit 9; }
      commits="$(git --git-dir="$S/../origin.git" rev-list --reverse "$base..$head")" || exit 9
      entries="$(while IFS= read -r sha; do [[ -z "$sha" ]] || git --git-dir="$S/../origin.git" rev-list --parents -n1 "$sha" || exit 9; done <<< "$commits" | jq -Rsc 'split("\\n") | map(select(length > 0) | split(" ") | {sha:.[0],parents:(.[1:] | map({sha:.}))})')" || exit 9
      jq -cn --argjson entries "$entries" --argjson page "$page" '{status:(if ($entries | length) == 0 then "identical" else "ahead" end),total_commits:($entries | length),commits:$entries[(($page-1)*100):($page*100)]}'
    elif [[ "$resource" =~ $comments_path ]]; then
      issue="\${BASH_REMATCH[1]}"
      page="\${BASH_REMATCH[2]}"
      [[ "$page" =~ ^[1-9][0-9]*$ ]] || { echo "stub gh: invalid comment page" >&2; exit 9; }
      file="$S/comments-$issue.json"
      [[ -f "$file" ]] || { echo "stub gh: undeclared comment history for issue $issue" >&2; exit 9; }
      jq -c --argjson page "$page" '.[(($page - 1) * 100):($page * 100)]' "$file"
    else
      echo "stub gh: unhandled $*" >&2
      exit 9
    fi ;;
  "api --method")
    [[ "$3" == "POST" && "$4" =~ ^repos/o/r/issues/([0-9]+)/comments$ && "$5" == "-f" && "$6" == body=* ]] || {
      echo "stub gh: unhandled $*" >&2
      exit 9
    }
    issue="\${BASH_REMATCH[1]}"
    body="\${6#body=}"
    if [[ "$body" == '<!-- kit-head-authorization:v1 -->'* && -f "$S/withdraw-forbidden" ]]; then
      echo 'Resource not accessible by integration (HTTP 403)' >&2
      exit 1
    fi
    file="$S/comments-$issue.json"
    [[ -f "$file" ]] || { echo "stub gh: undeclared comment history for issue $issue" >&2; exit 9; }
    id=$(( $(jq -s '[.[][]?.id // 0] | max // 1000' "$S"/comments-*.json) + 1001 ))
    posted="$(jq -cn --arg author "$ME" --argjson id "$id" --arg body "$body" '{id: $id, node_id: ("IC_"+($id|tostring)), body: $body, user: {login: $author,id:101,type:"User"}, performed_via_github_app:null, created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z"}')"
    jq -c --argjson posted "$posted" '. + [$posted]' "$file" > "$S/tmp" && mv "$S/tmp" "$file"
    first="\${body%%$'\\n'*}"
    log "comment $issue $first"
    printf '%s\n' "$posted" ;;
  "issue view")
    [[ "$#" -eq 7 && "$3" =~ ^[1-9][0-9]*$ && "$4" == "--repo" && "$5" == "o/r" && "$6" == "--json" && ( "$7" == "body,updatedAt,state,labels" || "$7" == "body,updatedAt,labels" || "$7" == "title,body,labels,updatedAt" ) && -f "$S/uw-$3.json" ]] || {
      echo "stub gh: undeclared issue view $*" >&2; exit 9
    }
    jq -c '.data.repository.issue | {title, body, updatedAt, state, labels: .labels.nodes}' "$S/uw-$3.json" ;;
  "pr view")
    if [[ "$*" == *'number,state,headRefOid,headRefName,baseRefName,baseRefOid,mergeCommit,author'* ]]; then
      [[ "$#" -eq 7 && "$3" =~ ^[1-9][0-9]*$ && "$4" == "--repo" && "$5" == "o/r" && "$6" == "--json" ]] || {
        echo "stub gh: invalid native PR identity $*" >&2; exit 9
      }
      node="$(jq -cse --argjson number "$3" '[.[][] | select(.number == $number)] | if length == 0 then error("native PR missing") else .[0] as $first | if $first.repository.nameWithOwner != "o/r" then error("foreign PR observation") elif all(.[]; . == $first) then $first else error("native PR observations conflict") end end' "$S"/branch-prs-*.json)" || exit 9
      if [[ "$(jq -r '.baseRefOid // empty' <<< "$node")" == "" ]]; then
        base="$(jq -er '.baseRefName | select(type == "string" and length > 0)' <<< "$node")" || exit 9
        base_tip="$(git --git-dir="$S/../origin.git" rev-parse --verify "refs/heads/$base^{commit}")" || { echo "stub gh: native base ref unreadable" >&2; exit 9; }
        jq -c --arg base_tip "$base_tip" '.baseRefOid = $base_tip' <<< "$node"
      else printf '%s\n' "$node"; fi
    else cat "$S/pr/$3.json"; fi ;;
  "pr edit")
    log "edit $3 \${*:4}"
    if [[ -f "$S/pr/$3.merge-on-edit.json" ]]; then
      cp "$S/pr/$3.merge-on-edit.json" "$S/pr/$3.native.json"
      jq -c '{state, labels: [.labels.nodes[]], autoMergeRequest}' "$S/pr/$3.native.json" > "$S/pr/$3.json"
      for staged in "$S"/containment-*.json.after-edit "$S"/branch-prs-*.json.after-edit "$S"/uw-*.json.after-edit; do
        [[ -f "$staged" ]] || continue
        cp "$staged" "\${staged%.after-edit}"
        rm "$staged"
      done
      rm "$S/pr/$3.merge-on-edit.json"
    elif [[ ! -f "$S/pr/$3.sticky" ]]; then
      jq -c '.labels = []' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"
    fi ;;
  "pr merge")
    log "merge $3 \${*:4}"
    [[ -f "$S/pr/$3.sticky" ]] || { jq -c '.autoMergeRequest = null' "$S/pr/$3.json" > "$S/tmp" && mv "$S/tmp" "$S/pr/$3.json"; } ;;
  *) echo "stub gh: unhandled $*" >&2; exit 9 ;;
esac
`
  runtime = { bun, ghStub }
  return runtime
}
