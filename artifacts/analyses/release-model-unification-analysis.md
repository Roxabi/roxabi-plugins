<!-- Provenance: multi-agent workflow (26 agents, ~2.3M tokens), 2026-07-16.
     Method: 13-repo read-only drift survey (parallel) + 3 mechanism deep-reads
     -> 3 independent competing designs -> 3-lens judge panel -> adversarial refutation
     -> synthesis. Generated with Claude Code.

     KNOWN METHOD DEFECT — read section 7.4 before trusting the verify stage:
     the orchestrator's winner-selection had a bug (fell back to designs[0]), so 2 of
     the 3 adversarial refuters attacked Design 1 (release-please keeps the tag) while
     believing they were attacking the winner (Design 2, delete release-please).
     The winner was therefore NOT cleanly adversarially tested. Mitigation, not excuse:
     both misfired refuters independently concluded "delete RP fleet-wide + add /promote
     step 2b", i.e. they corroborate the retained remedy. The 3rd refuter's SECONDARY
     attack does land on the winner and is recorded, unresolved, in section 5.3.

     Confidence: ~85% on the 11 single-component staging->main repos; ~30% on
     roxabi-factory and roxabi-cortex (explicitly out of thesis — do not migrate them
     on the strength of this document). Survey covers 13 of ~28 repos in the index. -->

# Décision — unification du modèle de release Roxabi

**Date** : 2026-07-16 · **Portée** : 13 repos audités sur ~28 de l'index · **Statut** : décidé pour 11 repos, **non tranché pour 2** (`roxabi-factory`, `roxabi-cortex`)

---

## 1. Constat

### 1.1 Périmètre — survey PARTIELLE, à dire explicitement

**FACT** : 13 repos audités en lecture seule (git + `gh`, aucune modification).
**Non audités mais concernés** : `imageCLI` (a un trigger `on: push: tags: ['imagecli/v*']` et pin 4 packages factory — signalé par un designer, jamais vérifié).
**Hors périmètre / non regardés** : `roxabi-site`, `factory-site`, `bouly-site`, `enishu`, `roxabi-boilerplate`, `roxabi-simulation`, `roxabi-xcli`, `roxabi-ui`, `roxabi-bchain`, `roxabi-postiz`, `roxabi-hermes`, `roxabi-container`, `roxabi-compta`. **Ce document ne dit rien sur eux.**

### 1.2 Table de drift (FACT — vérifié par commandes)

