export const GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "repo view --json nameWithOwner")
    printf '%s' '{"nameWithOwner":"Acme/app"}' ;;
  "issue view 11 --repo Acme/app --json title,body,labels,updatedAt")
    printf '%s' '{"title":"feat(app): first child","body":"not authority","labels":[],"updatedAt":"2026-01-01T00:00:00Z"}' ;;
  "issue view 12 --repo Acme/app --json title,body,labels,updatedAt")
    printf '%s' '{"title":"fix(app): second child","body":"not authority","labels":[],"updatedAt":"2026-01-01T00:00:00Z"}' ;;
  "issue view 14 --repo Acme/app --json title,body,labels,updatedAt")
    printf '{"title":"%s","body":"not authority","labels":[],"updatedAt":"2026-01-01T00:00:00Z"}' "\${GH_PARENT_TITLE:-feat(app): parent delivery}" ;;
  "issue view 13 --repo Acme/app --json title,body,labels,updatedAt")
    echo missing >&2
    exit 1 ;;
  "api repos/Acme/app/issues/11")
    printf '%s' '{"number":11,"state":"open","body":"not authority"}' ;;
  "api repos/Acme/app/issues/12")
    printf '%s' '{"number":12,"state":"open","body":"not authority"}' ;;
  "api repos/Acme/app/issues/14")
    printf '%s' '{"number":14,"state":"open","body":"not authority"}' ;;
  "api graphql "*)
    number=
    for arg in "$@"; do
      case "$arg" in number=*) number=\${arg#number=} ;; esac
    done
    parent=null
    children=
    labels='{"name":"size:S"}'
    case "$number" in
      11) title="feat(app): first child" ;;
      12) title="fix(app): second child" ;;
      14) title="\${GH_PARENT_TITLE:-feat(app): parent delivery}"; children='{"number":15,"repository":{"nameWithOwner":"Acme/app"}}' ;;
      15)
        if [ "\${GH_GRAPH_INCOMPLETE:-}" = yes ]; then echo "child unavailable" >&2; exit 1; fi
        if [ "\${GH_UNKNOWN_WAYFINDER:-}" = yes ]; then labels='{"name":"wayfinder:unknown"}'; fi
        title="feat(app): parent child"; parent='{"number":14,"repository":{"nameWithOwner":"Acme/app"}}' ;;
      *) echo "undeclared graph issue: $number" >&2; exit 1 ;;
    esac
    printf '{"data":{"repository":{"issue":{"number":%s,"title":"%s","body":"not authority","updatedAt":"2026-01-01T00:00:00Z","state":"OPEN","stateReason":null,"repository":{"nameWithOwner":"Acme/app"},"parent":%s,"labels":{"nodes":[%s],"pageInfo":{"hasNextPage":false,"endCursor":null}},"subIssues":{"nodes":[%s],"pageInfo":{"hasNextPage":false,"endCursor":null}},"blockedBy":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' "$number" "$title" "$parent" "$labels" "$children" ;;
  "api repos/Acme/app/issues/13")
    echo missing >&2
    exit 1 ;;
  "api repos/Acme/app/issues/7")
    printf '%s' '{"number":7,"state":"open","body":"not authority","pull_request":{"url":"https://example.invalid/7"}}' ;;
  "pr view 7 --repo Acme/app --json number,state,headRefOid,headRefName,baseRefName,baseRefOid,mergeCommit,author")
    printf '{"number":7,"state":"OPEN","headRefOid":"%s","headRefName":"feat/7-existing","baseRefName":"main","baseRefOid":"%s","mergeCommit":null,"author":{"login":"operator"}}' "$(git rev-parse refs/remotes/origin/feat/7-existing)" "$(git rev-parse refs/remotes/origin/main)" ;;
  *)
    echo "unexpected gh: $*" >&2
    exit 1 ;;
esac
`
