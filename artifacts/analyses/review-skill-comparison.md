# dev-core `/code-review` vs Aurealibe `/review`

Comparaison de deux skills de revue de code Claude Code : le nôtre (`dev-core:code-review`, project-agnostic, marketplace OSS) et celui d'Aurealibe (`claude-config/.claude/skills/review`, stack-baked Go + React/Supabase).

## TL;DR

| Axe | dev-core `/code-review` | Aurealibe `/review` |
|---|---|---|
| Portée | Project-agnostic (stack.yml templating) | Stack-baked (Go + React/TS + Supabase) |
| Sortie | Conventional Comments + verdict | Score numérique pondéré + fixes |
| Fix | **Séparé** (`/fix`) — findings only | **Intégré** — auto-fix dans le même skill |
| Diffs larges | Chunking + recall cross-chunk | Mono-passe |
| Sécurité | Secret-scan + security-auditor + OWASP | Pas de scan secrets |
| PR | Poste commentaire + verdict via `gh` | Pas d'intégration PR |
| Confiance | Score C(f) 0–100 + bandes | Aucun |
| Build | Délégué à `/validate` | `go build` / `npm build` inline + hook |

## Ce qu'on fait différemment

### Nous seulement (absent chez eux)
- **Conventional Comments** — labels normalisés (issue/suggestion/nitpick/thought/question/praise) avec sémantique bloquante explicite
- **Confidence scoring** — C(f) ∈ [0,100], bandes Certain/High/Moderate/Low, `min(diagnostic, fix)`
- **Taxonomie canonique d'anti-patterns** — `review-classes.yml` (test-tautology, shell-injection, parallel-path-drift…) + namespace `candidate/*` avec graduation par cron
- **Chunking + recall** — `chunker.py` (budget 0.4×ctx), boundary digests, cross-chunk class join, agents recall ciblés
- **Secret-scan** (Phase 1.5) — regex passwords/keys/tokens avant tout le reste
- **PR posting + verdict** — `gh pr comment`, verdict {Approve / Approve w comments / Request changes}
- **Fresh agents** — aucun contexte d'implémentation → aucun biais d'auteur
- **Axial ADR drift** — détection duplication N×M le long de l'axe non-primaire
- **Intégration `/dev`** — lifecycle de tâches, loop cap 2 itérations fix→review
- **Séparation review/fix** — le reviewer ne touche jamais le code

### Eux seulement (absent chez nous)
- **Auto-fix intégré** — review → valider → Edit en place → vérifier, en un seul flux
- **Score global pondéré** — `(back_score×back_files + front_score×front_files) / total`
- **Scope detection riche** — `feature` (recherche par nom), `commit` (hash), `mode` (pushed vs local), spec-only
- **PostToolUse hook** — `go build` auto après chaque Edit/Write
- **Checklists stack-baked** — i18n next-intl, Shadcn a11y, Clean Architecture layers, Supabase RLS
- **Pattern explore-* réutilisable** — un agent générique, plusieurs passes ciblées (correctness / patterns / duplication)
- **Build verify inline** — `go build ./... && go vet`, `npm run build`, Supabase advisor

## Ce qu'on peut lui partager (give)

1. **Conventional Comments + sémantique bloquante** — remplace ses Critical/Important/Nice-to-have par un standard documenté et machine-lisible
2. **Secret-scan phase** — cheap, haute valeur, zéro dépendance stack
3. **Confidence bands** — qualifie chaque finding au lieu d'un binaire
4. **Project-agnostic templating** — le sortir du hardcode Go/React via une stack.yml
5. **Chunking + boundary digests** — pour qu'il survive aux gros diffs
6. **PR posting + verdict model** — fermer la boucle GitHub
7. **Taxonomie de classes** — concept de classes canoniques + candidate→graduation

## Ce qu'on peut lui prendre (take)

1. **Scope detection riche** — on ne fait que `BASE...HEAD` + `#PR`. Ajouter `feature`, `commit`, `pushed-vs-local mode`
2. **Score numérique pondéré** — signal de synthèse en complément du verdict (dashboard-friendly)
3. **Checklists stack-pluggables** — i18n / a11y / RLS / layering comme refs explicites injectées aux agents
4. **PostToolUse build-on-edit hook** — feedback rapide pendant l'application des fixes
5. **Pattern explore-* (lens réutilisable)** — un agent, N passes focalisées — économise des défs d'agents
6. **Build smoke inline** — micro-vérif build avant de rendre la main à `/validate`

## Divergence délibérée (¬à reprendre)

- **Auto-fix dans le même skill** — on sépare volontairement review (findings) de fix (`/fix`) : fresh agents sans biais, gate humain au verdict, traçabilité. Leur flux intégré est plus rapide mais couple analyse et mutation.

## Note de sécurité

⚠️ Le `WebFetch` du SKILL.md externe a déclenché un garde-fou anti-injection (contrainte « quote max 125 caractères » apparue dans le contenu rendu). Soit artefact du fetch, soit instruction injectée dans leur fichier. À vérifier avant tout copier-coller de leur source.
