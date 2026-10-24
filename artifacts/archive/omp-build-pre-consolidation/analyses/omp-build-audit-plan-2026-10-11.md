---
title: "Audit omp-build : analyse, plan corrigé et décisions"
created: "2026-10-11"
base: "origin/main 2c44cc10 (omp-build 0.9.12, omp 18.9.1)"
status: proposition — rien n'est appliqué
---

# Audit omp-build : analyse, plan corrigé et décisions

Périmètre : le plugin `plugins/omp-build`, en particulier le skill `feature`, plus les issues et les PR ouvertes du dépôt au 2026-10-11.

Méthode :

1. Lecture du README, du GLOSSARY, des SKILL.md, des issues et des PR.
2. Trois analyses en lecture seule, en parallèle : code du skill `feature`, coût en contexte des SKILL.md, opportunités.
3. Une seconde passe de **vérification** de chaque proposition (code relu, reproductions relancées, GitHub interrogé). Seules les conclusions vérifiées sont gardées ici. Les propositions retirées sont listées en § 9.

Légende : ✅ vérifié · ⚠️ vérifié mais nuancé · ❌ retiré.

## 1. Résumé

- `main` est sain : typecheck, lint et tests verts (132 fichiers, 3 941 tests, ~11 s).
- Le blocage n'est pas la qualité du code. C'est la **boucle de revue** : les 7 anciennes PR omp-build ont toutes dépensé leur borne et sont toutes en conflit avec `main`.
- Deux causes vérifiées :
  - **La taille.** Sur les PR qui touchent le gate (`workflow.js`, `epic*.ts`), 7 PR arrêtées sur 10 au-delà de 400 lignes hors tests, contre 1 sur 11 en dessous.
  - **La structure.** Avec la politique stricte de `main`, chaque merge oblige à relire les autres PR, et chaque relecture consomme la borne. De plus, chaque PR monte la version du plugin, donc deux PR omp-build en parallèle sont toujours en conflit.
- #776 (proof admission, #768) est en cours. Elle part de 13 causes racines au premier tour, un niveau qui n'a jamais convergé sous la borne actuelle. C'est déjà le 3ᵉ successeur sur ce sujet.
- Le plan corrigé tient en une règle : **une seule PR omp-build à la fois**, #766 en tête de file, #770 en dernier.

## 2. État au 2026-10-11

### 2.1 Santé de `main`

| Contrôle | Résultat |
|---|---|
| `bun run typecheck` | OK |
| `bun run lint` | OK (0 diagnostic bloquant) |
| `bun run test` | 132 fichiers, 3 941 tests, ~11 s |
| Même chose avec les bumps de #719 (biome 2.5.15, lefthook 2.1.16, vitest 5.0.3) | OK, mêmes chiffres |

### 2.2 PR ouvertes

| PR | Sujet | État |
|---|---|---|
| #776 | proof admission (#768) | en cours : revue 1 *Request changes* (13 causes, 26 findings bloquants), un tour de fix poussé, +5 696/−271 lignes, 32 fichiers |
| #722, #725, #730, #739, #756, #760, #763 | anciennes tentatives | borne dépensée, en conflit ; gardées ouvertes comme preuve (règle de #575 et décision sur #730) |
| #719 | Dependabot, bumps patch | en retard sur `main`, tests verts une fois appliquée sur `main` |

### 2.3 Structure du backlog omp-build

- #575 (racine) → #720 (livraison assistée, P1), #721 (sécurité epic, P2), #732 (efficacité de revue, P3).
- #720 compte 15 enfants actifs prévus, **plus #775 et #777**. Ce sont deux reports non bloquants créés automatiquement par `fix` (sur #774, puis sur #776). Ils contredisent #575 : « Non-blocking follow-ups stay top-level except #741 ».
- Sans bloqueur ouvert aujourd'hui : #766, #762, #736, #614, #615, #625, #626, #635 (et #768 via #776).
- Bloqués : #767 par #762 ; #741 et #696 par #766 ; #770 par tous les autres enfants.
- Hors epic : environ 19 reports P3, la série dev-core #251 et #547 à #553, et des P1 côté dev-core (#571, #555, #561).

## 3. Le plugin et le skill `feature`

### 3.1 Points solides

