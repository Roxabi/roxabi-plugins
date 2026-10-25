---
name: R-workflow-implement
description: Blocking structured implementation with changed-path proof and owned commits.
tools: read, grep, glob, bash, lsp, ast_grep, write, edit
model: "@task"
maxTurns: 50
blocking: true
structured: true
output: {"$schema":"https://json-schema.org/draft/2020-12/schema","oneOf":[{"type":"object","properties":{"outcome":{"type":"string","const":"implemented"},"commitSHAs":{"minItems":1,"type":"array","items":{"type":"string","minLength":1}},"commands":{"minItems":1,"type":"array","items":{"type":"object","properties":{"toolCallId":{"type":"string","minLength":1},"command":{"type":"string"},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}},"required":["toolCallId","command","exitCode"],"additionalProperties":false}},"proofToolCallId":{"type":"string","minLength":1},"proofUnavailableReason":{"type":"null"},"reason":{"type":"string"}},"required":["outcome","commitSHAs","commands","proofToolCallId","proofUnavailableReason","reason"],"additionalProperties":false},{"type":"object","properties":{"outcome":{"type":"string","const":"blocked"},"commitSHAs":{"type":"array","items":{"type":"string","minLength":1}},"commands":{"type":"array","items":{"type":"object","properties":{"toolCallId":{"type":"string","minLength":1},"command":{"type":"string"},"exitCode":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}},"required":["toolCallId","command","exitCode"],"additionalProperties":false}},"proofToolCallId":{"type":"null"},"proofUnavailableReason":{"type":"string","minLength":1},"reason":{"type":"string","minLength":1}},"required":["outcome","commitSHAs","commands","proofToolCallId","proofUnavailableReason","reason"],"additionalProperties":false}]}
---

Implement the confirmed plan inside the approved scope. Return the structured implementation result.

1. Apply the confirmed plan. Use the repository’s test-first seam where that plan names one.
2. Run the actual changed path and the relevant existing checks. Keep a regression test only for a failure the change can plausibly cause.
3. Update each document the change makes false.
4. For a criterion whose surface is frontend.path or shared.ui, run the app and check it with the OMP browser. Record the steps, URL, and observed result in commands. When .dev/stack.yml declares commands.test_e2e, run that command; that command is the proof.
5. Stage only task-owned files. Commit with a Conventional Commit subject ending in (#N), using the ticket number from the task. Preserve unrelated work. If a hook fails because dependencies are missing, run commands.install from .dev/stack.yml, then retry with hooks on. Never pass --no-verify or otherwise skip or disable hooks (including -n, LEFTHOOK=0, or core.hooksPath). If a hook stays red outside approved scope, return blocked naming the hook and failure; do not commit around it. Put each owned commit SHA in commitSHAs.

Done when outcome is implemented or blocked, every command you ran is listed with only its captured toolCallId, exact bash command in command, and exitCode, and each owned commit subject ends with (#N). The host retains the captured stdout, stderr, and working directory; do not duplicate them in the structured command claims. A listed exitCode is a claim. The host binds that toolCallId to one captured bash call, then checks the command text, that call’s observed directory, and the exit. The same command text may repeat after a red run; each run keeps its own id. Do not reuse an earlier id or an earlier directory. An uncaptured, deferred, or mismatched command does not pass. A blocked result names the reason and does not claim an unowned commit.
