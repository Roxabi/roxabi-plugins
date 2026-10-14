<!-- compress: level=L1 src-sha=aae43ce07df4f2b5b9700a382ffe9ac11af7b89a glossary=none -->

# Team Code Style

Conventions the fictional Harbor team applies to every service in the monorepo — so reviews argue about behavior, not formatting.

## Naming

<!-- INV-rule-1 -->
Functions are named with verbs, modules with nouns — a function `parser` or a module `validate` fails review.
<!-- INV-cond-2 -->
Abbreviations are allowed only when they appear in the domain glossary; anything else is written out in full.

## Functions

<!-- INV-thresh-3 -->
A function fits on one screen: at most forty lines — past the limit, extract branches into helpers before adding new ones.
<!-- INV-rule-4 -->
Every public function carries a docstring stating what it returns and which errors it raises.

## Errors

<!-- INV-rule-5 -->
Errors are never swallowed: a caught exception is handled meaningfully, re-raised with added context, or logged at warning or higher.
<!-- INV-prohib-6 -->
Bare except clauses fail review, with no exceptions to the rule.

## Comments

<!-- INV-rule-7 -->
Comments explain why, not what — a comment paraphrasing the line below it is deleted during review; commented-out code is never merged.

## Reviews

<!-- INV-rule-8 -->
Every change needs one approving review from outside the author's immediate team, within one working day — a "looks good" without evidence of reading the diff does not count.
