/** One single-quoted shell word. */
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const unquote = (word: string) => word.replaceAll("'\\''", "'")

export type SimClientMode = 'sim' | 'fault'

export interface SimClient {
  mode: SimClientMode
  /** Loopback port of the per-file server. */
  port: number
  /** Token the server requires on every request. */
  token: string
  /** Per-file directory for staged stdin and release-wait FIFOs. */
  dir: string
  /** Standalone entry when the server must not serve the call: the simulator binary, or the fault script run by Bun. */
  fallback: string
}

/** Bash source of a per-file `gh` client for the simulator server. */
export function simClientScript(client: SimClient): string {
  const fallback = client.mode === 'sim' ? quote(client.fallback) : `bun ${quote(client.fallback)}`
  const stdinTemplate = quote(`${client.dir}/stdin.XXXXXXXX`)
  return `#!/bin/bash
if [[ \${OMP_GH_SIM_SERVER_REQUEST:-} == 1 ]]; then
  echo 'gh simulator: nested gh call inside a simulator request' >&2
  exit 1
fi
use_standalone=
[[ -r /proc/$$/environ ]] || use_standalone=1
[[ -z \${GH_SIM_STATE:-} || ! -e "\${GH_SIM_STATE}.lock" ]] || use_standalone=1
for barrier in "\${!GH_SIM_COMMENT_BARRIER_@}"; do
  use_standalone=1
done
[[ -z $use_standalone ]] || exec ${fallback} "$@"
stdin_path=
stderr_path=
release_path=
wait_dir=
cleanup() {
  [[ -z $stdin_path ]] || /bin/rm -f -- "$stdin_path"
  [[ -z $release_path || $release_path == - ]] || /bin/rm -f -- "$release_path"
  [[ -z $wait_dir ]] || /bin/rm -rf -- "$wait_dir"
  [[ -z $stderr_path || $stderr_path == - || $stderr_path == '!' ]] || /bin/rm -f -- "$stderr_path"
}
trap cleanup EXIT
previous=
for arg in "$@"; do
  if [[ $previous == --body-file && $arg == - ]]; then
    stdin_path=$(/usr/bin/mktemp ${stdinTemplate}) || exit 1
    /bin/cat > "$stdin_path" || exit 1
    break
  fi
  previous=$arg
done
if ! { exec 3<>/dev/tcp/127.0.0.1/${client.port}; } 2>/dev/null; then
  echo 'gh simulator: server unavailable' >&2
  exit 1
fi
printf '%s\\0' ${quote(client.token)} "$$" "$#" "$@" "$stdin_path" ${quote(client.mode)} >&3 || exit 1
if ! IFS= read -r -d '' status <&3 || ! IFS= read -r -d '' stderr_path <&3 || ! IFS= read -r -d '' release_path <&3; then
  echo 'gh simulator: server did not respond' >&2
  exit 1
fi
if [[ $status != 0 && $status != 1 ]] || [[ -z $stderr_path || -z $release_path ]]; then
  echo 'gh simulator: invalid server response' >&2
  exit 1
fi
if [[ $stderr_path == '!' ]]; then
  echo 'gh simulator: authentication failed or invalid request' >&2
  exit 1
fi
/bin/cat <&3 || exit 1
# Failure-only differences from standalone: timeout prints the same message without
# Bun's exception stack; fault-core exceptions are reported as "gh simulator: <error>".
if [[ $release_path != - ]]; then
  { IFS= read -r -d '' release && IFS= read -r -d '' deadline; } < "$release_path" || exit 1
  [[ $deadline =~ ^[0-9]+$ ]] || exit 1
  deadline=$((deadline * 1000))
  wait_dir=$(/usr/bin/mktemp -d ${stdinTemplate}) || exit 1
  /usr/bin/mkfifo "$wait_dir/gate" || exit 1
  exec 4<>"$wait_dir/gate"
  while [[ ! -e $release ]]; do
    now=\${EPOCHREALTIME/./}
    if (( 10#$now >= deadline )); then
      echo 'fixture: publication gate timed out' >&2
      exit 1
    fi
    IFS= read -r -t 0.025 -N 1 -u 4 _ || :
  done
fi
if [[ $stderr_path != - ]]; then
  /bin/cat -- "$stderr_path" >&2 || exit 1
fi
exit "$status"
`
}

const word = String.raw`'((?:[^']|'\\'')*)'`

/** The client `text` was generated from, when `text` is exactly a generated client; extra or altered lines yield `undefined`. */
export function readSimClient(text: string): SimClient | undefined {
  const mode = /"\$stdin_path" '(sim|fault)' >&3/.exec(text)?.[1] as SimClientMode | undefined
  const port = /\/dev\/tcp\/127\.0\.0\.1\/(\d+);/.exec(text)?.[1]
  const token = /^printf '%s\\0' '([0-9a-f]+)' /m.exec(text)?.[1]
  const dir = new RegExp(`mktemp ${word}`).exec(text)?.[1]?.replace(/\/stdin\.XXXXXXXX$/, '')
  const fallback = new RegExp(`exec (?:bun )?${word} "\\$@"$`, 'm').exec(text)?.[1]
  if (!mode || !port || !token || dir === undefined || fallback === undefined) return undefined
  const client = { mode, port: Number(port), token, dir: unquote(dir), fallback: unquote(fallback) }
  return simClientScript(client) === text ? client : undefined
}
