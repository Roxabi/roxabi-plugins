---
title: Review Smells
description: Fowler ch.3 judgement-call baseline for the /R-dev-review Standards axis. One reader — the orchestrator. Never Lane A.
---

# Review smells

Fowler, *Refactoring* ch.3. **Judgement calls**, never merge blockers.

**Single consumer:** the `/R-dev-review` orchestrator, once, after F is merged. Output lands in `## Standards` only. ¬paste this file into Lane A, ¬`R-recall`, ¬`R-finding-verifier`, ¬any `agents[]` prompt.

## Binding rules

- **Repo overrides.** A documented repo standard (`CONTRIBUTING.md`, `CODING_STANDARDS.md`, `docs/**/adr/**`, `.dev/stack.yml`) always wins. Where it endorses what a smell would flag, suppress the smell.
- **Always a judgement call.** Prefix every row `possible <Smell>`. Never a hard violation.
- **Skip tooling.** If a linter, formatter, or jscpd-class clone detector already covers the shape, skip.
- **Never enter F.** No `Class:`, no `Confidence:`, and **no Conventional Comment label** — the forbidden set is a shape, ¬a list, and lives in one place: `dev-review/SKILL.md` Phase 6 § `/R-fix` partition. Do ¬re-enumerate it here; a second copy drifts and the copy read at generation time wins. `/R-fix` parses the whole PR comment; a live label in a smell row becomes a fix task.
- **Cap.** ≤1 row per smell. None fire → `smells: RAS`. Do not invent.

## Baseline

| Smell | What it is | How to fix | In Δ look for |
|---|---|---|---|
| Mysterious Name | A function, variable, or type whose name does not reveal what it does or holds | Rename; if no honest name comes, the design is murky | Identifiers that are 1–2 letters, or `data`/`info`/`util`/`helper`/`tmp` standing in for a real concept |
| Duplicated Code | The same logic shape appears in more than one hunk or file in the change | Extract the shared shape, call it from both | Near-identical blocks across two files in Δ, or copy-paste with a renamed variable |
| Feature Envy | A method that reaches into another object's data more than its own | Move the method onto the data it envies | `other.foo` / `other.bar` / `other.baz` dominating a function whose `this`/`self` is barely used |
| Data Clumps | The same few fields or params keep travelling together (a type wanting to be born) | Bundle them into one type, pass that | The same 3+ parameters repeating across new signatures in Δ |
| Primitive Obsession | A primitive or string standing in for a domain concept that deserves its own type | Give the concept its own small type | `string` used as money, id, email, path, or status; magic numbers as modes |
| Repeated Switches | The same `switch` / `if`-cascade on the same type recurs across the change | Replace with polymorphism, or one map both sites share | Two new `switch (kind)` / `if kind ==` cascades on the same discriminator |
| Shotgun Surgery | One logical change forces scattered edits across many files in the diff | Gather what changes together into one module | A single concern (auth, logging, a flag) touched in ≥4 unrelated files in Δ |
| Divergent Change | One file or module is edited for several unrelated reasons | Split so each module changes for one reason | One file in Δ mixing feature logic, infra wiring, and test fixtures in the same hunk set |
| Speculative Generality | Abstraction, parameters, or hooks added for needs the spec does not have | Delete it; inline back until a real need shows | New `*Options`, `*Plugin`, `*Base` with one implementer and no spec criterion |
| Message Chains | Long `a.b().c().d()` navigation the caller should not depend on | Hide the walk behind one method on the first object | New call chains of depth ≥4 that reach through foreign objects |
| Middle Man | A class or function that mostly just delegates onward | Cut it, call the real target direct | New wrapper whose body is one return of another call, no added policy |
| Refused Bequest | A subclass or implementer that ignores or overrides most of what it inherits | Drop the inheritance, use composition | New subclass that `raise`/`NotImplemented` / no-ops a majority of the parent API |
