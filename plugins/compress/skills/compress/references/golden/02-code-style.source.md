# Team Code Style

This guide collects the conventions the fictional Harbor team applies to every service in the monorepo. It exists so that reviews argue about behavior, not about formatting.

## Naming

Functions are named with verbs and modules are named with nouns. A function called `parser` or a module called `validate` both fail review. Abbreviations are allowed only when they appear in the domain glossary; anything else is written out in full.

## Functions

A function should fit on one screen, which the team defines as at most forty lines. When a function grows past that limit, extract the branches into helpers before adding new ones. Every public function carries a docstring that states what it returns and which errors it raises.

## Errors

Errors are never swallowed. A caught exception is either handled meaningfully, re-raised with added context, or logged with a level of warning or higher. Bare except clauses fail review with no exceptions to the rule.

## Comments

Comments explain why, not what. A comment that paraphrases the line below it is deleted during review. Commented-out code is never merged; version control already remembers it.

## Reviews

Every change needs one approving review from outside the author's immediate team. Review turnaround is expected within one working day, and a review that only says "looks good" without evidence of reading the diff does not count toward the requirement.
