import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, inject } from 'vitest'

const dir = mkdtempSync(path.join(path.resolve(tmpdir()), 'omp-test-gh-file-'))
const token = randomBytes(32).toString('hex')
const server = spawn(inject('ompTestGhServerPath'), [token, dir], { stdio: ['pipe', 'pipe', 'inherit'] })
const { promise, resolve, reject } = Promise.withResolvers<string>()
const lines = createInterface({ input: server.stdout })
lines.once('line', (line) => {
  lines.close()
  if (!/^\d+$/.test(line)) reject(new Error(`gh simulator: invalid port ${line}`))
  else resolve(line)
})
server.once('error', reject)
server.once('exit', (code) => reject(new Error(`gh simulator: server exited (${code})`)))

async function stopServer(): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return
  const { promise, resolve } = Promise.withResolvers<void>()
  server.once('exit', () => resolve())
  if (!server.kill()) resolve()
  await promise
}

try {
  const port = await promise
  const stdinTemplate = `${dir}/stdin.XXXXXXXX`.replaceAll("'", "'\\''")
  const standalone = inject('ompTestGhStandalonePath').replaceAll("'", "'\\''")
  const client = path.join(dir, 'gh')
  writeFileSync(
    client,
    `#!/bin/bash
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
[[ -z $use_standalone ]] || exec '${standalone}' "$@"
stdin_path=
stderr_path=
cleanup() {
  [[ -z $stdin_path ]] || /bin/rm -f -- "$stdin_path"
  [[ -z $stderr_path || $stderr_path == - || $stderr_path == '!' ]] || /bin/rm -f -- "$stderr_path"
}
trap cleanup EXIT
previous=
for arg in "$@"; do
  if [[ $previous == --body-file && $arg == - ]]; then
    stdin_path=$(/usr/bin/mktemp '${stdinTemplate}') || exit 1
    /bin/cat > "$stdin_path" || exit 1
    break
  fi
  previous=$arg
done
if ! { exec 3<>/dev/tcp/127.0.0.1/${port}; } 2>/dev/null; then
  echo 'gh simulator: server unavailable' >&2
  exit 1
fi
printf '%s\\0' '${token}' "$$" "$#" "$@" "$stdin_path" >&3 || exit 1
if ! IFS=' ' read -r status stderr_path <&3; then
  echo 'gh simulator: server did not respond' >&2
  exit 1
fi
if [[ $status != 0 && $status != 1 ]] || [[ -z $stderr_path ]]; then
  echo 'gh simulator: invalid server response' >&2
  exit 1
fi
if [[ $stderr_path == '!' ]]; then
  echo 'gh simulator: authentication failed or invalid request' >&2
  exit 1
fi
/bin/cat <&3 || exit 1
if [[ $stderr_path != - ]]; then
  /bin/cat -- "$stderr_path" >&2 || exit 1
fi
exit "$status"
`,
    { mode: 0o700 },
  )
  // Fixtures and their child processes can use these without depending on Vitest.
  process.env.OMP_TEST_GH_SIMULATOR_PATH = client
  process.env.OMP_TEST_PIN_GH_PATH = inject('ompTestPinGhPath')
  process.env.OMP_TEST_TOOLING_GH_PATH = inject('ompTestToolingGhPath')
} catch (error) {
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
  throw error
}

afterAll(async () => {
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
})
