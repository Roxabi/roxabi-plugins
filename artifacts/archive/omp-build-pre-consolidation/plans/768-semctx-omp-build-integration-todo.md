---
title: "Todo: adapter omp-build au contrat Semctx existant"
issue: 768
created: "2026-10-09"
status: in_progress
---

# Objectif et autorisation

Réduire les vérifications et le contexte modèle redondants dans omp-build en consommant le contrat Semctx existant. Cible : une PR dans `roxabi-plugins`, sans fork ni modification de Semctx ou de ses caches installés. Des recalculs déterministes documentés restent acceptables ; ils ne constituent pas, seuls, un bug upstream.

Autorisation actuelle : étapes 2–5 autorisées, y compris code/tests/docs, commits, push, revue et merge par les gates existants. L'objectif se termine uniquement après merge vérifié et clôture justifiée de #768, pas après un arrêt sûr. L'autorisation initiale limitée à l'étape 1 reste dans le journal historique. Aucun fork/cache/parser Semctx, release/réinstallation, nettoyage destructif du worktree vivant ni exécution de l'epic #720 n'est autorisé.

Références : [#768 — admission](https://github.com/Roxabi/roxabi-plugins/issues/768), [#737 — preuve comportementale](https://github.com/Roxabi/roxabi-plugins/issues/737), [#734 — conservation des défauts](https://github.com/Roxabi/roxabi-plugins/issues/734), [#720 — livraison](https://github.com/Roxabi/roxabi-plugins/issues/720). Revalider leur état avant l'étape 2 ; ne pas prétendre couvrir une issue entière par proximité de sujet.

## État des cinq étapes

| Étape | État | Livrable et critère de fin |
|---|---|---|
| 1. Acquisition native | Terminée — cas positif borné démontré | Résultat natif acquis et réutilisé sans relance ; contre-exemples et limites consignés ci-dessous |
| 2. Périmètre et contrats | Arbitrage explicite appliqué | #768 amendée au plafond reviewer autorisé ; #779/#778 NOT_PLANNED, jamais code-fixed |
| 3. Implémentation | Candidat amendé poussé | `3f8c56d48560a9dc77a93400e8227154fc83a1e1` ; trois commits documentation-only après runtime `c1c01bf5` |
| 4. Preuves comportementales | Derniers contrôles verts | 132 fichiers / 4 185 tests après dernier writer, lint/typecheck ; quatre runs CI verts sur ce SHA ; deux vérités reviewer-judged, jamais certifiées |
| 5. PR et livraison | PR de diagnostic superseding — worktree prêt, `/move` attendu | #776 arrêtée (borne épuisée, ouverte comme preuve). [#768 amendée](https://github.com/Roxabi/roxabi-plugins/issues/768) : plan D1–D3. Branche `fix/768-semctx-proof-admission-v2` depuis `origin/main` `2c44cc10` ; nouvelle PR, nouvelle borne |

## 1. Démontrer l'acquisition d'une preuve native

- [x] Identifier la version et le binaire Semctx effectivement employés ; utiliser les interfaces publiques de cette installation, pas des fonctions privées importées d'un checkout source.
- [x] Construire un dépôt Git jetable avec un changement réel, un contrat non vide et une observation comportementale effectivement exécutée. Initialiser Semctx uniquement dans cette fixture ; ne pas configurer le dépôt de travail.
- [x] Produire un résultat natif sur une portée explicite et un candidat déterminé. Lire le verdict structuré, pas seulement le code de sortie : `change verify` peut sortir avec 0 sur PARTIAL. Conserver les résultats natifs sans fabriquer de champs ou de statut de réussite.
- [x] Identifier les faits réellement disponibles : dépôt, candidat/head, base/merge-base et diff analysé, contrat/modèle, configuration, index/producteur, observations runtime pertinentes. Séparer les champs natifs des faits d'invocation observés par le consommateur ; chaque dimension non établie reste inconnue.
- [x] Exercer une consommation sans nouvel appel d'analyse, test ou LLM : même candidat/entrées ; candidat différent ; modification du code, du contrat et de la configuration ; résultat absent ou illisible. Établir ce qui peut effectivement être admis et ce qui doit être refusé ou reste indémontrable.

**Contraintes de la sonde :** aucun vrai appel de merge/arm/push ; pas de parser `.sem` maison, cache universel, ledger de preuve ou faux `proof: true`. Une sortie sauvegardée n'ajoute pas de provenance. Le record Git Plane A n'est pas un résultat composé Plane B ni une preuve runtime. L'absence de configuration n'est pas l'illisibilité. Un contrat vide VERIFIED ne prouve pas le besoin d'admission.

**Livrable :** résultats reproductibles et bornés consignés sous cette étape, avec commandes, interfaces, observations et limites. Si le cas positif de #768 n'est pas démontré avec les interfaces actuelles, nommer exactement l'information/capacité manquante. Ne pas livrer un faux succès ni un consommateur qui refuse toujours comme solution complète. Une limitation native démontrée déclenche un arbitrage explicite du contrat ou une demande upstream, pas une réduction silencieuse des critères.

**Critère de fin :** acquisition applicable prouvée **ou** limitation précise reproduite. Une conclusion négative peut terminer l'investigation, jamais déclarer #768 livré.

## 2. Fixer le périmètre d'une PR unique

- [x] Réconcilier les critères actuels de #768 et les contrats réellement concernés ; distinguer les prérequis livrés, les portions couvertes par la PR et les critères non couverts. Ne modifier le tracker qu'après autorisation de cette étape et via son outil propriétaire.
- [x] Inclure l'applicabilité Semctx avant appel : absence réelle = non applicable ; état ignoré, principal lié, erreur Git, configuration illisible/malformée ou racine ambiguë ne créent pas d'exemption.
- [x] Inclure la suppression de nos injonctions redondantes et le retour `/fix` → `/feature` sans nouvelle vérification/commit/push déjà accomplis sur les mêmes entrées. Respecter le cycle natif Semctx et ne pas falsifier des étapes lifecycle pour satisfaire un rappel.
- [x] Inclure PR précoce, admission au landing, PARTIAL honnête, retrait de la clôture forcée et de l'exigence `.semctx/working/` vide, avec les consommateurs et les sorties cohérents.
- [x] Inclure les seules validations locales démontrées redondantes, après confirmation de l'équivalence des entrées et diagnostics ; fixer la matrice critères → changement → preuve.

**Exclusions :** modification ou fork de Semctx ; suppression de sa vérification fraîche à la clôture ; nouveau format universel/cache/ledger ; suppression de CI indépendante ; retrait de déclencheurs CCC sans mesure ; relance ou remise à zéro des PR historiquement arrêtées ; élargissement automatique aux autres critères de #734/#737/#768.

**Critère de fin :** périmètre exécutable et cohérent d'une PR, compatible avec le résultat de l'étape 1, sans critère abandonné implicitement.

## 3. Implémenter de bout en bout

- [x] Partir d'une branche fraîche depuis la base actuelle et conserver les modifications utilisateur déjà présentes. Ne pas porter globalement une ancienne PR arrêtée ni modifier un cache installé.
- [x] Modifier ensemble les skills et tous leurs consommateurs exécutables concernés : feature/fix/review, acquisition/admission et sorties/erreurs/types applicables. Réutiliser le propriétaire existant du désarmement.
- [x] Conserver l'approbation du SHA courant, la configuration de landing issue de la base, les contrôles CI requis, les bornes de correction et les confirmations de désarmement ; aucun producteur exécuté depuis l'admission.
- [x] Garder les distinctions PASS/WARN/BLOCK, VERIFIED/PARTIAL/BLOCKED/STALE, lifecycle et résultat runtime. Une erreur interne ne devient pas une preuve parce qu'un wrapper termine avec succès.
- [x] Mettre à jour documentation du plugin/index racine et versions package/catalogue selon les conventions actuelles. Éviter les conventions concurrentes, les shims et les assertions de texte source devenues obsolètes.

**Critère de fin :** comportement complet sur tous les consommateurs affectés, prêt pour les scénarios de l'étape 4 ; pas de scaffold ni de dépendance upstream inventée.

## 4. Prouver les comportements

| Scénario à exécuter | Résultat exigé |
|---|---|
| Preuve native applicable au candidat sélectionné | Admission réelle sans nouvelle analyse Semctx, tests ou LLM à cette étape |
| Candidat, portée ou entrées pertinentes modifiés | Refus précis avant arm ; désarmement confirmé ou erreur nommant ce qui reste incertain |
| PARTIAL justifié et cas non justifiés | PARTIAL reste PARTIAL ; aucune fermeture VERIFIED forcée ; refus des gaps absents/non justifiés et des contradictions |
| Semctx réellement absent contre illisible/ambigu | Non-applicabilité limitée à Semctx dans le premier cas ; aucune exemption dans les autres ; politique runtime/CI/assertledger préservée |
| `/fix` terminé puis reprise `/feature` | Aucun travail déjà accompli rejoué sans changement pertinent ; nouvelle revue du candidat et protections Git/CI conservées |

- [x] Utiliser des dépôts jetables, les vrais chemins de production et un transport GitHub isolé ; aucun merge ou arm sur une vraie PR pendant les smokes.
- [x] Associer un cas admissible à chaque refus, varier indépendamment les identités et observer les effets arm/disarm et les appels producteurs.
- [x] Réexercer après les derniers writers/formatters. La falsification négative et la CI du commit intégré ne sont pas des répétitions équivalentes à supprimer.
- [x] Faire échouer les preuves lorsque le comportement dangereux revient ; aucune assertion de copie, de wiring, de prose ou de mock-écho comme oracle.
- [x] Exécuter les vérifications ciblées puis les contrôles pertinents du dépôt ; consigner uniquement ceux réellement observés, avec leur portée et le candidat concerné.

**Critère de fin :** matrice complète avec succès, refus et limites ; aucun résultat historique ni contrat déclaré ne tient lieu de preuve actuelle.

## 5. Ouvrir, faire revoir et livrer la PR

- [x] Ouvrir la PR tôt si utile pour préserver l'historique ; son existence ne vaut jamais autorisation de merge. Corps : périmètre, décisions, candidats et matrice critères → preuves natives/observations.
- [ ] Effectuer la revue du candidat courant, avec conservation des blockers résiduels et sans refaire les producteurs à l'admission. Respecter le cycle et la borne de correction en vigueur.
- [ ] Exécuter l'admission et le landing par les propriétaires existants ; conserver les contrôles de fraîcheur, CI et désarmement ; ne pas contourner un refus à la main.
- [ ] Ne fermer que les issues dont **tous** les critères sont couverts par le changement livré. Les autres restent explicites ; aucun ancien arrêt ou compteur réinitialisé.
- [x] Mettre à jour cette todo avec la PR, les commits, les preuves effectivement observées et les éventuels blocages. Une publication/release/réinstallation suit son autorisation propre, pas une supposition.

**Critère de fin :** PR revue et livrée avec tous les critères satisfaits. Un arrêt documenté est un état bloqué, jamais la fin de l'objectif de livraison.

## Journal d'exécution

- 2026-10-09 : todo créée ; étape 1 autorisée et commencée. Étapes 2–5 non lancées. Les observations de l'audit précédent sont des hypothèses d'entrée à confirmer par la sonde actuelle ; aucune livraison revendiquée.

### 2026-10-09 — étape 1 terminée

**Conclusion : un chemin positif d'acquisition existe avec les interfaces publiques installées.** Aucun changement upstream n'est démontré nécessaire pour cette fixture. Le résultat composé seul n'est pas une preuve de fraîcheur ; il devient exploitable avec les sorties natives de fraîcheur et les faits réellement observés de son invocation. C'est une preuve de faisabilité bornée, pas une livraison de #768 ni une admission réelle dans `landPr`.

#### Producteur et candidat effectivement exercés

| Observation | Valeur |
|---|---|
| Producteur | Bundle public installé Semctx `0.4.2`, lancé par Bun `1.4.0` avec `--no-env-file` |
| SHA-256 du bundle exécuté | `ee7a4626a4b395757c5d989cfb0db60bdeb202d4354c7f922539741043a46ca8` |
| Isolation | Dépôt temporaire autonome, aucun remote, hooks désactivés uniquement dans cette fixture, configuration Git globale/système exclue |
| Base et merge-base observées | `93cf2afd85e606d63293a554589e00543ab45287` |
| Candidat positif | `92ed23a82ffc61f331ec849675c7f77e013e7554` |
| Candidat PARTIAL distinct | `9ecb4a9416beffc219025a861073f4328a0d142a` |
| Comportement | `canPublish(approved, blocked)` : `approved` devient `approved && !blocked` |
| Observation runtime | Quatre combinaisons booléennes : refus du cas bloqué échoue avant changement ; les quatre assertions passent après, puis sur le candidat finalisé |
| Contrat | `change.blocker-precedence`, sert un goal, préserve un invariant lié au symbole réel, requiert `proof.admission-behavior` |
| Résultat positif natif | `VERIFIED`, underlying `PASS`, invariant `proved` avec footprint non vide, une preuve `tested`, aucun pending/unknown/stale ; lifecycle encore `active` |

Les empreintes des fichiers runtime exécutés ont été comparées aux blobs du candidat. L'exécution antérieure au commit n'a pas été renommée « test de ce SHA » : une observation runtime supplémentaire a été faite au candidat finalisé. Aucune exécution runtime n'a eu lieu pendant la consommation.

#### Interfaces publiques et protocole exercé

`SEMCTX_CLI` désigne le chemin absolu du **bundle installé** `dist/semctx.js`, `R` la fixture, `B` la base résolue et `C` le candidat résolu. Les sorties restent séparées et ne reçoivent aucun champ natif inventé.

```sh
# Préparation et production, hors consommation
bun --no-env-file "$SEMCTX_CLI" --root "$R" setup --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" change open change.blocker-precedence \
  --statement "Respect blocker precedence over approval" \
  --serves goal.safe-publication --preserves invariant.blocked-refused \
  --requires proof.admission-behavior --link file:src/admission.ts --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" semantic check --json
# Finaliser code/modèle et commit C ; indexer avant la fenêtre d'acquisition.
bun --no-env-file "$SEMCTX_CLI" --root "$R" index --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" status --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" change verify change.blocker-precedence \
  --base "$B" --head "$C" --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" status --json

# Consommation : lecteurs seulement, pas change verify / index / test / close
bun --no-env-file "$SEMCTX_CLI" --root "$R" status --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" semantic inspect change.blocker-precedence --json
bun --no-env-file "$SEMCTX_CLI" --root "$R" status --json
```

Déclarations de fixture à fournir avant l'ouverture du contrat, dans un fichier `.semctx/semantic/*.sem` :

```text
goal goal.safe-publication
  statement: Publish only approved candidates without a blocker.

invariant invariant.blocked-refused
  rule: A blocked candidate is refused even if approved.
  serves: goal.safe-publication
  link: sym:function:src/admission.ts:canPublish

evidence proof.admission-behavior
  statement: Execute all four approval/blocker combinations.
  status: declared
  link: test:src/admission.test.ts
```

Après observation réelle du comportement, le statut evidence est déclaré `tested` avant de finaliser le candidat positif. Le producteur natif est propriétaire de la lecture du DSL. La première tentative a employé la notation de rendu `[goal]` plutôt que la grammaire canonique : le lecteur l'a rejetée ; la fixture a été corrigée en `goal …` / champs `key: value`. Ce n'était pas une limitation d'acquisition.

- **Résultat natif :** stdout exact de `change verify`, `underlying.base/head/mergeBase`, verdicts, obligations et findings. La sortie a été capturée directement depuis le processus réel.
- **Identité des entrées native :** `status --json` fournit `freshnessSeal`, notamment `analysisInputHash`, `semanticModelHash`, `repositoryGraphHash`, `planeAIndexSnapshotHash`, `workingDiffHash`, racines, heads courant/indexé et versions. Avant/après production : `FRESH` et sorties identiques.
- **Faits d'invocation observés :** binaire/argv/cwd, base et candidat sélectionnés, observation runtime et identité des fichiers exécutés. Ces faits viennent de la sonde ; ils ne sont pas présentés comme des champs du rapport composé.
- **Contrat commité :** le lecteur natif renvoie le contrat et sa provenance. Dans cette fixture, `working/active-change.sem` était une copie exacte du contrat commité ; égalité des octets vérifiée, sans parser `.sem` maison. Une modification de cet overlay a été refusée.
- **Consommateur jetable :** conserve ces observations en mémoire, vérifie l'identité de la sortie capturée, compare les entrées natives et le candidat/base puis conserve le verdict. Aucun nouveau format persistant, cache universel ou ledger ; aucun `landPr` modifié.

#### Contre-exemples exécutés

| Cas | Observation réelle |
|---|---|
| Même candidat et mêmes entrées, puis seconde consommation | `applicable`, verdict natif `VERIFIED`, lifecycle `active` ; zéro appel de producteur ou runtime |
| Autre candidat sélectionné / autre base sélectionnée | Refus pour identité de candidat / base différente |
| Checkout local positionné sur l'ancien candidat | Refus ; état natif `STALE`, heads et modèle différents |
| Code modifié sans changer HEAD | Refus ; `STALE`, `analysisInputHash` et `workingDiffHash` différents |
| Obligation sémantique modifiée sans changer HEAD | Refus ; `STALE`, `semanticModelHash` et `workingDiffHash` différents |
| Configuration valide mais politique modifiée | Refus ; `STALE`, `analysisInputHash` et `workingDiffHash` différents |
| Configuration présente avec version invalide | Refus ; `CONFIG_INVALID`, exit 1 ; aucune exemption « Semctx absent » |
| Contrat actif ignoré modifié, Git toujours propre | Refus ; `UNSEALED`, raison native `SEMANTIC_LIFECYCLE_INVALID` |
| Entrées restaurées exactement | Réemploi positif rétabli sans nouvelle production |
| Résultat manquant / JSON illisible / faits d'invocation absents | Refus distincts, sans appel producteur |
| Sortie remplacée ou lifecycle réécrit | Refus : ce ne sont plus les octets réellement acquis |
| Preuve exigée laissée `declared` sur le candidat PARTIAL | Producteur : exit **0**, verdict **PARTIAL**, gap nommé `proof.admission-behavior` |
| Consommation de ce PARTIAL | PARTIAL conservé ; refus dans cette fixture sans justification NO TEST, aucune promotion automatique |
| Remplacement de PARTIAL par VERIFIED dans la sortie | Refus de provenance |
| Tentative native de clôture du PARTIAL, hors consommation | Exit 1, `INVALID_TASK_INPUT`, lifecycle demeure `active` |

Les appels émis par le consommateur ont été observés : uniquement `status`, `semantic inspect` et lectures Git ; aucune commande d'analyse/indexation, aucun test et aucun appel LLM dans ce chemin. Cela ne signifie pas zéro calcul : les lecteurs natifs relisent et calculent leurs empreintes. Aucune économie de tokens ou de temps n'a été mesurée.

Deux distinctions découvertes par la sonde restent explicites : `status` peut retourner un JSON `STALE` exploitable avec exit **3** — ce n'est pas un JSON illisible ; un ancrage d'invariant au seul fichier a produit `untouched` avec footprint vide dans cette installation, tandis que l'ancrage canonique au symbole réel a produit `proved`. La preuve positive utilise ce second cas et n'affirme pas une couverture générale des formes d'ancrage.

#### Limites conservées pour l'étape 2

- **Pas de liaison atomique démontrée.** La fixture n'avait qu'un writer contrôlé. Des empreintes identiques avant/après ne prouvent pas l'absence d'une modification transitoire puis restauration pendant les lectures du producteur.
- **Pas de reprise durable démontrée.** La conservation privée des sorties et des faits d'invocation était en mémoire. Le transport/conservation dans le dossier existant et l'autorité de ces observations après reprise doivent être définis ; un JSON arbitraire ou une phrase dans la PR ne suffit pas.
- **Pas de complétude universelle des dépendances.** Les empreintes natives et les entrées runtime connues suffisent au cas fermé exercé. Dépendances externes, environnement mutable, configurations ignorées supplémentaires et worktrees liés ne sont pas certifiés par cette sonde.
- **Pas de politique PARTIAL livrée.** Le cas conserve le résultat natif et démontre le refus de clôture, pas l'admission d'un PARTIAL justifié avec toutes les règles NO TEST/assertledger de #768.
- **Pas de livraison produit.** Aucun parcours `landPr`, transport GitHub réel, sélection de PR, arm/disarm, CI, reprise `/fix` → `/feature`, commit/push du plugin ou réinstallation n'a été exercé.

**Décision permise par cette preuve :** poursuivre le cadrage côté `roxabi-plugins` avec les lecteurs publics actuels ; ne pas imposer une PR Semctx comme prérequis. L'étape 2 doit rendre concret le protocole d'acquisition/conservation sans affaiblir #768. Étapes 2–5 toujours non lancées.

- 2026-10-09, fin de sonde : dépôt jetable et fichiers générés supprimés après observation. Les SHA ci-dessus identifient les candidats historiques de cette fixture, pas des commits accessibles dans `roxabi-plugins`. Cette todo et ses résultats restent sur disque, sans commit ni push. Aucun fichier du plugin, cache installé, configuration du dépôt principal ou état GitHub modifié.

### 2026-10-09 — étapes 2–5 autorisées ; arrêt sûr au préflight #737

**État courant prioritaire : arrêt de sûreté, pas livraison.** L'instruction opérateur de cette session autorise les étapes 2–5 et remplace les mentions historiques « en attente d'autorisation ». Le texte et les observations antérieurs restent conservés intégralement ; aucune ancienne preuve n'est promue en preuve produit actuelle.

| Étape | Dernier état | Travail conservé / limite |
|---|---|---|
| 1 | Acquise, non rejouée | CLI installé toujours `0.4.2`, hash du bundle identique ; limites historiques inchangées |
| 2 | Cadrage partiel ; bloqué par #737 | Issues et dépendances natives relues ; matrice exhaustive préparée ; protocole concurrent/durable pas finalisé |
| 3 | Autorisée, non commencée | Le préflight interdit l'implémentation d'un ticket avec blocker ouvert |
| 4 | Autorisée, non commencée | Aucun chemin produit modifié ; smokes d'admission/conservation/reprise toujours dus |
| 5 | Arrêt documenté, aucune PR | Aucun commit/push/merge ; critères et dépendance préservés dans le tracker |

#### Observations actuelles, distinctes des preuves de fixture

- Worktree de livraison : `/home/mickael/.omp/wt/roxabi-plugins/768-semctx-proof-admission`, branche `fix/768-semctx-proof-admission`, HEAD `70d753bacff708145111c8d8bd6ffc3c807c26d8`. Le principal et `refs/heads/main` distant ont retourné ce même SHA. L'état Git initial n'avait aucune modification utilisateur ; rien n'a été déplacé, stashed ou nettoyé.
- Le consommateur réel `resolveEntry` a retourné `action: build`, `ticket: 768`. Cela valide le worktree/branche, pas la disponibilité des dépendances. Feature §3.1 prévoit de continuer dans le worktree correspondant sans nouvelle création ni nouveau `/move` ; aucun ancien transcript `/move` n'est certifié.
- APIs natives : `#768 blocked_by → #737 OPEN` ; `#737 blocked_by → #734 CLOSED`. Feature §§5 (280–290) et 6.0 (299–306) imposent l'arrêt avant implémentation. L'edge reste présent, aucun critère ni ticket n'a été fermé artificiellement.
- CLI public installé : `0.4.2`, SHA-256 du bundle `ee7a4626a4b395757c5d989cfb0db60bdeb202d4354c7f922539741043a46ca8`. La sonde précédente n'a pas été rejouée : le bundle n'a pas changé ; aucune nouvelle preuve native de production n'est revendiquée.
- GitHub a retourné `[]` pour les PR de cette branche et le vrai `resolveReviewPr` a retourné `null`. **Désarmement non applicable : aucune PR sélectionnée, aucun gate OPEN à effacer.** Aucun `disarmed: true` n'est inventé. Les anciennes PR arrêtées restent intactes.

#### Blocker exact et arbitrage

Ce n'est pas uniquement un statut GitHub obsolète. Dans les sources courantes, `plugins/omp-build/skills/fix/falsification.md:37-54` émet encore `pass` lorsque la falsification est sautée et agrège les gaps de couverture comme pass. `plugins/omp-build/skills/dev-review/root-causes.md:33-39,56-58` garde le bloc mechanism/fix/findings sans failure/restored/paths/proof, puis sélectionne Solution 1. Le consommateur fix Phase 4 reste pass/fail. Ces directives attestent un contrat partagé non migré ; elles ne sont pas présentées comme un incident runtime reproduit ici.

#737 possède la preuve comportementale commune, le plan unique et la distinction skip/pass ; #768 doit les consommer, pas recréer leur moteur. La disparition de blocker via `Root causes: none` n'est pas répétée comme défaut actuel : le fix courant lit déjà Findings et conserve les uncited blockers. #734 est observée fermée, sans nouvelle certification de son issue entière.

Le scout et l'avis indépendant `R-architect` confirment cette frontière. Ce sont des investigations read-only, pas une revue de candidat : aucun marqueur de revue ni round de correction n'a été consommé. Importer les émetteurs, confiance, recall, formats/fichiers fix et tout le walk causal de #737 serait une extension substantielle, pas un détail d'admission #768. Reprise possible après livraison réelle de #737, ou arbitrage humain explicite du sous-périmètre prerequisite et de sa séquence de PR/dépendances. Pas de doublon, pas de retrait artificiel d'edge, pas de fermeture par proximité, pas de lancement de #720.

#### Dossier de reprise

- Matrice : `artifacts/plans/768-semctx-omp-build-integration-matrix.md` dans le worktree de livraison. Elle couvre AC1–AC10 et les obligations additionnelles de cette instruction : acquisition durable/concurrente, dépendances pertinentes, `/fix`→`/feature`, redondances locales et livraison.
- Cette todo a été copiée intégralement dans ce worktree avant ajout du présent journal. La source principale et la copie conservent la même histoire ; la matrice distingue travail prévu et observations exécutées.
- #768 a reçu un appendice d'exécution via le propriétaire `issue-triage set --body-file` ; le corps précédent et tous ses critères ont été conservés. High/F-lite et κ=5 inchangés : aucun nouveau périmètre d'acceptation. #737 reste ouverte, #734 reste fermée.
- PR / nouveaux commits de livraison : **aucun**. Aucun plugin, cache installé ou configuration Semctx modifié ; aucune installation, release, merge ou suppression de worktree. Aucun build/lint/test d'intégration exécuté : aucune implémentation n'a commencé.
- Avant reprise : relire base distante, dépendances, sources et PR sélectionnée ; finaliser le protocole d'acquisition avant code. Pré/post hashes seuls ne prouvent pas l'absence de modification transitoire/restauration ; une liaison concurrente inconnue reste un refus, jamais une exemption. Conservation durable et liaison aux entrées réellement consommées restent à prouver.

### 2026-10-11 — reprise ; étapes 2–4 réalisées sur la branche

- Prérequis : #737 fermée par PR #774 (merge `2c44cc10`) ; branche `fix/768-semctx-proof-admission` repartie de cette base. Semctx 0.4.2 relu, bundle inchangé. Protocole d'acquisition fixé dans la matrice **avant** le code.
- Implémentation : `proof.ts` (lecteurs d'admission : `candidateFacts`, `readSemctxRecord`, `justifyGaps`, `readAssertledgerRecord`, `admitLanding`), `proof-acquire.ts` (seul producteur : clone privé `--shared --no-checkout` détaché à C, réutilisation d'un record encore lié), `landPr` admet après la résolution du landing et avant tout arm (`proof-blocked` via l'épilogue forcé-désarmé existant ; `watching` porte `proof`), epic `proof-blocked` → ticket stop. `proof-gate.ts`, sa suite et le pin de wording `ui-proof.test.ts` supprimés. Skills feature 0.1.2 / dev-review 0.2.1 / fix 0.3.1, README plugin + racine, GLOSSARY, ADR-024, omp-build 0.9.13.
- Preuves actuelles (matrice § Implementation evidence) : `proof.integration.test.ts` 38 cas sur le vrai `landPr` forké, records réels conservés (`capture.ts`, shas reconstruits octet pour octet) ; `proof.test.ts` 55 cas des lecteurs ; smokes jetables reuse (`posted` puis `reused`, 0 appel producteur) et marche `/fix`→`/feature` (C1 admis → fix C2 → `head-moved` → `proof-blocked missing` → acquire C2 → `reused` → `watching` VERIFIED, 0 appel producteur à l'admission). Après les derniers writers : `bun run test` 132 fichiers / 4025 tests verts, `typecheck`, `lint`, `check-skill-version.sh` exit 0.
- Décisions et limites : matrice § Decisions and limits (racine `.semctx` seule, tip local = candidat, manifests kit `verify` non liés, fenêtre d'acquisition, recommandation CI `semctx-working-empty` conservée faute d'équivalence).
- Reste : étape 5 (PR, revue, fix borné, admission + landing, clôture #768 si complète).

### 2026-10-11 — deux rounds de correction conservés ; arbitrage avant dernière revue

- PR unique [#776](https://github.com/Roxabi/roxabi-plugins/pull/776), base native `main@2c44cc10c21ab278fa7e0f668518d211cbf4ebb1`. [Review 1](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6110812277), [reçu r1](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6111687026), [review 2 Request changes](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6112206661) sur `3843c2ce5be85c8060997270449a3d94250da5c9`. La borne reste MAX_FIX_ROUNDS=2 ; aucune troisième revue lancée ni remise à zéro.
- R2 appliqué inline, une cause par commit : RC-1 `e66125ed` ré-admission des entrées mutables ; RC-2 `c7878648` nom/tip de base sélectionnée ; RC-3 `f4ebe895` base fraîche immuable avant politique/applicabilité ; RC-4 `d810d5d4` octets privés exacts assertledger ; RC-5 `c1c01bf5` publication/révision de chaque part PARTIAL avant approbation. Les cinq falsifications ont réellement rendu leurs contre-exemples rouges ; aucun skip renommé pass.
- Smokes réels bornés : assertledger 1.4.0 invalide A/valide B et substitution du chemin exporteur ; Semctx 0.4.2 a réellement produit le PARTIAL deux parts ; CLI landing tardif → refus/clearing → nouvelle approbation du même C → PARTIAL admis → première part révisée → refus/clearing, zéro producteur. Les dates de ce smoke passent par le transport GitHub simulé, pas par une fausse attestation GitHub vivante. Matrice complète dans `768-semctx-omp-build-integration-matrix.md`.
- Après derniers writers : lint sans diagnostics, typecheck, 132 fichiers / 4 185 tests verts. Hooks commit lint/typecheck/TruffleHog/commitlint verts ; licence/taxonomie Python SKIP faute de `.venv`, pas pass. Un seul push r2 par `disarmReviewedBeforePush` : barrier `{}` sur gate déjà clair (aucun `disarmed: true` inventé), hooks pre-push intacts, 4 185 tests verts encore. Candidat distant `c1c01bf5433037ccf7edc5db685648480d19c07f`. [Reçu immédiat](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6113842464).
- CI indépendante du même C : [run CI 38175647535](https://github.com/Roxabi/roxabi-plugins/actions/runs/38175647535), job `ci` success ; les cinq runs observés sont verts. PR observée OPEN, labels `[]`, autoMergeRequest `null`. Aucun label review-driven ni arm. Semctx absent du dépôt réel : MCP `CONFIG_NOT_FOUND`, aucun setup/index/PASS/VERIFIED fabriqué.
- Deux uncited blockers conservés intégralement via issue-triage : [#779 observation navigateur](https://github.com/Roxabi/roxabi-plugins/issues/779), [#778 vérité NO TEST](https://github.com/Roxabi/roxabi-plugins/issues/778), chacun F-lite/High/fix, sibling sous #720, blocked-by origine #768, sans cycle inverse. Ils bloquent toujours #768/#776 ; filing n'est pas résolution ni défer nonblocking. Le défer r1 #777 reste inchangé.
- Limite exacte : les interfaces publiques Semctx 0.4.2 examinées n'établissent pas de producteur supporté d'observation navigateur liée au gap/candidat ; `proved` dérive les statuts authored, pas une exécution runtime. Un type RUNTIME_OBSERVED/verifier read-only n'est pas un producteur démontré. L'enum NO TEST et la narration ne prouvent pas non plus la vérité des raisons. Nonblank Why, marqueur ou grep ne remplacent aucun oracle accepté.
- Prochaine décision humaine, avant la dernière revue : conserver l'observation native exigée par #768 AC5 et nommer sa source supportée manquante, ou autoriser explicitement un plafond de confiance reviewer proof-aware pour observation/vérité et amender le contrat via issue-triage. Aucun scope upstream/Semctx/cache n'est inféré. Ensuite seulement : review du C courant → landing existant → merge/CI/clôture vérifiés. #768 n'est pas livrée et l'objectif demeure actif/bloqué.

### 2026-10-11 — arbitrage humain appliqué, pas un correctif d'oracle

- Choix explicite : « Autoriser le plafond reviewer ». [Enregistrement par gh authentifié opérateur](https://github.com/Roxabi/roxabi-plugins/issues/768#issuecomment-6114046814), ni attestation native ni reset. Le contrat #768 a été amendé via issue-triage et relu identique au fichier autorisé.
- #779/#778 CLOSED **NOT_PLANNED**, état/reason/body natifs vérifiés ; seule leur AC2 d'approbation est satisfaite, AC1/AC3 non livrées. Raw findings/provenance restent complets. [Disposition #779](https://github.com/Roxabi/roxabi-plugins/issues/779#issuecomment-6114141139), [disposition #778](https://github.com/Roxabi/roxabi-plugins/issues/778#issuecomment-6114141707).
- Admission garde binding/policy/enum/e2e/form/chronologie. La revue proof-aware juge le support positif de la vérité NO TEST et de la performance crédible du browser check, et bloque sans support. Approval/dates/body/VERIFIED ne certifient pas le gap ; une invention acceptée par ce reviewer trusted n'est pas indépendamment détectée.
- README racine/plugin, skills feature/dev-review, GLOSSARY, ADR-024, matrice et body PR alignés ; aucun nouveau code runtime/test/oracle. Prochaines actions : commit/push sans arm → CI du nouveau SHA → unique dernière revue indépendante → landing existant seulement si les gates passent. #768 non livrée ; objectif actif.

### 2026-10-12 — candidat amendé publié, contrôles et dernière revue

- Docs-only : `e1fa6bd0` plafond autorisé, `4e139a50` conserve la condition `ui-manual-only`, `3f8c56d4` corrige seulement le commentaire d'acquisition PARTIAL (pas de logique runtime). Chaque push a appelé `disarmReviewedBeforePush` réel ; `{}` = gate déjà clair. Hooks intacts ; suite finale 132 fichiers / 4 185 tests, lint 246 fichiers sans corrections/diagnostics, typecheck vert.
- CI du SHA `3f8c56d48560a9dc77a93400e8227154fc83a1e1` : les quatre runs sont verts, [required ci 38178271688](https://github.com/Roxabi/roxabi-plugins/actions/runs/38178271688). Native PR OPEN, labels `[]`, autoMergeRequest `null`.
- CLI réelle `proof-acquire.ts --pr 776` sur ce SHA : Semctx et assertledger `not-applicable`. Ni VERIFIED ni detection revendiqués pour le dépôt. Applicabilité native, pas une preuve de producteur applicable.
- Body PR aligné avant revue via issue-triage, source concurrente comparée avant écriture. Preflight réel `nextReviewStep(...,{reviewing:true})` → `review/head-moved/reviews:2`. Diff GH pris avant/après sur le même SHA ; 34 fichiers, snapshots immuables. Chunker/roster natifs : cinq chunks, sept agents indépendants, aucun capped/warning ; R-adversarial partout, architecte structural chunk4, tester chunk5.
- Dossier local intégral : `/tmp/omp-build-final-review-776-M9tTSF/`. La prochaine revue marquée sera l'unique record composé de cette revue, sans verdict prédéterminé. Landing existant seulement si ce verdict et tous les gates autorisent ; #768 reste OPEN/non livrée.

### 2026-10-12 — arrêt sûr : troisième revue rouge, borne épuisée

- [Review 3](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6114522205) postée par `MickaelV0`, corps relu identique, marqueur et SHA `3f8c56d48560a9dc77a93400e8227154fc83a1e1` vérifiés. Verdict : Request changes, trois blockers.
- `nextReviewStep` après publication : `stop`, raison `review-bound`, `reviews: 3`. Aucune correction, aucun landing, aucun producteur, aucun reset. PR native relue OPEN, labels `[]`, autoMergeRequest `null`, mergeStateStatus `CLEAN`. #768 relue OPEN.
- Blockers résiduels : refresh natif post-pin peut transférer l'arm (`workflow.js:766`) ; README racine attribue la ré-admission à toutes les sorties retenues (`README.md:65`) ; ADR/GLOSSARY/README plugin disent qu'un record éditable atteste la sortie producteur (`ADR-024:145`).
- [Dossier d'escalade](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6114528754) publié séparément et relu identique. Options humaines : nouvelle PR de diagnostic, nouvelle PR de design, ou fin manuelle. Cette PR reste ouverte comme preuve. Livraison non revendiquée.

### 2026-10-12 — choix opérateur : nouvelle PR de diagnostic (superseding)

- Choix humain explicite parmi les options du dossier : « nouvelle PR de diagnostic ». Cela remplace « une seule PR » de l'objectif pour la livraison de #768. La borne de #776 n'est pas réinitialisée. #776 reste OPEN et non armée, comme preuve, jusqu'à ce que l'opérateur la ferme.
- #768 amendée via issue-triage (`set --body-file`, source relue identique avant écriture, lecture post-écriture identique), section « Superseding diagnostic plan — 2026-10-12 ». Scope et design inchangés, aucun AC retiré.
- Plan : D1 reproduire le transfert post-pin H→H2 (réel consommateur), y compris les écritures sœurs ; D2 observer la rétention des observateurs sans relecture d'admission ; D3 observer l'admission d'un record édité PARTIAL→VERIFIED et d'un record assertledger édité. Correction à la couche observée : D1 code `workflow.js` avec régression rouge/verte ; D2/D3 wording NO TEST prompt-logic-only. Balayage des sœurs par classe.
- Worktree `/home/mickael/.omp/wt/roxabi-plugins/768-semctx-proof-admission-v2`, branche `fix/768-semctx-proof-admission-v2` créée depuis `origin/main` `2c44cc10` (fetch frais, base propre). Fichiers locaux non commités copiés à l'identique (`cmp`). Ensuite : `/move`, puis ré-application ordonnée des 20 commits #768 de #776 (nouveaux SHA, AC10), D1–D3, corrections, nouvelle PR, `/feature`.
- Cartographie D1 en lecture seule (code identique à `3f8c56d4`) : `afterWrite('native')` (`workflow.js:766`) appelle `refreshReviewAuthorization()` sans `retaining`, après le pin. La garde `records.head !== admitted` (782) ne s'exécute donc pas, et `admit()` réécrit `admitted` (759). Appelants de la refresh : 766 (post-pin, seul appel non-retaining après une écriture d'arm), 863/891 (avant écriture), 871 (après le retrait du label merge-on-green), 929 (re-pin après désactivation de l'ancien arm, ré-admission voulue RC-9), 966 (épilogue retaining). Hypothèse de correction, à confirmer par la reproduction rouge : la refresh post-écriture retient la tête armée. Rien n'est implémenté avant `/move`.

### 2026-10-12 — v2 : ré-application, D1–D3 reproduits et corrigés, contrôles

- `/move` fait ; préflight §6.0 : `resolveEntry` → build, `resolveReviewPr` → null, #737 fermée, #768 OPEN, `origin/main` = `2c44cc10`, bootstrap noop.
- Ré-application ordonnée `2c44cc10..3f8c56d4` : 20 commits, nouveaux SHA (dernier `7713b9bd`), `git diff --stat 3f8c56d4 HEAD` vide. Avant tout changement : biome propre, `tsc` propre, 132 fichiers / 4185 tests verts.
- **D1 (code)** reproduit : `landPr` natif, H approuvée et pinée, la PR passe juste après le pin à H2 approuvée → `watching` (H2 ré-admise sous le pin de H). Correction : `afterWrite('native')` appelle `refreshReviewAuthorization(true)`. Après : `not-approved`/`head-moved`, gate effacé, un seul pin (H), 0 producteur ; contrepartie admissible `watching` sur H dans les deux modes. Annuler seulement la correction fait échouer seulement le cas pin natif ; label natif et merge-on-green étaient déjà refusés.
- **D2 (docs, NO TEST prompt-logic-only)** observé (`/tmp/omp768-d2`) : après arm, base retargetée ; `applyCiWatchExit` 5/0 et `nextReviewStep` `land` conservent les arms, 0 lecture de base, 0 producteur ; `landPr` refuse et efface. README racine corrigé : seuls les checkpoints et l'épilogue de `landPr` ré-admettent.
- **D3 (docs, NO TEST prompt-logic-only)** observé (`/tmp/omp768-d3`) : PARTIAL révisé après approbation → `unjustified` ; PARTIAL édité après approbation en VERIFIED → `watching` VERIFIED ; WEAK_ORACLE édité en détection → `watching`. 0 producteur. ADR-024 (bannière comprise), GLOSSARY, README plugin, README racine, matrice : un record atteste le corps courant de son commentaire ; seule la chronologie PARTIAL est liée.
- Non bloquants round 3 : ligne `proof-blocked` (arm écrit puis effacé) ; branche `bad-landing` morte supprimée (`landingBase` toujours posé par `bindBase`), prose alignée sur l'effacement forcé ; ADR (numérotation bannière, CI attendue par le watch, entrée Negative) ; matrice (protocole marqué superseded, attribution des candidats, section v2) ; régressions `refreshSelectedBase` (base en forme d'option) et `mergeBaseOf` (échec/vide), chacune rouge contre son mutant. Clé catalogue : défaut de processus préexistant hors #768, non traité.
- Version omp-build 0.9.13 → 0.9.14 (`package.json` + `.omp-plugin/marketplace.json`) : 0.9.13 reste tenue par la branche ouverte de #776 avec un autre arbre.
- Après les derniers writers : `bun run lint` (246 fichiers), `typecheck`, `bun run test` 132 fichiers / 4196 tests verts ; `check-skill-version.sh` exit 0.
- Revue de plan §6.1 (R-architect + R-adversarial, lecture seule, un round) lancée avant commit : le code est une ré-application plus des corrections de diagnostic, revue faite a posteriori du code mais avant PR.

### 2026-10-12 — #781, correction r2 complète en local ; vérification finale

- [Review 2](https://github.com/Roxabi/roxabi-plugins/pull/781#issuecomment-6120629290) : Request changes sur `ca4ac43ff414700369a53791c2c16a6b5ed3e223`. Neuf causes appliquées inline, sans reset de la borne ; la prochaine revue sera la troisième, approbation ou arrêt sûr.

| Cause r2 | Commit | Couche corrigée |
|---|---|---|
| RC-1 | `627eb5de` | Publication Semctx non éditée, tous verdicts |
| RC-2 | `da99a3af` | Intégrité/reuse assertledger |
| RC-3 | `b9462503` | Catalogue : plafond de confiance, pas d'attestation |
| RC-4 | `97d6e7d2`, `5b781844` | Attribution historique et actuelle de la matrice |
| RC-5 | `7a02323a`, `2541f83b` | Entrées exactes lues par la revue ; migration des tests |
| RC-6 | `691ec68e` | Six bindings natifs testés indépendamment |
| RC-7 | `cc6113d4` | CI déclarée ≠ enforcement GitHub observé |
| RC-8 | `2eb1e855` | Identité origin/dépôt sélectionné, URL exacte fetchée |
| RC-9 | `0f13114b` | Frame JSON native finale, pas les fences du résumé |

- Falsifications : les six causes de code ont donné leurs contre-exemples rouges avec restauration `finally`. RC-3/4/7 restent **NO TEST prompt-logic-only, skipped**, jamais pass. Détails et sorties conservés dans la matrice.
- Dernier writer du candidat : `2541f83b33e23188e8a7c1478bf969e5e21038bb`. Le run précédent sur `5b781844` a donné 4 246 pass / 2 failures, tous deux des pins de prose obsolètes ; les deux fichiers purement source/prose ont été supprimés, pas re-pinnés. Suite complète/lint/typecheck/version gate de ce dernier SHA en cours, pas encore revendiqués verts.
- Six smokes post-writer exit 0 : acquisition/reuse Semctx et assertledger réels ; body exact revue/pre-post/landing ; six bindings ; fork origin refusé et arms effacés ; fences de résumé sans substitution et frame manquante refusée. Producteurs : 0 à l'admission. GitHub/attaques sont des transports simulés déclarés ; pas d'attestation GitHub vivante. Sortie complète `artifact://1907`, scripts `/tmp/omp768-r2-smoke-W72spT/`.
- [#783](https://github.com/Roxabi/roxabi-plugins/issues/783) conserve toute la section Warning r2 et sa provenance, parent #720 / blocked-by #768 / F-lite / P3 ; recoupements #782 et #777 restent ouverts. MCP Semctx : `REPOSITORY_ROOT_MISMATCH`, CLI locale : `CONFIG_NOT_FOUND` ; aucun setup/index ni PASS fabriqué. Aucun push r2 ni arm demandé à ce checkpoint ; #776 reste hors automatisation, #768 non livrée.

### 2026-10-12 — r2 publié ; revue 3 indépendante liée au SHA

- Candidat `2541f83b33e23188e8a7c1478bf969e5e21038bb` : lint 244 fichiers sans correction/diagnostic, typecheck vert, version gate exit 0 (Claude SKIP ; avancement catalogue OMP vérifié), **130 fichiers / 4 231 tests verts**, 0 fail/pending/todo. Les six smokes post-writer sont verts ; aucun producteur à l'admission.
- Push unique via `disarmReviewedBeforePush` → `{}` (déjà clair, pas un reçu de désarmement). Hooks intacts, TruffleHog 0 secret, suite encore 130 / 4 231 verte. SHA distant relu identique, PR OPEN, labels `[]`, autoMergeRequest `null`. [Reçu r2 complet](https://github.com/Roxabi/roxabi-plugins/pull/781#issuecomment-6123540475), body PR relu octet-identique après écriture.
- Acquisition CLI du source courant pour #781 : Semctx/assertledger `not-applicable` ; aucun résultat producteur inventé. Préflight `nextReviewStep(...,{reviewing:true})` → `review/head-moved/reviews:2`. Diff PR pris avant/après sur le même SHA ; 37 fichiers immuables. Capture native : `{ok:true,input:null,body:null,semctx:null,assertledger:null}` pour genuine absence ; aucun marqueur d'input fabriqué.
- Chunker natif : cinq chunks ; allocation unique F-lite, sept agents exacts, max 3/chunk, capped/warnings vides. R-adversarial sur chaque chunk, R-architect structural sur ADR, R-tester sur plugins ; revue read-only, sans tests/edits/recursion. Dossier `/tmp/omp-build-review3-781-MMcEO7/`. Verdict pas encore composé.
- CI réelle du même SHA : [ci 38244037654](https://github.com/Roxabi/roxabi-plugins/actions/runs/38244037654) SUCCESS. Endpoint protection classique 404 ; endpoint effectif rules/branches/main établit ruleset `13715174`, required `ci` strict, PR obligatoire et merge seul. Les deux jobs auxiliaires SKIPPED restent des skips. Aucun landing avant verdict.

### 2026-10-12 — #781 : troisième revue rouge, arrêt sûr canonique

- [Review 3](https://github.com/Roxabi/roxabi-plugins/pull/781#issuecomment-6124561786), auteur `MickaelV0`, SHA `2541f83b33e23188e8a7c1478bf969e5e21038bb`, corps natif relu identique : **Request changes**, 6 blockers / 17 warnings / 9 suggestions. 40 émissions originales → 32 unions même défaut ; aucun trigger de recall. Trois causes docs planifiées, NO TEST skips ; 20 autres actionable restent sans plan sûr, pas supprimés.
- Publication : comparaison head et `validateReviewInput(null)` → ok, genuine absence. Une erreur de forme du verdict a donné `read null` ; correction uniquement de la grammaire **dans le même commentaire** (pas de nouveau record/reset), puis owner source courant `nextReviewStep(posted)` → **stop / review-bound / reviews:3**. Aucune correction code après cette revue, aucun arm/landing/merge.
- Blockers : matrice historique encore normative (130/118) ; détection post-watching sur-promisée (ADR173 et sœurs) ; applicabilité devenue absente qui ignore le binding déjà revu (proof1600/1604/1643) ; disclosure corps courant/repost/acquisition du README racine ; préconditions de capture transformées en verdict rouge compté ; risque de réarmement par job GitHub `reviewed` retardé après clearing. Ce dernier timing est une **hypothèse non exercée**, pas une observation native.
- [Dossier d'escalade](https://github.com/Roxabi/roxabi-plugins/pull/781#issuecomment-6124620605) : mécanismes récurrents r1/r2/r3, défauts induits/limites, hypothèse L+1 et observations discriminantes, exactement trois routes humaines (nouvelle PR diagnostic, nouvelle PR design/scope, finition opérateur manuelle). Dossier complet `/tmp/omp-build-review3-781-MMcEO7/` ; anciens nonbloquants #783/#782/#777 conservés.
- Read-back natif d'arrêt : #781 **OPEN**, head inchangée, labels `[]`, autoMergeRequest `null`, CLEAN ; #768 **OPEN/non livrée**. Déjà clair ≠ `disarmed:true`. CI required et 4 231 tests verts ne lèvent pas ces blockers. #776 reste hors automatisation. Autorité humaine manquante pour toute suite ; objectif non complété, aucune clôture #768.

### 2026-10-12 — Décision opérateur (route 3) : clôture et merge de #781

- Décision humaine explicite dans cette conversation : option 2 recommandée = un commit de clôture des 6 blockers, puis merge par l'opérateur sans 4e revue automatisée. Ce merge relève de l'opérateur ; ce n'est ni une revue approbatrice ni une admission `landPr`.
- Commit `68653c1a` : B3 code — `admitLanding` refuse `candidate`/`unbound` si l'approbation porte un marqueur ligne 3 et qu'aucun producteur ne s'applique au landing (ligne unitaire + vrai `landPr` : ticket Bug approuvé avec détection → reclassé feat → `proof-blocked`, non armé, 0 producteur ; re-revue même tête → `watching`). Garde retirée → les deux lignes échouent. B5 : un refus de capture ne publie rien et ne compte pas (dev-review Phase 2/8, feature §6.4). B1/B2/B4 : matrice, ADR-024, READMEs, feature §6.3 (NO TEST — prompt-logic-only).
- B6 non reproduit, nommé dans ADR/README, suivi [#787](https://github.com/Roxabi/roxabi-plugins/issues/787) (fix, P1, parent #720, bloqué par #768). 26 non-bloquants r3 → [#786](https://github.com/Roxabi/roxabi-plugins/issues/786) (P3). Aucun déclaré corrigé.
- Contrôles après le dernier writer : lint 244 fichiers, typecheck, version gate exit 0, **130 fichiers / 4 233 tests** (local et pre-push). `ci` requis [38257304960](https://github.com/Roxabi/roxabi-plugins/actions/runs/38257304960) SUCCESS sur `68653c1a`. Avant merge : labels `[]`, auto-merge `null` (le job « Enable auto-merge » n'a pas armé).
- Merge `gh pr merge --merge --match-head-commit 68653c1a` → `07c6e54271536a0a1bdd92760a692b9044fd8d36` (MickaelV0, 13:45:11Z). `origin/main` = ce SHA, omp-build 0.9.14 au catalogue. #768 CLOSED/COMPLETED via `Closes #768` ; [commentaire de clôture](https://github.com/Roxabi/roxabi-plugins/issues/768#issuecomment-6125560644) avec résidus ; [reçu PR](https://github.com/Roxabi/roxabi-plugins/pull/781#issuecomment-6125561041).
- Limites conservées : AC7 « zéro nouvel arm » hors sortie `landPr` dépend de #787 ; #776 reste ouverte comme preuve (non reprise) ; #777/#782/#783 ouvertes. Pas de release, réinstallation ni nettoyage de worktree.

### 2026-10-12 — Post-merge : installation OMP et nettoyage (autorisés par l'opérateur)

- Checkout principal fast-forward sur `07c6e542`. OMP : le link dev `omp-build@0.9.16` (worktree `fix-local-pre-review`, arbre = #785, sans #768) est remplacé par `omp-build@roxabi-marketplace` 0.9.14 (cache identique à `plugins/omp-build` de main, `diff -rq` vide ; doctor 5 ok). Un restart OMP est requis.
- #776 est fermée comme superseded par #781 ; sa branche reste sur origin. Les worktrees 768 (v1, v2), 720, 744, 737, `/tmp/ob-main` et `fix-local-pre-review` sont supprimés, ainsi que les branches locales correspondantes et `chore/772` ; `remote prune` a été lancé. Les deux artefacts de préflight sont copiés ici. Les 98 dossiers scratch `/tmp/omp768*` et `/tmp/omp-build-*` sont supprimés, sauf ceux de #785 (session concurrente).
- La copie worktree de cette todo différait d'une ligne (compte 4025/4026) ; seule cette copie principale est conservée. Les worktrees `784-local-fix-pre-review` (#785) et `quiet-test-child-stderr` (#684) n'ont pas été touchés.