| repo | mécanisme réel | manifest | latest tag (groupé par préfixe) | drifted |
|---|---|---|---|---|
| **roxabi-factory** | promote-manual (RP **mort**) | main: lyra 0.2.0 · nats 0.2.1 · contracts 0.2.0 | `lyra-v0.2.0` (tiret!) · `roxabi-nats/v0.4.2` · `roxabi-contracts/v0.13.0` | **OUI — 2/3 composants** (contracts : 11 minors de retard) |
| **voiceCLI** | promote-manual (RP **mort**) | 0.2.1 (pyproject staging 0.2.2) | `voicecli/v0.3.0` | **OUI** — 3-way mismatch |
| **roxabi-idna** | aucun (RP dormant) | 0.1.0 | **aucun tag** | **OUI (inverse)** — manifest+CHANGELOG annoncent une release jamais taguée |
| **roxabi-plugins** | release-please | main 0.4.0 · staging 0.3.0 | `roxabi-plugins/v0.4.0` | **OUI (branch-local, bénin)** |
| **llmCLI** | les deux (RP a cuté 0 tag) | 0.1.0 · pyproject 0.1.1 | `llmcli/v0.1.0` | non (**latent** : PR #146 propose 0.2.0 et écraserait le 0.1.1 manuel) |
| **roxabi-forge** | release-please | main 0.4.0 · staging 0.3.0 | `roxabi-forge/v0.4.0` | non (lag staging inerte, vérifié non-clobbering) |
| **roxabi-talks** | release-please | main 0.2.0 | `roxabi-talks/v0.2.0` | non |
| **roxabi-intel** | release-please | 0.2.0 | `roxabi-intel/v0.2.0` | non |
| **roxabi-1page** | release-please | 0.10.0 | `roxabi-1page/v0.10.0` | non — **seul repo intégralement propre** |
| **roxabi-cortex** | release-please | insight 0.1.0 · memory 0.0.0 | `cortex-insight/v0.1.0` · memory: **aucun** | non (sain mais **inerte** : 15 commits non releasés) |
| **roxabi-production** | aucun | `{}` | **aucun tag, 0 run RP jamais** | n/a — jamais releasé |
| **roxabi-vault** | aucun (**archivé**) | `{}` | **aucun tag, 0 run RP jamais** | n/a |
| **roxabi-live** | promote-manual (RP **supprimé** 2026-06-20) | n/a — SSOT = `APP_RELEASE` 0.24.1 | `roxabi-live/v0.24.1` | non **sur l'axe tag** — mais `pyproject.toml` = **0.22.3** (ment depuis 3 releases) |

### 1.3 Santé réelle de release-please : **6 cadavres sur 12 installs**

| état | repos | preuve |
|---|---|---|
| **mort sur main** | factory, voiceCLI | runs 28594522176 / 28594523911 (2026-07-02) : `##[error] Input required and not supplied: token`. `main` tourne encore `@v4` + `secrets.PAT` retiré. Le fix v5+App-token existe **sur staging, jamais promu** |
| **deadlock structurel** | production, vault | workflow `on: push: main` mais fichier **absent de main** → 0 run, jamais |
| **misfire historique** | idna | run 24466389076 : pas d'input `target-branch` → défaut = `staging` → PR #7 sur la mauvaise branche → **0 tag cuté, jamais** |
| **0 tag bot** | llmCLI | PR #146 rouge depuis 14j |
| **fonctionnel** | 1page, forge, intel, talks, plugins, cortex | — |

### 1.4 PRs de release qui pourrissent (FACT, aujourd'hui)

| repo | PR | ouverte depuis |
|---|---|---|
| roxabi-cortex | #16 (cortex-memory 0.1.0) | **~6 semaines** |
| roxabi-cortex | #22 (cortex-insight 0.1.1) | **~5 semaines** |
| roxabi-intel | #20 (0.3.0) | 18 jours |
| roxabi-forge | #103 (0.5.0) | ~2 semaines |
| llmCLI | #146 (0.2.0) | 14 jours, `ci` FAIL |
| roxabi-plugins | #321 (0.5.0) | **fermée à la main aujourd'hui 08:55** |

**INFERENCE (haute confiance)** : les 4 releases « bot réussies » (forge, intel, talks, plugins) datent **toutes du 2026-06-15** — un humain a vidé la file à la main. Le déclencheur « automatique » est déjà humain.

---

## 2. Le vrai problème

**Ce n'est ni release-please seul, ni /promote seul — mais l'asymétrie de réparabilité entre les deux, sur une topologie que release-please ne peut pas modéliser.** FACT (reproduit sur le DAG réel de `roxabi-1page`) : le walk de release-please est une **itération par date de commit avec un `break` dur sur le SHA de la dernière release** — sensible à l'ordre, pas à l'accessibilité. Le commit de promote a **toujours le stop SHA comme premier parent** (`e6097fd` parents = `e73f96b dca88f1`), donc tout commit de staging dont la date est **antérieure** à la merge de la release précédente est invisible : dans l'incident #140, le `feat c013d30` (position 5) a été perdu parce que le tip de staging (08:11:19) était **10 secondes plus vieux** que la merge de release 0.7.0 (08:11:29) → 0 commit collecté → 0 release PR → 0.8.0 a dû être cuté à la main (PR #141). **Aucun knob ne corrige ça** (`bootstrap-sha` est ignoré après la 1re release PR ; `--release-as` est manuel = /promote avec des étapes en plus), et le README de release-please **exige le squash-merge**, que `release-convention.md` **interdit** (46 conflits fantômes sur roxabi-plugins). Deux non-négociables en collision frontale. Face à ça, le défaut de /promote est ~20 lignes de shell : sa step 2 (`git describe --tags --abbrev=0`) est aveugle aux préfixes et ancrée sur staging, et il **n'a aucune étape d'écriture de version file** (SKILL.md step 2 = `version | V detected` — *détecté*, jamais écrit). **Faire tourner les deux garantit le drift** (deux SSoT sans réconciliateur), mais le remède n'est pas « choisir le mieux configuré » : c'est **supprimer celui qui est irréparable et réparer celui qui l'est**.

**Correction au doc org (FACT, les 3 designs l'ont reproduit indépendamment)** : `release-convention.md:54` attribue #140 au backmerge et aux « nœuds de merge non-parsables ». **Les deux sont faux** — les nœuds non-parsables sont collectés puis filtrés (inoffensifs), et supprimer le backmerge échoue **à l'identique** (le stop SHA est le premier parent du promote, dans la frontière dès l'étape 1). La ligne pointe la remédiation sur le mauvais levier. **À amender quoi qu'il arrive.**

---

## 3. Décision

**Supprimer release-please des 12 repos. `/promote --finalize` devient l'unique chemin de release.**
**Condition non-négociable : le fix `/promote` (Phase 0) ship AVANT toute suppression.**

### 3.1 Propriété des artefacts — après

| artefact | owner | note |
|---|---|---|
| **version compute** | `/promote` step 2 — **réécrit** | `BASE = max_semver{ t ~ ^<component>/v* : is_ancestor(t, origin/main) }` · payload = `git rev-list --no-merges origin/main..origin/staging` |
| **version files** | `/promote` **step 2b — NOUVEAU** | piloté par `.claude/stack.yml` → `release.version_files`. **Vide (= rien à écrire) pour les repos class NONE** |
| **CHANGELOG.md** | `/promote` step 3 | inchangé |
| **tag `<component>/vX.Y.Z`** | `/promote` step 9c | ajouter `--match '<component>/v*'` |
| **GitHub Release** | `/promote` step 9d | inchangé |
| **pre-flight** (CI, PRs ouvertes, nothing-to-promote, hotfix density) | `/promote` step 1 | + assert `version_file == BASE` → REFUSE si déjà drifté |
| **pin-swap `branch=` → `tag=`** | `/promote` step 1b | inchangé — release-please en est structurellement incapable (résolution SHA→tag cross-repo + `uv lock`) |
| **promotion PR staging→main** | `/promote` step 7 | merge commit, jamais squash, jamais auto-merge |
| **deploy preview** | `/promote` step 5 | inchangé |
| **`.release-please-manifest.json`** | **n'existe plus** | fichier supprimé → aucun writer → ne peut pas geler |
| **release-please** | **supprimé** | 3 fichiers × 12 repos |

### 3.2 Le point clé : **une valeur, quatre projections**

`$VERSION` est calculé **une fois** (step 2). Steps 3 / 2b / 9c / 9d en sont des **rendus**, pas des copies indépendantes. Il n'y a pas de degré de liberté à l'intérieur de la transaction.

### 3.3 Classification des repos — quels artefacts existent (graft du Design 3)

Règle **mécanique** (grep, pas jugement) : *une machine lit-elle ce tag, et depuis quelle lignée ?*

```
PRODUCER ⇔ ∃ repo R : R a [tool.uv.sources] avec git=<ce repo>   → pin-swap résout SHA→tag
TRIGGER  ⇔ ce repo a un workflow on.push.tags: ['<c>/v*']
NONE     ⇔ ni l'un ni l'autre
```

| class | repos | version file | tag |
|---|---|---|---|
| **PRODUCER** | roxabi-factory (nats, contracts, otel, satellite…), roxabi-vault | **requis** (uv le résout) | lignée **staging**, à la demande |
| **TRIGGER** | voiceCLI, llmCLI, **imageCLI (non audité)** | **requis** (build uv) | lignée **main**, au promote |
| **NONE** | roxabi-live, forge, talks, idna, intel, 1page, production, plugins, cortex | **`version_files: []` → SUPPRIMER le littéral** | main, ancre uniquement |

**FACT** : **9 des 14 repos n'ont aucune machine qui lit leurs tags.** Pour eux, la bonne correction n'est pas « stamper puis gater » — c'est **supprimer le fichier de version**. Un artefact qui n'existe pas ne peut pas driftrer, ne demande pas de gate, et aucun gate ne peut être désactivé. `roxabi-live/pyproject.toml` (0.22.3 mensonger) se supprime, il ne se corrige pas.

---

## 4. Pourquoi pas les alternatives

| design | verdict | pourquoi il perd (citations juges) |
|---|---|---|
| **D1 — release-please owns version/changelog/tag ; /promote réduit au gate** | 2/10, 2/10, 2/10 — **unanime** | « Le seul design qui garde vivant le composant irréparable. » Le sauvetage `last-release-sha` **marche techniquement** (tracé sur le DAG réel : marker `4b43dc5` position 8 → feat `c013d30` position 5 collecté) **mais réintroduit la maladie** : un **second store d'état last-release**, écrit par /promote, lu par RP, réconcilié par personne. Résiduel : les branches à date ancienne sont **silencieusement** droppées → RP cute un **patch au lieu d'un minor**, changelog amputé, tag poussé, **aucun signal**. #140 était survivable *parce qu'il échouait bruyamment*. Et le gate G2 oblige /promote à **réimplémenter le walk de RP pour policer RP** — « quand le gate doit simuler les internes de l'outil pour certifier sa sortie, l'outil est le mauvais outil ». Mort opérationnelle indépendante : gate G1 (refuser le promote tant qu'une PR `autorelease: pending` est ouverte) rencontre **5 repos avec des PRs ouvertes 14–37 jours** → deadlock flotte entière jour 1. **Son propre verdict conclut « life support » et recommande le Design 2.** |
| **D3 — split par archetype (PRODUCER/TRIGGER/NONE)** | 6, 5, 7 | Le split **s'auto-effondre** — et il a raison : « on ne peut pas prendre la bonne moitié sans la mauvaise », la seule compétence unique de RP (bump des version files) est **calculée depuis le walk cassé**. Ce qui reste = même destination que D2 + une couche de classification. **Il perd sur son moteur** : son fix step 2 est `git describe --tags --match '<component>/v*'` **ancré sur staging** — vérifié par un juge : roxabi-live → **0.24.0** (le tag est v0.24.1, non accessible depuis staging, `--match` n'y change rien), roxabi-plugins → 0.3.0, roxabi-talks → **fatal même avec `--match`**. **3/3 échecs aujourd'hui.** Il rend le **backmerge load-bearing** (l'étape la plus souvent oubliée — celle qui a déjà détruit `main` en prod via `delete_branch_on_merge` sur roxabi-1page #102). Il ajoute une **2e opération de tag** (`/release-tag`) avec une boucle de re-lock qu'il **admet n'avoir jamais exercée**. |

**Ce qu'on garde de D3** (les 3 juges l'ont grafté) : la règle `tag_class`, le `version_files: []` pour les 9 repos NONE, la contrainte de séquençage par repo, les « trois formes de suppression », et la correction de `release-convention.md:54`.

**Ce qu'on ne garde PAS de D1** : le ruleset de tag restreint à l'App roxabi-ci. **Refuter 3 l'a tué** — sous /promote, l'identité qui tague *est* l'humain, donc un ruleset restreint à un bot **bloquerait /promote lui-même** ; et il bloquerait les tags annotés à la main sur des SHA staging (`roxabi-contracts/v0.13.0 — unblock SDK tag-cutting (#2199)`) dont pin-swap dépend. **Version adaptée retenue** : un ruleset qui contraint le **nommage** (`refs/tags/**` doit matcher `<component>/vX.Y.Z`, bloquer les `vX.Y.Z` nus), pas l'identité.

---

## 5. Le point dur — le commit-walk / merge-commit

### 5.1 La recommandation y survit — vérifié par exécution, pas par argument

**FACT** (rejoué sur le fixture #140 réel dans `/home/mickael/projects/roxabi-1page`) :

```
$ git rev-list --no-merges e73f96b..dca88f1
c013d306975294e02764111811cdfa0a22b97aa4
$ git log --no-merges --format='%h %s' e73f96b..dca88f1
c013d30 feat(bloc2): move admin lead filters into table column headers
```

`bump(0.7.0, [feat])` = **0.8.0** — exactement la version que release-please a silencieusement droppée et qu'il a fallu cuter à la main (PR #141).

**Pourquoi c'est structurel** : `A..B` est une **différence d'ensemble par accessibilité** : `{x : reachable(x,B)} \ {x : reachable(x,A)}`. Pas de queue prioritaire, pas de date de commit, pas de `break`. **La course de 10 secondes n'est pas mitigée — elle est indéfinie.**

**Backmerge-invariant** (FACT, vérifié sur roxabi-live aujourd'hui) :

| | résultat |
|---|---|
| `git merge-base --is-ancestor roxabi-live/v0.24.1 origin/staging` | **NO** (pas de backmerge) |
| `git describe --tags --abbrev=0 origin/staging` | **0.24.0** ← périmé |
| BASE ancré main (proposé) | **0.24.1** ← correct |

Backmerge fait → les commits de main sont ancêtres de staging → exclus par `origin/main..`. Backmerge sauté → ils sont sur main → **aussi** exclus. Même réponse. C'est un théorème, pas une chance.

### 5.2 Ce que les refuteurs ont trouvé — honnêtement

**2 refutations sur 3 ont visé le mauvais design.**

| refuteur | cible réelle de son attaque | verdict |
|---|---|---|
| **R1** — « `last-release-sha` est statique, RP tire aussi au merge de la release PR → re-collecte les commits déjà releasés → PR fantôme → G1 refuse → **livelock** ; preuve : run 28594522176 réel sur `5d35a9f`, walk `5d35a9f..9deee55` re-collecte `0fd6e82` » | **`last-release-sha` = mécanisme du Design 1. Le Design 2 supprime release-please : il n'y a ni marker, ni manifest, ni run RP.** L'attaque ne touche pas le gagnant. | **Ne s'applique pas** — et sa propre conclusion : « the artifact's own verdict — delete RP fleet-wide, add /promote step 2b write-version-files — is correct, and my attack independently confirms why ». **Il valide la décision.** |
| **R2** — « la prémisse d'atomicité de RP est fausse : le manifest atterrit par git-merge, le tag par une phase `manifest-release` séparée ; roxabi-idna est déjà drifté (manifest 0.1.0, **0 tag**) avec RP seul writer et **zéro** intervention humaine » | **Même chose : c'est la prémisse du Design 1.** Le Design 2 ne fait pas cette prémisse. | **Ne s'applique pas au gagnant — et le renforce** : la preuve que RP seul writer produit du drift (le gap merge→tag a tiré **3× en 3 mois** : idna, voiceCLI run 25006583538 GraphQL 5xx, factory+voiceCLI 2026-07-02 token) **est un argument de plus pour le supprimer**. Sa propre conclusion : « the fix is /promote step 2b (write-version-files) plus deleting RP ». |
| **R3** — attaque principale : « le ruleset `refs/tags/*/v*` restreint à roxabi-ci bloque le hand-cut humain à un SHA staging dont pin-swap dépend (roxabi-obs locké à `f717d8ae`, **sur staging, pas sur main, 0 tag**) → le prochain promote voiceCLI/llmCLI **hard-fail** » | ruleset + monopole tag RP = **Design 1**. **Mais son attaque secondaire touche le gagnant.** | **PARTIELLEMENT VALIDE — voir 5.3.** |

### 5.3 Ce qui touche réellement la recommandation (R3, attaque secondaire) — **FACT, non résolu**

> « `/promote` est **mono-composant par construction** (step 2 valide `^v[0-9]+\.[0-9]+\.[0-9]+$`, un seul CHANGELOG.md racine, un tag par run). »

| repo | pourquoi il ne rentre pas | vérifié |
|---|---|---|
| **roxabi-factory** | 3 composants (`lyra` + `roxabi-nats` + `roxabi-contracts`, + otel/satellite/blobs/obs sans aucun tag). `git describe --tags --abbrev=0` → **`artifacts-archive/2026-06`** (tag non-version). BASE ancré main → nats 0.2.1 / contracts 0.2.0 = **honnête et inutilisable** (les vrais tags sont sur `db304fd6`, **non-ancêtre de main**, divergence 33/3934). Payload = 2566 commits non-merge. **Et bloqué indépendamment** : `git ls-remote --tags roxabi-vault` → **VIDE**, repo **archivé**, factory le pin `branch=staging @d8517edd` → **pin-swap throw → factory ne peut pas promote AUJOURD'HUI**, et release-please n'y est pour rien | FACT |
| **roxabi-cortex** | 2 packages versionnés indépendamment (insight 0.1.0, memory 0.0.0) qu'un `$VERSION` unique écraserait. **Pas de CHANGELOG.md racine**. Branche par défaut = **`main`**, en avance de 15 commits sur staging → **topologie staging→main inversée** → /promote inapplicable tel quel. RP y est le **seul** chemin de release et **il marche** (assumptions linéaires respectées) | FACT |

### 5.4 Verdict honnête sur le point dur

- **Sur les 11 repos mono-composant en topologie staging→main** : la recommandation **survit au walk** — prouvé par exécution sur le fixture qui a tué l'incumbent. Le résiduel (staging bouge entre le stamp step 2b et la merge du promote) est **rattrapé bruyamment** par l'assertion 3-way de step 9b → REFUSE. Bruyant-et-faux est récupérable ; silencieux-et-faux a exigé la PR #141.
- **Sur `roxabi-factory` et `roxabi-cortex`** : **la question n'est pas tranchée.** /promote est mono-composant ; RP est cassé pour factory (walk + tags injoignables depuis main) mais **fonctionnel** pour cortex. Aucun des 3 designs n'a de réponse solide. **Ne pas les migrer sur la foi de ce document.**

---

## 6. Migration

### Phase 0a — arrêter l'hémorragie (aujourd'hui, découplé de toute décision)

| repo | action |
|---|---|
| roxabi-forge | **#103 est une PR de release orpheline ouverte maintenant** → merger ou fermer |
| roxabi-cortex | #22 (5 sem) + #16 (6 sem, cortex-memory jamais releasé) → merger (dernier acte du bot) |
| roxabi-intel | #20 (18 j) → merger ou fermer |
| llmCLI | #146 (`ci` rouge 14 j, écraserait le 0.1.1 manuel) → **fermer** |
| **doc org** | amender `release-convention.md:54` — la root cause de #140 n'est **ni** le backmerge **ni** les nœuds non-parsables ; c'est *tip staging (08:11:19) plus vieux que la merge de release (08:11:29)* sous un `break` sensible à l'ordre |

### Phase 0b — **le fix `/promote` — 1 PR, 1 repo (`roxabi-plugins/dev-core`). RIEN d'autre ne démarre avant.**

**FACT mesuré — pourquoi c'est bloquant** : `git describe --tags --abbrev=0 origin/staging` est **faux dans 7 repos sur 11**. Supprimer release-please avant ce fix = **livrer une régression**.

| repo | step 2 aujourd'hui | BASE proposé | correct |
|---|---|---|---|
| roxabi-plugins | **`dev-core/v0.4.4`** (autre composant) | 0.4.0 | 0.4.0 |
| roxabi-factory | **`artifacts-archive/2026-06`** (tag d'archive) | nats 0.2.1 / contracts 0.2.0 | (inutilisable — cf. 5.3) |
| roxabi-talks | **fatal** | 0.2.0 | 0.2.0 |
| roxabi-forge | **fatal** | 0.4.0 | 0.4.0 |
| roxabi-live | 0.24.0 (périmé) | **0.24.1** | 0.24.1 |
| voiceCLI | 0.2.1 (périmé) | **0.3.0** | 0.3.0 |
| 1page / intel / llmCLI | ok | ok | ok |

Contenu de la PR :

1. **step 2** — remplacer `git describe` :
   ```bash
   COMPONENT=$(yq '.release.component' .claude/stack.yml)
   BASE=$(for t in $(git tag -l "${COMPONENT}/v*"); do
            git merge-base --is-ancestor "$t" origin/main 2>/dev/null && echo "${t#${COMPONENT}/v}"
          done | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
   COMMITS=$(git rev-list --no-merges origin/main..origin/staging)
   ```
   → **component-scoped** + **main-anchored** + **payload tautologique** (= le contenu exact de la promotion PR).
2. **step 2b — NOUVEAU** `write-version-files` : écrit `$VERSION` dans `release.version_files`. **No-op si la liste est vide** (class NONE).
3. **step 9b** — **supprimer** le re-parse du heading CHANGELOG (= le **2e SSoT interne de /promote**, que la suppression de RP sur roxabi-live avait laissé intact). Remplacer par : lire `$VERSION` dans le `.title` de la promotion PR que step 9a **fetch déjà** (`gh pr list --base main --head staging --state merged --limit 1`), puis asserter `V_pr == V_chlog == V_file`.
4. **step 1** — assert `version_file == BASE` → **REFUSE** si déjà drifté.
5. **step 9c** — `--match '<component>/v*'`.
6. **schéma `.claude/stack.yml`** : bloc `release: { class, component, version_files }` — **dans le stack.yml existant, pas un nouveau fichier**.
7. **CI réutilisable `release-consistency.yml`** (required check sur main) : `version_files == max_semver(tags <component>/v* accessibles depuis main)`. Skip si `version_files: []`.
8. **Tests de régression** : le fixture #140 (`e73f96b..dca88f1` → `{c013d30}` → 0.8.0) + les 7 baselines mesurées ci-dessus en golden values.

**Puis dogfood sur le prochain promote de roxabi-live avant de toucher quoi que ce soit d'autre.**

### Phase 1 — référence + mécanique (5 repos, ~1 PR chacun, parallélisables)

⚠ **Contrainte d'ordre par repo (FACT)** : RP est le **seul writer du version file** dans `roxabi-intel` (`c67362e`, `a067e73`, tous roxabi-ci[bot]) et `roxabi-1page` (`17c9394`). **Les supprimer avant que step 2b existe gèle ces fichiers définitivement** — reproduction exacte du bug pyproject de roxabi-live. Phase 0b est bloquante pour eux.

| repo | class | action |
|---|---|---|
| **roxabi-live** | NONE | RP déjà absent. Ajouter le bloc `release:` (`component: roxabi-live`, `version_files: []`). **SUPPRIMER `pyproject.toml`** — stub mensonger 0.22.3, zéro consommateur (vérifié) |
| **roxabi-1page** | NONE | ⚠ Phase-0b-first. Propre (0.10.0 == v0.10.0) → **le canari** |
| **roxabi-intel** | NONE | ⚠ Phase-0b-first. 0.2.0 == tag ✓ |
| **roxabi-forge** | NONE | backmerge main→staging d'abord, puis supprimer le littéral de `package.json` |
| **roxabi-talks** | NONE | le `component:` déclaré rend le legacy `v1.0.1` invisible — pas de retag. Ajouter le `target-branch` manquant devient inutile (RP supprimé) |

### Phase 2 — réconcilier puis supprimer (3 repos) — **les tags gagnent** (publiés et consommés ; les manifests non)

| repo | class | action |
|---|---|---|
| **voiceCLI** | TRIGGER | pyproject staging 0.2.2 → **0.3.0** (= tag `voicecli/v0.3.0`). Supprimer le workflow v4/PAT mort de main (il échoue depuis le 2026-07-02 — suppression pure). Prochain promote : BASE 0.3.0, 162 commits / 22 feat → **v0.4.0** |
| **llmCLI** | TRIGGER | #146 fermée. pyproject 0.1.1 → **0.1.0** (0.1.1 jamais tagué, `gh release list` vide). Prochain promote légitime |
| **roxabi-plugins** | NONE | main 0.4.0 == v0.4.0 ✓. Stamper `package.json` 0.3.0 → 0.4.0. **Décider** le composant orphelin `dev-core/v0.4.4` (tag lightweight, aucune GH release, dans aucune config) |
| **imageCLI** | TRIGGER | **NON AUDITÉ** — classifier + réconcilier avant de toucher |

### Phase 3 — suppression de fictions (2 repos)

| repo | action |
|---|---|
| **roxabi-idna** | manifest+CHANGELOG revendiquent 0.1.0 avec **0 tag** — mensonge produit par un run RP qui a visé staging. Supprimer le manifest supprime le mensonge. Premier vrai promote : BASE=none, 26 commits / 1 feat → **`roxabi-idna/v0.1.0`**. Reset pyproject 0.1.1 → 0.1.0 |
| **roxabi-production** | `{}`, 0 tag, **0 run RP jamais** (deadlock : workflow sur main, fichier sur staging). Config sans `component`/`tag-separator` → aurait émis des tags **nus** (violation Convention A). Le `release:` déclaré corrige par déclaration. Premier promote : 69 commits / 21 feat → **`roxabi-production/v0.1.0`** |

### Trois formes de suppression (graft D3 — la suppression n'est pas un acte uniforme)

| forme | repos | comment |
|---|---|---|
| fichiers **sur staging seulement** (jamais arrivés sur main) | production, vault | supprimer sur staging — trivial |
| fichiers sur les deux, RP **mort sur main** | factory, voiceCLI | la config est **inerte** → suppression différable à coût nul |
| fichiers sur les deux, RP sain | 1page, forge, intel, talks, idna, plugins, cortex | supprimer sur staging → promote |

### Phase 4 — **NE PAS grouper. Issue séparée.**

| repo | pourquoi |
|---|---|
| **roxabi-vault** | **ARCHIVÉ**. Config RP = code mort dans un repo gelé → no-op. **MAIS** : 0 tag + archivé + factory le pin `@d8517edd` = **pin-swap throw → factory bloqué**. Résolution hors modèle de release : désarchiver + taguer `roxabi-vault/v0.1.0` @ d8517edd, ou vendorer, ou finir la migration cortex |
| **roxabi-factory** | Supprimer RP est trivialement correct (mort depuis avril, manifest gelé 90 jours). **Ne PAS tenter de promote.** Divergence 33/3934, tags sur SHA staging, payload 2566 commits, vault bloquant, /promote mono-composant. **Aussi** : `lyra-v0.2.0` (tiret) viole Convention A, et `publish.yml` déclenche sur `factory/v*` alors que **zéro tag `factory/v*` existe** (le trigger n'a jamais tiré — les images publient via `workflow_run`). **Issue dédiée.** |
| **roxabi-cortex** | main-default, historique linéaire, **RP y marche**. Le supprimer coûte de l'automatisation réelle pour acheter de l'uniformité. Et /promote ne sait pas gérer 2 packages. **Décision séparée.** |

---

## 7. Risques restants + confiance

### 7.1 Confiance par affirmation

| affirmation | statut | confiance |
|---|---|---|
| Le walk de RP est sensible à l'ordre avec `break` ; #140 = tip staging 10 s plus vieux que la merge de release | **FACT** — DAG + timestamps + parents rejoués | **Très haute** |
| Aucun knob ne rend le walk reachability-based ; `bootstrap-sha` ignoré après la 1re release PR | **FACT** — docs ctx7 `/googleapis/release-please` | Haute |
| RP exige le squash-merge ; l'org l'interdit → collision non réconciliable | **FACT** — README RP + `release-convention.md` | Très haute |
| `git rev-list --no-merges e73f96b..dca88f1` → `c013d30` → 0.8.0 | **FACT** — exécuté | **Très haute** |
| BASE ancré main est backmerge-invariant | **FACT** — vérifié sur roxabi-live (v0.24.1 non-ancêtre de staging) | **Très haute** |
| `/promote` step 2 est faux dans 7/11 repos | **FACT** — mesuré | **Très haute** |
| `/promote` n'a **aucune** étape version-file | **FACT** — SKILL.md lu | **Très haute** |
| 9/14 repos n'ont aucune machine lisant leurs tags | **FACT** — grep exhaustif… **sauf imageCLI non audité** | Haute (avec la réserve) |
| Le drift dual-mechanism meurt par **cardinalité** (fichier supprimé → aucun writer) | **FACT logique** | **Haute** — c'est de l'ontologie |
| Le drift version-file résiduel est **détecté**, pas empêché | **FACT** — le gate CI est skippable/désactivable | Haute |
| factory + cortex ne rentrent pas | **FACT** (R3, vérifié) | Haute — **et non résolu** |

### 7.2 Ce que je refuse d'affirmer

**PR #255 disait « drift becomes structurally impossible ». C'est FAUX et l'arbre le prouve** : `roxabi-live/pyproject.toml` = 0.22.3 contre tag 0.24.1, **3 releases plus tard**. La suppression a supprimé **l'artefact qui annonçait** le drift, pas le drift. **Je ne répète pas cette affirmation.** Ce qui est vrai :

| axe | après |
|---|---|
| manifest vs tag | **impossible** — le fichier n'existe plus, aucun writer ✅ *(ontologie)* |
| version file vs tag, **class NONE (9 repos)** | **impossible** — le littéral est supprimé ✅ *(ontologie)* |
| version file vs tag, **class PRODUCER/TRIGGER (5 repos)** | **détecté et bloquant** (step 1 REFUSE + CI required) ⚠ *(enforcement — un humain peut désactiver le check)* |

### 7.3 Risques restants

1. **factory + cortex non tranchés.** 11/13, pas 13/13. Ne pas arrondir.
2. **roxabi-factory est bloqué aujourd'hui pour une raison hors modèle** : roxabi-vault archivé, 0 tag, pinné `branch=staging @d8517edd` → `pin-swap: No release tag found`. Aucun modèle de release ne corrige ça.
3. **Perte du nag.** RP, quoi qu'on lui reproche, **demandait** (forge #103, cortex #16 6 sem…). Le supprimer rend « personne n'a promu depuis 6 semaines » invisible. Mitigation : un `promote-nag` planifié (`commits_ahead > 20 ∨ age(last tag) > 30 j` → ouvrir une issue) — **à construire, pas encore existant.**
4. **Le namespace de tags n'a aucune protection.** `roxabi-live/v0.22.2` est un tag **annoté, humain, nu**, cuté le 2026-07-02 — **après** la suppression de RP. C'est ce qui empoisonne `--sort=-v:refname` là-bas aujourd'hui. Un ruleset **de nommage** (`refs/tags/**` doit matcher `<component>/vX.Y.Z`) est recommandé ; un ruleset **d'identité** est incompatible avec /promote (R3).
5. **La course staging concurrente est mitigée, pas éliminée.** Bruyante (REFUSE en 9b) au lieu de silencieuse. C'est mieux. Ce n'est pas nul.
6. **Le gate humain de step 2 peut choisir faux.** Validation format + monotonicité (`V > BASE`) ajoutée ; la sémantique reste humaine. RP, lui, ne laissait jamais un humain taper la version.
7. **hatch-vcs (`dynamic = ["version"]` + `[tool.hatch.version] source = "vcs"`) — le seul kill ontologique restant pour les 5 repos à version file — est NON VÉRIFIÉ** : ajoute une dépendance à `.git` au build de chaque dep uv git-sourced, + un `tag_regex` par composant. **À ne pas bundler avec la suppression.** Phase 2+ derrière un vrai test.
8. **`imageCLI` non audité** alors qu'il est class TRIGGER et pin factory. À classifier avant tout.
9. **La boucle `/release-tag` → `uv lock --upgrade-package` (proposée par D3 pour factory) n'a jamais été exercée.** Si le modèle PRODUCER est adopté un jour, c'est là qu'il casse.

### 7.4 Note sur les refutations adverses

**2 refuteurs sur 3 ont attaqué le Design 1** (le marker `last-release-sha` et la prémisse d'atomicité de release-please) **en croyant attaquer le gagnant.** Aucun des deux mécanismes n'existe dans le Design 2 — qui supprime release-please. **Leurs deux conclusions recommandent explicitement le remède retenu** (« delete RP fleet-wide, add /promote step 2b write-version-files »). Le 3e refuteur a une attaque principale hors sujet (le ruleset — écarté ici) et **une attaque secondaire valide** : /promote est mono-composant → **factory et cortex sont hors thèse, et je le dis plutôt que de l'arrondir.**

### 7.5 Confiance globale

**Haute (≈85 %) sur les 11 repos mono-composant en topologie staging→main**, à condition stricte que **Phase 0b ship avant toute suppression**.
**Faible (≈30 %) sur factory et cortex** — question ouverte, issues dédiées.

**La valeur de cette décision est dans Phase 0b + step 2b + le gate CI — pas dans la suppression.** Quiconque lit « on généralise roxabi-live » comme « supprimer 3 fichiers × 12 » livre une régression à 7 repos, parce qu'aujourd'hui release-please y est le **meilleur** calculateur de version.