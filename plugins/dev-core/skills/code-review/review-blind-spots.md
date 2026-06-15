---
title: Review Blind Spots
description: Systematic Python/infra failure modes for code-review agents to audit against.
---

Patterns that static analysis and structural review commonly miss — check each one explicitly against the diff.

| Blind spot | Why it bites | What to check |
|---|---|---|
| `bare except:` / `except Exception` without re-raise | Swallows real errors silently; program continues in unknown state | Any `except` block that contains only `pass`, `continue`, or a log statement with no `raise` |
| `subprocess.run(...)` without `check=True` | Non-zero exit code is ignored; caller assumes success | Every `subprocess.run` / `subprocess.call` / `subprocess.Popen` — confirm `check=True` or explicit returncode inspection |
| f-string or string-built shell / SQL command | Injection vector if any component is user-derived | Any `f"... {var} ..."` fed to `subprocess`, `os.system`, or a DB cursor; require parameterized queries and `shlex.quote` |
| Missing DB transaction boundary | Partial writes on error leave DB in inconsistent state | Multi-step DB operations not wrapped in an explicit transaction or `with session.begin()` block |
| Missing `RETURNING` / rowcount check after write | Code assumes the write succeeded; silent no-op on constraint violation or wrong WHERE | `INSERT`/`UPDATE`/`DELETE` without inspecting `cursor.rowcount` or a `RETURNING` clause |
| Hard-coded credentials or secrets in source | Secrets in VCS history; rotate once, still exposed everywhere cloned | Strings matching patterns like `sk-`, `ghp_`, `Bearer `, passwords in config literals, or `os.environ.get('KEY', 'default-secret')` |
| `os.path.join` / string munging for paths instead of `pathlib` | Platform separator bugs; no traversal protection | File path construction using `+` or `os.path.join` with user-controlled segments; require `pathlib.Path` + `.resolve()` |
| `print` in library or non-CLI code instead of a logger | No log level, no structured output, no suppression in tests | Any `print(...)` outside a CLI entry point; should be `logging.getLogger(__name__).info(...)` |
| Unbounded loop or network call without timeout | Hangs indefinitely on adversarial input or network hiccup | Loops with no iteration cap; `requests.get` / `httpx` / `socket` calls without explicit `timeout=`; `asyncio.wait_for` missing |
| Mutable default argument (`def f(x=[])`) | Default object is shared across all calls; state leaks between invocations | Function signatures with `list`, `dict`, or any mutable as a default; require `None` + sentinel pattern |
| Broad `# type: ignore` or `# noqa` hiding real defects | Silences the tool rather than fixing the underlying issue | Any suppression comment — confirm the suppression is intentional and narrowly scoped (e.g. `# type: ignore[assignment]`, not bare `# type: ignore`) |
| Missing `await` on a coroutine | Call returns a coroutine object; the actual work never runs; no error raised | Any async function call not preceded by `await`; check that `asyncio.gather` / `asyncio.ensure_future` are used correctly |
| `\|\| true` in shell masking failures | Forces exit 0 regardless of what the command did | Any `cmd \|\| true` or `cmd \|\| :` — confirm the failure genuinely doesn't matter or add a comment explaining why |
| Unvalidated external input reaching a sensitive sink | Arbitrary code/data execution from request params, env vars, uploaded files | Trace every external input (HTTP body, query params, `os.environ`, file uploads) to filesystem/exec/DB/network sinks without prior validation or type coercion |
| Path traversal from user-controlled paths | User can escape intended directory via `../../` sequences | Any `open()`, `Path(...)`, or file operation where a path component derives from user input; require `Path(root, user_input).resolve().is_relative_to(root)` |
| Non-atomic file write (no temp-file + `os.replace`) | Crash mid-write leaves a torn or zero-byte file | Any `open(path, 'w')` for a file that must survive crashes; require write-to-temp + `os.replace(tmp, path)` |
| Missing `set -euo pipefail` in bash scripts | Script continues after command failures; unset variables silently expand to empty string; piped failures go undetected | First executable line of every bash script — confirm `set -euo pipefail` is present |
| Unquoted shell variable expansions (`$x` vs `"$x"`) | Word-splitting and globbing on values containing spaces or `*` | Any `$VAR` in shell outside double quotes; filenames and paths must always be `"$VAR"` |
| Race condition on shared mutable state without a lock | Concurrent access corrupts state; failure is non-deterministic and hard to reproduce | Any module-level or instance-level mutable object (list, dict, counter) written from multiple threads/coroutines without a lock or `asyncio.Lock` |
| Silent integer truncation / overflow in bitwise or division ops | Python `int` is arbitrary precision but interop with C extensions, struct packing, or numpy dtypes silently truncates | Any `struct.pack`, `numpy` dtype cast, or C-extension call receiving a Python `int` — confirm bounds are validated before the call |