- `epic.ts` est une fonction pure (faits → prochaine action), et `epic-driver.ts` est la couche qui agit. Le découpage est bon.
- Le test « faux PR + oracle + balayage de pannes » d'`armed-gate.test.js` est un vrai test d'invariant.
- Les reads GitHub sont souvent fail-closed : validation de forme de `readGate`, PR de forks exclues, statut inconnu traité comme arrêt partagé.

### 3.2 Défauts vérifiés

| # | Défaut | Où | Gravité | Destination |
|---|---|---|---|---|
| V1 | `landPr` ne vérifie pas que la PR est OPEN avant d'armer. En merge-on-green avec approbation, il pose le label et renvoie `watching` ; `/ci-watch` conclut ensuite `merged` ou `stopped`. Ce dépôt est en landing natif. | `workflow.js`, après `readGate` | faible | à ranger dans **#696**, qui ajoute au même endroit la lecture de l'état avant armement |
| V2 | `--base` non cité dans la commande `watch` (injection shell ; `main;touch${IFS}pwned` est un nom de branche valide) | `workflow.js:851` | faible | déjà **#766 AC4** |
| V4 | Le parseur YAML écrit à la main casse sur un commentaire en fin de ligne, une liste `[a, b]`, `setup: \|` et un commentaire de section | `worktree-bootstrap.sh:60-94` | moyenne | déjà couvert par **#625** (un seul lecteur `Bun.YAML`) |
| V5 | `applyCiWatchExit` n'accepte que `{ gh }`, mais SKILL.md et `workflow.d.ts` annoncent `{ mode }` | `workflow.js:986`, `SKILL.md:536`, `workflow.d.ts:53` | triviale | à ranger dans **#766** (même fonction) |
| S1 | Le bootstrap s'exécute automatiquement dans tout worktree lié. Il lit le `.dev/stack.yml` **de la branche** et lance `bash -c "$setup"`. Le README annonce `pr_checkout` parmi les cas couverts. | `omp/index.ts:185-199`, `worktree-bootstrap.sh:55,209` | dépend du périmètre | voir décision D3 |

S1 et le périmètre : #575 limite le produit aux « authorized repositories » et dit « Do not promise a hostile-checkout sandbox ». Le risque n'existe que si une session s'ouvre dans le checkout d'une PR externe.

### 3.3 Complexité et tests

| Mesure | Valeur |
|---|---|
| `workflow.js` | 1 515 lignes ; `landPr` = 300 lignes (22 sorties) |
| `epic.ts` / `epic-driver.ts` | 886 / 886 lignes ; `nextStep` = 199 lignes |
| Code de production du skill `feature` | ~4 975 lignes |
| Tests du skill `feature` et de `omp/` | ~12 370 lignes (2,5 fois le code) |
| `armed-gate.test.js` | 3 285 lignes, 936 tests, 0,13 s |

Constats :
- Une seule règle (« une PR n'est armée que si le dernier verdict approuve le head courant ») est réparée à chaque sortie de `landPr`. D'où 5 séries de correctifs en 3 jours (#710, #729, #731, #744, #746).
- Le contrat d'erreur repose sur deux fragments de phrase (`stays armed — …`, `could not be read back`). Un champ structuré (`remaining[]`, `unconfirmed`) les remplacerait.
- La même donnée existe en plusieurs copies :
  - variables git à purger : 3 copies, dont une incomplète ;
  - lecteurs de `.dev/stack.yml` : 5 ;
  - faux `gh` dans les tests : 3 ;
  - classes d'arrêt : code, SKILL.md, README, GLOSSARY.
- Dans `armed-gate.test.js`, environ 700 lignes portent la garantie (faux PR, oracle, balayage). Le reste peut être condensé. Le coût est la lecture, pas la CI.

### 3.4 SKILL.md et coût en contexte

| Fichier | Taille | ≈ tokens | Chargé |
|---|---|---|---|
| `feature/SKILL.md` | 40,6 Ko, 583 lignes | 10 150 | en entier à chaque `/feature` |
| `dev-review/SKILL.md` | 57,1 Ko, 646 lignes | 14 280 | à chaque revue |
| `fix/SKILL.md` | 39,4 Ko, 440 lignes | 9 850 | **préchargé** par `feature/SKILL.md:55`, même si la revue est verte |

- Un cycle `/feature` → revue → fix → land charge environ 40 000 tokens de skills (pire cas ~75 000).
- Précharger `fix` coûte 9 850 tokens inutiles quand la première revue approuve. Cela arrive pour 10 PR sur 31 : le gain moyen est donc d'environ 3 300 tokens par cycle.
- Environ 41 % de `feature/SKILL.md` ne sert pas au build d'un ticket seul (init, cadrage, epic goal). Environ 41 % redécrit du comportement déjà dans le code.
- Ambiguïtés relevées :
  - Création du worktree : impérative en `SKILL.md:17` et `:98`, « proposal » en `:111`.
  - La ligne `/goal` est proposée pour toute issue (`:108`) ; #766 AC8 la corrige.
  - « armed » a deux sens : PR armée, et paquet armé par `extensions:`. GLOSSARY ne définit pas « PR armée ».
  - « RC-n » désigne à la fois une cause de revue et une classe historique (`review-classes.yml`).
- 15 fichiers de tests lisent des SKILL.md par leur texte ou leurs titres. Tout déplacement de section doit les repointer.

Attention au périmètre : #575 dit « Attention, cost, and delay are not acceptance metrics », et les non-objectifs de #720 incluent « No token or cost promise ». La réduction du contexte est donc **hors #720** (décision D4).

### 3.5 La boucle de revue en chiffres

Causes racines par tour de revue :

| PR | Lignes (total) | Tour 1 → 2 → 3 | Issue |
|---|---|---|---|
| #722 | 2 111 | 12 → 13 → 7 | arrêtée |
| #756 | 1 834 | 7 → 15 → 6 | arrêtée |
| #760 | 2 484 | 7 → 9 → 6 | arrêtée |
| #763 | 1 505 | 6 → 5 → 5 | arrêtée |
| #725 | 67 | 2 → 1 → 1 | arrêtée (une cause différente à chaque tour) |
| #730 | 2 255 | 5 → 1 → 1 | arrêtée (idem) |
| #739 | 1 356 | 2 → 1 → 1 | arrêtée (idem) |
| #745 | 3 325 | 7 → 4 | mergée |
| #776 | 5 967 | 13 → … | en cours |

- Sous la borne actuelle, aucune PR partie de plus de 7 causes au premier tour n'a été mergée.
- Taille hors tests contre arrêt :

  | PR | ≥ 400 lignes | < 400 lignes |
  |---|---|---|
  | qui touchent le gate | 7 arrêtées sur 10 | 1 sur 11 |
  | autres | 0 sur 1 | 1 sur 9 |

  C'est une corrélation, pas une preuve de cause. #725 (67 lignes) montre que la taille n'explique pas tout.
- Classes de défauts les plus fréquentes (sur 31 PR revues depuis le 1ᵉʳ oct.) : `vacuous-guard` 20, `test-tautology` 16, `parallel-path-drift` 12.
- Depuis le 9 octobre, aucune PR n'a atteint la borne (#771, #773, #774), mais l'échantillon est minuscule.
- Coût calculé par OMP (`~/.omp/stats.db`, lu en lecture seule ; ce n'est pas une facture) : worktree de #768 **144 $**, worktree de #737 **42 $**.

### 3.6 Causes structurelles des conflits

| Cause | Preuve |
|---|---|
| Une PR doit être à jour avec `main` | ruleset `PR_Main` : `strict_required_status_checks_policy: true`, check requis `ci` |
| Un nouveau head exige une nouvelle revue | `auto-merge.yml` : « reviewed PRs are not retargeted — a new head needs a new review » |
| Toute revue postée compte dans la borne | `README.md:190`, `feature/SKILL.md:415` : « Every posted review counts » |
| Deux PR omp-build en parallèle sont toujours en conflit | les 7 anciennes PR sont en conflit sur `package.json` et `.omp-plugin/marketplace.json` (montée de version imposée par `check-skill-version.sh`) |
| Les issues touchent les mêmes fonctions | #766, #762 et #767 modifient `epic-driver.ts` (`report` pour les trois, `stop` pour #766 et #767) et la table « Epic goal » de `feature/SKILL.md` |

Conséquence : jusqu'à la livraison de #766, avancer plusieurs PR omp-build en parallèle consomme la borne de revue. Après #766, seules les *Request changes* comptent : une relecture après rebase qui approuve ne coûte plus rien.

Fichiers prévus par les issues de l'epic (relevés dans leur corps) :

| Issue | workflow.js | epic.ts | epic-driver.ts | feature/SKILL | dev-review/SKILL | fix/SKILL | feature-init.ts | bootstrap.sh |
|---|---|---|---|---|---|---|---|---|
| #768 / #776 | X | X | | X | X | X | X | |
| #766 | X | X | X | X | X | X | | |
| #762 | | | X | X | | X | | |
| #767 | | | X | X | | X | | |
| #736 | | | | | X | X | | |
| #741 | X | | | | | | | |
| #696 | X | | | X | | | | |
| #615 | | | | X | | | X | X |
| #625 | X | | | X | | | X | X |
| #635 | | | | | | | X | |
| #614, #626 | (plugin issue-triage, version séparée) | | | | | | | |

## 4. Plan corrigé

Règle : **une seule PR omp-build à la fois** (revue, fix, merge), puis la suivante part de `main` à jour.

**Étape 0 — maintenant, sans risque**
1. `git pull --ff-only` sur la copie locale (4 commits de retard, aucun conflit avec le fichier non suivi `artifacts/plans/768-…-todo.md`).
2. Détacher #775 et #777 de #720. D'autres suivront à chaque tour de fix tant que #767 n'est pas livré.
3. Merger #719 au bon moment :
   - soit juste avant la prochaine revue de #776, en mettant à jour sa base au même push ;
   - soit après le merge de #776.

   Un merge entre l'approbation de #776 et son landing lui coûterait une revue.

**Étape 1 — #776 (#768), en cours**
- Finir la boucle de revue.
- Décider **dès maintenant** ce qui se passe si la borne est atteinte (décision D1).
- Une fois #776 mergée, toutes les autres PR partent de cette base.

**Étape 2 — petites PR d'issue-triage**
- #614 (identité du dépôt : `origin` avant `upstream`), puis #626 (type d'issue vérifié avant toute écriture).
- Elles passent avant #762 et #767, qui touchent aussi des fichiers d'issue-triage (`SKILL.md`, `lib/create.ts`).

**Étape 3 — file omp-build, dans cet ordre**
1. **#766** : correction « rouge seulement », suppression de la réparation CI automatique, historique complet des arrêts. Inclure V2 (déjà AC4) et V5. Si découpage (décision D2) : d'abord le lecteur d'historique complet et la publication sans perte (AC5-7), puis la politique (AC1-4, 8-10).
   - Pourquoi en tête : #766 débloque 9 issues (#741, #696, #643, #663, #712, #740, #764, #765, #769).
   - Une fois #766 livré, les approbations ne consomment plus la borne.
2. **#762**, puis **#767** : startup Bun isolé, arrêts sûrs de `fix`, reports non bloquants hors de l'epic. Cela arrête la création d'enfants comme #775 et #777.
3. **#741**, puis **#696** : lecture fiable des protections natives ; refus d'armer une PR `BEHIND`. Ajouter V1 à #696.
4. **#736** : bloquer seulement sur un impact démontré.
5. **#615**, **#625**, **#635** : bootstrap et `feature-init`. Trancher S1 (décision D3) avant #615.

**Étape 4 — #770**
- Preuve installée sur deux sandboxes, version publiée.

**Étape 5 — après #770**
- Réduction du contexte des SKILL.md, en issue séparée (sauf décision D4 contraire) :
  - ne plus précharger `fix` ;
  - découper `feature/SKILL.md` en cœur de ~9 Ko plus `references/` ;
  - supprimer les tables « Edge Cases » ;
  - gain estimé ~49 % des tokens de skills par cycle (estimation sur des fichiers non écrits).
- Plafond de lignes des SKILL.md dans `tools/validate_plugins.py`. Le mécanisme `SKILL_LINE_BUDGETS` existe déjà.
- Refonte de `landPr` en étapes avec un résultat unique, et désarmement structuré (`remaining[]`). Le balayage d'`armed-gate` protège cette refonte. Si #741 ou #696 atteint la borne, avancer cette refonte avant #770.
- Condensation des tests (`armed-gate.test.js`, fusion de `land.test.js`).
- Tri des reports P3 : #740, #764 et #765 sont des suites prévues après #766, pas des issues caduques ; #765 recoupe en partie #766 AC8.
- #721, puis #732.

## 5. Décisions à prendre

| # | Question | Options | Ma recommandation |
|---|---|---|---|
| D1 | Si #776 atteint la borne de revue | (a) arbitrage de l'opérateur sur les causes restantes ; (b) 4ᵉ issue successeur | (a) : c'est le 3ᵉ successeur sur ce sujet, et aucune PR de ce niveau n'a convergé |
| D2 | Découper #766 en deux PR ? | (a) une seule PR, comme l'issue le prévoit ; (b) lecteur d'historique d'abord, politique ensuite | (b), mais c'est un changement de contrat de l'issue |
| D3 | Les checkouts de PR externes sont-ils dans le périmètre de sécurité ? | (a) non : documenter le risque dans le README ; (b) oui : n'amorcer automatiquement que les worktrees créés par `/feature`, ou lire `worktree.setup` sur `origin/<base>` | à toi ; à trancher avant #615 |
| D4 | La réduction du contexte entre-t-elle dans #720 ? | (a) non, issue séparée après #770 ; (b) oui, avant #770 | (a) : c'est cohérent avec #575 et les non-objectifs de #720 |
| D5 | Les anciennes PR arrêtées | (a) garder la règle actuelle (ouvertes, intactes) ; (b) amender #575 pour les fermer avec un lien vers le successeur | (a), sauf si le bruit te gêne |
| D6 | Détacher #775 et #777 de #720 | oui / non | oui |
| D7 | Moment du merge de #719 | avant la prochaine revue de #776 / après son merge | l'un ou l'autre, jamais entre son approbation et son landing |

## 6. Idées à ajouter

| Idée | Effort | Verdict | Où |
|---|---|---|---|
| Script de stats de revue (borne, causes par tour, taille, PR dormantes), sans registre | S | à faire tout de suite | `scripts/`, pas de bump de version (voir annexe A) |
| Repère de taille au cadrage (~400 lignes hors tests → découper) | S | à faire, en simple repère | `docs/agents/issue-tracker.md`, pas `feature/SKILL.md` (fichier central) |
| Règle `rules/test-oracles.md` (classes `vacuous-guard`, `test-tautology`) | S | plus tard, à mesurer avec le script | `plugins/omp-build/rules/` ; OMP charge `rules/*.{md,mdc}` depuis les plugins |
| Plafond de lignes des SKILL.md | S | après #770 | `tools/validate_plugins.py` |
| Alerte si `modelRoles.review` n'est pas mappé | S | plus tard | `omp/index.ts` via `ctx.models.resolve` ; toi, tu l'as déjà mappé, et #770 observe les rôles |
| Findings typés (`output:` des agents) | M-L | plus tard | `agents/R-*.md` |
| Port de `recheck` de dev-core | M | plus tard | `epic-driver.ts` ou §6.0 |
| Nouvel ADR pour la borne de revue | — | non | déjà ADR-020 (« fix ≤2 ») ; #766 AC8 impose sa mise à jour |
| CODEOWNERS | — | non | l'auteur est l'opérateur |

## 7. Hors omp-build

| Issue | Constat | Suggestion |
|---|---|---|
| #649 | `upstream-watch` n'a jamais ouvert d'issue : le label `upstream-update` n'existe pas, `\|\| echo` masque l'échec (ligne 119), les runs sont verts | correctif trivial, quand tu veux |
| #571, #555, #561 (P1, dev-core) | exécution de code de PR par la vérification ; contrôle `file_length` inerte sur node/bun | côté Claude Code ; après #770 |
| #632 (P1) | l'issue dit « Conditional on the staging-train model. Not a trunk bug » | utile seulement pour les clients en staging-train |
| #648 | le graphe de dépendances GitHub est vide pour ce dépôt | après #770 |
| #251, #547 à #553 | série « hooks générés » (P3) | en pause |

## 8. Hypothèses et limites

- Les numéros de ligne valent pour `origin/main` à `2c44cc10`.
- Le lien entre taille et arrêt est une corrélation, pas une preuve de cause.
- Les tokens sont estimés à octets / 4, contrôlé à ±3 % avec `cl100k_base`.
- Le gain de 49 % porte sur des fichiers non écrits.
- Les coûts viennent du calcul d'OMP, pas d'une facture.
- La recherche web était indisponible : les conventions externes reposent sur la doc OMP locale et sur agentskills.io.
- Rien n'est appliqué dans le dépôt. Effets de bord de l'analyse :
  - `git fetch` de heads de PR (objets et `FETCH_HEAD`, aucune branche créée) ;
  - worktree en lecture seule `/tmp/ob-main` (à retirer avec `git worktree remove /tmp/ob-main`) ;
  - `omp stats --json` a synchronisé `~/.omp/stats.db`.

## 9. Propositions retirées après vérification

| Proposition initiale | Pourquoi elle est retirée ou corrigée |
|---|---|
| Défaut V3 : `classifyBaseCi` ignore les checks requis | comportement documenté (`epic.ts:395-401`) ; le correctif proposé bloquerait les dépôts dont les checks ne tournent que sur les PR (ici `Validate PR Title`) |
| Deux voies (A et B) en parallèle | mêmes fichiers et mêmes fonctions, plus les causes structurelles du § 3.6 |
| « Voie C » entièrement parallèle | seules #614 et #626 sont indépendantes |
| Découper #766 avec la politique d'abord | ordre inversé : lecteur d'historique d'abord, sinon les anciens arrêts peuvent disparaître au recomptage |
| Mettre V1 dans #741 | #696 est le bon endroit |
| Fermer les anciennes PR | contraire à #575 et à la décision écrite sur #730 |
| Alléger les SKILL.md avant #770 | hors périmètre de #720 selon #575 |
| Nouvel ADR pour la borne | ADR-020 la porte déjà ; #766 AC8 la met à jour |
| #740, #764 et #765 deviendraient caduques | ce sont des suites prévues après #766 |
| #776 « propre, pas encore relue » ; coûts 68 $ / 13 $ | faits dépassés au moment de la vérification |

## Annexe A — script de stats de revue

Testé en lecture seule (avec un chemin absolu vers `workflow.js`). Il doit être lancé depuis le dépôt, car `gh` a besoin du contexte du dépôt. Proposition d'emplacement : `scripts/omp-build-review-stats.mjs`, lancé par `bun scripts/omp-build-review-stats.mjs 2026-10-05`.

```js
#!/usr/bin/env bun
// Read-only. Reuses the gate's own parser, so the numbers are the ones landPr/nextReviewStep decide on.
import { execFileSync } from 'node:child_process'
import { reviewRecords } from '../plugins/omp-build/skills/feature/workflow.js'
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 28 })
const me = gh('api', 'user', '--jq', '.login').trim()
const since = process.argv[2] ?? '2026-10-05'
const prs = JSON.parse(gh('pr', 'list', '--state', 'all', '--limit', '200', '--search', `created:>=${since}`,
  '--json', 'number,state,additions,deletions,createdAt,mergedAt'))
const rows = []
for (const pr of prs) {
  const pages = JSON.parse(gh('api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${pr.number}/comments`)).flat()
  const comments = pages.map((c) => ({ body: c.body, author: c.user ? { login: c.user.login } : null }))
  const r = reviewRecords(comments, { me })
  if (r.reviews === 0) continue
  rows.push({ pr: pr.number, state: pr.state, lines: pr.additions + pr.deletions, records: r.reviews,
    latest: r.verdict, spent: r.spent,
    hours: pr.mergedAt ? ((Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / 36e5).toFixed(1) : '' })
}
console.table(rows)
const stalled = rows.filter((r) => r.state === 'OPEN' && r.spent)
console.log(`reviewed=${rows.length} spent=${rows.filter((r) => r.spent).length} open+spent=${stalled.length}`)
```

Sortie au 2026-10-11 (depuis le 2026-10-05) : `reviewed=21 spent=8 open+spent=7`.

## Annexe B — reproduire les défauts

| Défaut | Comment le voir |
|---|---|
| V1 | appeler `landPr` avec un faux `gh` qui renvoie `state: 'MERGED'` ou `'CLOSED'`, une approbation au head courant et `landing: { mode: 'merge-on-green' }` → `watching` et `pr edit --add-label reviewed` |
| V2 | même faux `gh` avec `baseRefName: 'main;touch${IFS}pwned'` → la commande `watch` contient la base non citée |
| V4 | passer au parseur Python de `worktree-bootstrap.sh` un `stack.yml` avec `setup: "bun install" # deps`, `copy: [.env]`, `setup: \|` ou `worktree:   # note` |
| V5 | lire la signature de `applyCiWatchExit` (`workflow.js:986`) et l'appel prescrit en `feature/SKILL.md:536` |
