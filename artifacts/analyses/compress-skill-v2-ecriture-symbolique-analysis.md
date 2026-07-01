# Analyse — compress v2 : de la compression 1:1 à l'écriture symbolique (PoC roxabi-cortex)

**Date** : 2026-07-01 · **Branche** : `worktree-compress-skill-analysis` (depuis `origin/staging`)
**Méthode** : workflow 15 agents — 5 lecteurs corpus (skill+usage, roxabi-cortex, vault, grammaire SSOT, recherche externe) → 3 designers (lentilles : fidélité sémantique / intégration cortex / DX produit) → synthèse → 6 vérifications adversariales. Toutes les affirmations chiffrées ci-dessous ont survécu à la vérification ou ont été corrigées par elle.

**Objectif** : faire du skill `compress` le proof-of-concept de la couche « écriture symbolique » de roxabi-cortex — y compris le **réflexe de dérivation** (monter d'un niveau d'abstraction : instances → patterns → principes) — avant que l'implémentation cortex ne démarre.

---

## 1. Constat — le skill aujourd'hui

`plugins/compress/skills/compress/SKILL.md` — 73 lignes, réécriture 1:1 mono-fichier :

| Dimension | État | Référence |
|---|---|---|
| Cible | 1 seul fichier, chemins `.claude/{agents,skills}/` hardcodés — ignore le layout marketplace de son propre repo (violation Design Principle 1) | SKILL.md:25 |
| Règles | R1–R10, toutes intra-fichier, aucune dérivation ni extraction cross-file | SKILL.md:30-45 |
| Métrique | lignes uniquement (`L_before → L_after`) ; le « 30-60% » du README n'est mesuré nulle part | SKILL.md:27,49,51 · README.md:7 |
| Vérification | auto-affirmée (« Verify: ¬semantic loss ») — pas de round-trip, pas d'agent lecteur indépendant (`Task` ∉ allowed-tools) | SKILL.md:51,6 |
| Niveaux | binaire (« already formal → tweaks only » · « L<30 → warn ») | SKILL.md:57-58 |
| Glossaire | table de symboles locale, en conflit avec 2 autres légendes du repo | SKILL.md:21 |
| Exemple R1 | contredit les conventions maison (φ:=findings vs φ=frame ; τ:=80 vs τ=tier ; γ(f) vs C(f)) | SKILL.md:32-36 vs frame:17, code-review:27 |
| plugin.json | existe (`.claude-plugin/plugin.json` : name/description/author) mais sans bloc `data` | vérifié |

---

## 2. Cinq découvertes structurantes

### 2.1 L'économie de tokens des symboles est une illusion mesurée

Expériences tokenizer reproductibles (tiktoken cl100k/o200k + tokenizer Anthropic legacy) :

- La plupart des glyphes math Unicode coûtent 2-3 tokens BPE ; les mots anglais remplacés (` and`, ` not`, ` in`) coûtent 1. Fiables à 1 token : `¬ → := φ τ γ` ; à 2 : `∃ ∈ ∧ ∅` ; `∀`=1 (o200k) / 2 (cl100k).
- `∀ x ∈ Y:` = `for each x in Y:` = **6 tokens exactement**. Un Let-block symbolique complet : token-égal ou pire que l'anglais structuré (52-53 vs 49-51) malgré −28% de caractères.
- Le renommage grec économise ~1 token/occurrence face à un mot multi-token — mais la ligne `Let:` coûte ~8-10 tokens : seuil de rentabilité `(T_phrase − T_var) × occurrences > T_letline`.
- **Les vraies économies (~40% sur prose verbeuse) viennent de l'élagage de prose (R5/R6/R7)** — remplissage, articles, narration — pas de la substitution de glyphes. Une forme ASCII compacte capture les mêmes gains.
- Corroboration externe : étude Tencent (arXiv 2604.07192) — le contre-exemple « chinois classique » (4.6% d'économie vs 25-30% pour tags anglais alignés tokenizer) : densité perçue ≠ efficacité tokenizer.
- Conséquence : la métrique lignes du skill peut afficher une compression pendant que les **tokens augmentent**.

### 2.2 La notation ne garantit pas la fidélité — la polarité, si

- **MetaGlyph** (arXiv 2601.07354) : fidélité des opérateurs dépendante du modèle — `→` lu à **0%** comme opérateur de transformation, `∈` à 26%, `∩` lu comme une liste ; courbe en U (les modèles moyens instruction-tunés sont les pires).
- **Tencent** (null result contrôlé, Cliff's δ<0.01) : la forme d'encodage n'a **aucun effet détectable** sur la conformité aux contraintes. Ce qui gouverne la conformité : la **polarité** — les contraintes négatives opposées aux défauts du modèle échouent 10-100% quelle que soit la notation (36/47 échecs = biais de défaut). Le style maison saturé de `¬` est directement concerné.
- LILO (ICLR 2024) + ablations pseudo-code : la **glose NL est porteuse de charge**, pas décorative — les abstractions nommées sans doc NL deviennent inutilisables en aval.
- Conséquence : la proposition de valeur du skill doit être refondée — de « économie par symboles » (faux) vers **précision sémantique + SSoT + densification par élagage + dérivation gated**, avec gloses NL obligatoires et vérification par relecture indépendante.

### 2.3 La production a dépassé le skill

L'idiome a pris — chaque skill dev-core majeur utilise Let-blocks, quantificateurs, `¬`, `O_name{}` — mais a évolué au-delà de R1–R10 :

- **Constructs non couverts** : contrats de succès `I/V` (15+ skills), verify-tables de pipeline (code-review:34-42, plan:33-40…), shorthand cross-file `DP(A/B/C)` (132 call sites), state maps 3-valuées `Σ/Σ_s` (dev:82-99), prédicats indicés `ψ_r/ψ_f`, ops paramétrés `O_push(N, scope, msg)` (fix:52), guard-functions `should_skip(step, τ, Σ)`, set-builder + `⋃` (code-review:139), `⊥ ≡`, vocabulaire de glyphes de statut `✓✗⏳⚠`, schéma de sections standard (doc-writer).
- **3 légendes en conflit** : compress SKILL.md:21 (`→` then, `↦` maps-to) · dev-core base.md:16 (`→` then/maps-to) · doc-writer.md:54 (`⇒` implies, `→` maps-to). Seul `↦` est réellement inutilisé en production.
- **Collisions grecques mesurées** : σ ∈ {spec, stack.yml, doc-type Spec, staging} (collision à 4) ; τ = tier/fichier-cible/doc-type ; π = plan/fichier-test ; Σ = state-map/standards-test ; Ω = fichier-override (9+ usages, dominant) vs invocation-skill (1).
- **Drift quantifié** : artefact `→ → DP` ×44 vs ×66 corrects ; `⇒`-pour-then ×33 sur 8 fichiers (mais **légende sanctionnée** par doc-writer.md:54, pas du drift — et usage contrastif vivant : dev:45 `--cleanup-context ⇒ ∃ other flags → warn`) ; `||` vs `∨` ; `←`/`=` vs `:=` ; `⟺` dans 7 fichiers plugins vs `⇔` zéro dans plugins/ (1× dans operator.ssot.md).
- Un skill mono-fichier ne peut structurellement voir aucun de ces problèmes de corpus.

### 2.4 Le réflexe de dérivation existe déjà — 100% manuel

Le mouvement « monter d'un niveau » a déjà réussi ≥3 fois dans ce corpus exact :

1. `decision-presentation.md` + shorthand `DP(n)` — extraction d'un protocole partagé, ~132 call sites.
2. `plan-task-schema.md` — « SSoT for TaskCreate shape » (plan:274, implement:88-89).
3. **`conventions.ssot.md:15-25`** — la forme canonique du principe dérivé : l'expérience d'un seul projet (lyra, 46→9 ADR) promue en règle `∀ repo Roxabi:` avec **`trigger:` prédicat machine-checkable + `ref:` vers l'instance concrète**. C'est le template exact du réflexe de dérivation.

Côté vault, la doctrine converge : promotion native gigabrain (bullets → registre structuré avec provenance), pipeline épisodique→sémantique→procédural de Lyra, « Leçons #1-5 » distillées de 462 commits, cristallisation réelle « harness ≠ framework » à partir de 3 posts sauvegardés. Contrepoids déjà identifiés : gate de qualification ACC (rappel ≠ engagement), récupérabilité lossless (supersede, jamais delete), doctrine hiérarchique lazy-load (~500 tokens always-on ; « CLAUDE.md est le seul mécanisme always-on : chaque ligne est payée à chaque message »), résultat Vercel (index compressé always-on : 100% vs 53% pour skills à déclenchement).

Prior art externe validant le mécanisme : Instruction Induction (Honovich 2022), GEPA (ICLR 2026 — dérivation de règles par réflexion sur traces, bat le RL avec 35× moins de rollouts), LILO (compression symbolique de corpus d'instances → abstractions nommées + AutoDoc).

### 2.5 Cortex fournit le contrat exact — et l'écrit déjà dans cette notation

- **ADR-005** : encode (insight, source-aware, ignore le graphe) → contrat `Observation` (fait typé, ancré provenance, « pas encore résolu contre le graphe ») → consolidate (memory, Retain Job 7 étapes : résolution acteurs, dedup cosine>0.85, `schema_fit` (Jaccard pondéré IDF ; <0.3 = dark matter, >0.7 = fast-track), conflits (overlap fort + polarité opposée), upsert, decay, regen compiled truth).
- **Échelle d'abstraction déjà spécifiée** : raw verbatim → findings condensés → compiled truth (300-600 mots, injecté si memory_strength>0.35) → profil d'entité ; enveloppe `raw→distilled→superseded→archived` ; clustering D15 (instances d'épisodes → candidats Pattern nommés, seuils ≥5/0.70/0.8) ; RC-1..RC-7 extraits à la main que cortex doit rendre « systematic, repeatable, retroactive ».
- Aucune mention explicite d'« écriture symbolique » dans le repo cortex — la compression n'y apparaît que comme densification (compiled truth « ultra-dense », assemble token-budgeté avec bio-éviction) et la fidélité comme gates opérationnels (« Ne rien inventer », température 0.0, re-runs déterministes, golden datasets, tout régénérable depuis le raw immuable).
- **Le CLAUDE.md et le DATA-MODEL de cortex sont déjà écrits dans la notation du skill** — compress est déjà de facto la couche d'encodage de la doc de cortex.

Mapping modes ↔ étages cortex (version honnête, post-vérification) :

| Mode compress | Étage cortex | Ce que le PoC dé-risque réellement |
|---|---|---|
| compress (1:1) | encode (ADR-005) | contrat typé + ancres de provenance ; **attention** : compress est lossless-par-règle, la consolidation cortex est lossy-by-design — le transfert fort est le round-trip expand |
| derive | consolidate (Retain) | heuristiques dedup/fold-in vs new, routage schema_fit + dark matter, détection de conflits, file d'approbation — le **schéma**, pas les statistiques (corpus doc ≠ traces épisodiques bruitées) |
| expand | régénération depuis le raw | l'invariant fondateur « raw immuable = SSoT, tout le reste dérivé et reconstructible » — en version LLM (stochastique), donc analogie disciplinée, pas identité |
| lint | maintenance nightly | dedup de formes synonymes, queue d'approbation ; format de diff aligné sur les `diff_types` d'actuation cortex {claude_md, skill, memory_entry, ssot} |
| glossary | gouvernance taxonomie (ADR-009) | **mécanique seulement** (enum fermé versionné, extension human-gated, politique de collision) — ne remplit PAS le blocker ADR-009 (interview biomimétique + validation sur flux personnels) |

---

## 3. Les 8 propositions (synthèse post-vérification)

Toutes les 6 propositions vérifiées → NEEDS_REVISION avec correctifs concrets (aucun REJECT). P7/P8 non passées au verify (gate priorité) — correctifs analogues à intégrer par symétrie.

| # | Proposition | Effort | Verdict | Dépend de |
|---|---|---|---|---|
| P1 | Glossaire canonique + registre de variables réservées (`plugins/shared/references/notation.md`) | M | NEEDS_REVISION | — |
| P2 | Métriques token-true + ledger append-only + provenance Observation-shaped | S→**M** | NEEDS_REVISION | — |
| P3 | Vérification read-back par agent frais + mode expand + golden set | M | NEEDS_REVISION | P5 (P2 optionnel) |
| P4 | **Mode derive : R11 extraction cross-file + R12 abstraction lift (le réflexe de dérivation)** | L | NEEDS_REVISION | P1, P2, P3, P5 |
| P5 | Dispatch de modes + résolution de scope multi-cibles + restructuration references/ | M | NEEDS_REVISION | — (préalable de P3/P4/P8) |
| P6 | Guardrails de fidélité fondés sur preuves + politique de transformation token-honnête | S | NEEDS_REVISION | P1 (ou autonome via whitelist inline) |
| P7 | Niveaux L0-L3 + R13 section-entière + marqueurs de provenance machine-readable | M | non vérifié | P2, P5 |
| P8 | Mode lint corpus + profils de genre + réparation via queue d'approbation | M | non vérifié | **strictement après P1** |

### P1 — Glossaire canonique + registre (`plugins/shared/references/notation.md`)

Fusionne les 3 légendes ; grammaire de désambiguïsation (4 sens positionnels de `→`, registres modaux de `¬`, hiérarchie de séparateurs `/`,`,` < `·` < `|` < `;` < newline < heading) ; registre de variables réservées (τ=tier, φ=frame, Δ=diff, Σ=state-map…) avec re-binding local marqué `(local)` ; Phase 0 du skill charge le glossaire, Phase 3 collision-check chaque nouvelle var Let ; mode `glossary` pour add/deprecate/version ; correction de l'exemple R1 du skill ; repoint one-line de base.md et doc-writer.md dans le même PR.

**Correctifs vérificateur à intégrer** :
- Corriger le seed depuis grep, pas de mémoire : σ = {spec, stack.yml, Spec doc-type, staging} ; Ω canonique = fichier-override (majorité mesurée), pas invocation-skill ; documenter α=agent (binding grec le plus répandu), β=branch, ω=worktree, μ=main.
- **Méthode uniforme pour tous les conflits de glyphes** : `⇒`/`→` devient une décision DP à comptages mesurés exactement comme `⟺`/`⇔` — `⇒` n'est pas du drift (légende sanctionnée doc-writer.md:54, registre contrastif vivant dev:45).
- Démoter la règle de registre « entités = Latin majuscule, grec = quantités internes » en note aspirationnelle explicite : contredite en repo (α/β/ω/μ/σ) et dérivée du corpus privé ssot — scoper notation.md au corpus roxabi-plugins, marquer ssot comme évidence hors-corpus.
- Fermer l'écart lecteur/rédacteur : tout glyphe porteur d'un avertissement fidélité doit être émis avec glose NL inline ; Phase 5 vérifie que chaque symbole de sortie est core-table ou Let-défini localement ; dire explicitement que notation.md est un outillage côté rédacteur.
- Auto-protection dans le même PR : check `notation-legends` dans `tools/validate_plugins.py` (base.md/doc-writer.md restent des pointeurs one-line) + parité set-equality entre table fallback inline et cœur du glossaire (précédent : shared-sources-sync) — ne pas dépendre de P8.
- Remplacer la colonne « token-cost note » par-glyphe (invérifiable, pourrit) par un appendice mesuré one-shot (API count_tokens, modèle+date) ou la supprimer.
- Budgéter le chargement Phase 0 : cœur ~150 lignes toujours chargé par compress ; grammaire + politique de maintenance chargées seulement en modes glossary/lint.
- Nommer le coût de coordination : repoint base.md = changement skills/ dev-core → bump semver plugin.json dev-core (pre-push check-skill-version), à coordonner (mémoire descope-under-churn).
- cortex_link honnête : mécanique de gouvernance de vocabulaire fermé uniquement ; ne prétend pas remplir la « validation contre cas concrets » d'ADR-009 ; zéro dérivation dans cette proposition.

### P2 — Métriques token-true + ledger + provenance

`scripts/count_tokens.py` (3 tiers : API Anthropic count_tokens > proxy tiktoken étiqueté > estimation avec warning ; champ `method:` obligatoire) ; Phases 2/4/5 passent de lignes à tokens, rapport par section, flag `Δtokens ≈ 0` (jamais présenter char% comme économie) ; ledger JSONL append-only dans `~/.roxabi-vault/compress/` ; remplacement du « 30-60% » du README par un agrégat mesuré.

**Correctifs vérificateur à intégrer** :
- **Erreur factuelle** : plugin.json existe déjà — ajouter le bloc `data` (`data.root: compress`) dans `plugins/compress/.claude-plugin/plugin.json` (seul chemin scanné par le validateur, glob `*/.claude-plugin/plugin.json`) — pas un nouveau fichier à la racine du plugin.
- **Ajouter Bash aux allowed-tools** (sinon le script est inexécutable et « append » via Write/Edit = read-all+rewrite = clobber + unbounded-read). Tous les appends passent par le script (O_APPEND) via `roxabi_sdk.paths`. Dégradation : Bash indisponible → method: estimate, verify: skipped, pas de ligne ledger.
- Démoter le proxy de décideur à afficheur : les règles binaires (<5% skip, Δ≈0) ne lient que sous method=anthropic-api ; sous proxy, calculer o200k ET cl100k, agir seulement si accord ; ligne de calibration one-shot proxy-vs-API à la première clé disponible.
- Réécrire le rationale tokenizer à la vérité mesurée (coût par-glyphe dépendant du tokenizer ; renommages grecs ~1 token/occurrence ; gros des gains = R5/R6/R7 ; certaines substitutions net-négatives).
- Façonner chaque ligne du ledger **littéralement** en Observation (`{id ULID, source:'compress-skill', source_ref sha, ts, category←mode, payload_typed:{schema_version,…}, correlation}`) — sinon c'est « Observation-inspired », pas seed data.
- κ : ne pas prétendre « la table κ de cortex » (κ = precision/recall de détecteurs, pas fidélité de compression) — « ledger de calibration κ-shaped exerçant le contrat de provenance Observation ».
- Retirer les référents indéfinis (glossary_version, level, modes derivation/lint-repair) ou les marquer nullable « reserved » avec dépendance déclarée ; schema_version + enum ouvert.
- Effort honnête : M (premier plugin data-owning du marketplace, script 3-tiers, ULID vendored ~10 lignes, changement allowed-tools) — ou garder S en coupant le tier API en follow-up.

### P3 — Read-back agent frais + expand + golden set

Ajouter `Task` aux allowed-tools ; Phase 2 extrait l'inventaire (chaque règle/condition/interdiction/seuil/edge-case, checklist) ; Phase 5a (gated `--verify` ou seuil) : agent frais reçoit UNIQUEMENT le texte compressé et ré-expanse en inventaire ; diff des deux inventaires ; manques/inversions/inventions = blockers → auto-fix + un re-verify → résidu DP(A) ; mode `expand` autonome (décompression) ; golden set 3-5 paires + inventaires attendus.

**Correctifs vérificateur à intégrer** :
- **Contradiction interne à résoudre** : le « set-diff déterministe sur items keyed par ligne source » est impossible (le lecteur frais ne voit pas la source). Soit ancres d'items stables émises des deux côtés + script de diff (`scripts/inventory_diff.py`, Bash requis), soit reformuler honnêtement « LLM-matched, human-gated » et cesser de citer la doctrine couche-déterministe.
- **Vérifier en conditions de production** : read-back par défaut SANS glossaire (les consommateurs réels n'en ont pas) ; si un glossaire est requis pour passer → règle « émettre une légende minimale par-fichier des symboles utilisés », dont les tokens comptent contre les économies. Documenter la contamination de contexte du sous-agent (CLAUDE.md hérité déjà saturé de notation = biais optimiste).
- Pré-enregistrer un seuil go/no-go (recall d'inventaire lecteur frais < X% sans glossaire ⇒ notation révisée ou légende obligatoire) — sinon le ledger est de l'accumulation-théâtre. MetaGlyph prédit des échecs fréquents : c'est le but — si la notation échoue systématiquement au read-back, c'est le cœur du skill qui est indicté, et on veut le savoir **avant** cortex.
- Découpler de P2 (fallback : log de verify local vault) ; N seuil = constante nommée ; re-verify = 2e spawn frais (coût doublé, à déclarer) ; accès du lecteur capé au seul artefact compressé (garde unbounded-read).
- Golden set : remplacer le byte-déterminisme (impossible en LLM) par équivalence d'inventaire avec procédure de re-baselining au changement de modèle ; runner explicite = `tools/validate_plugins.py`/CI, ou retirer la phrase.
- **Critères d'acceptation par mode** : compress = préservation d'inventaire lossless ; derive (futur) = mapping de couverture (chaque instance source ↦ un pattern/principe) + liste de pertes délibérées acceptée en DP — sinon ce vérificateur bloque structurellement la dérivation (nécessairement lossy).

### P4 — Mode derive : R11 + R12 (le réflexe de dérivation) — la tête d'affiche, à exécuter en dernier

`/compress derive <glob|dir|plugin>` (jamais depuis un /compress nu) ; corps du mode dans `references/derive.md`. Pipeline : MINE (signatures structurelles normalisées) → GATE (≥3 occurrences × ≥3 fichiers ∧ stabilité fresh-tail) → ROUTE par schema_fit (fold-in / nouveau pattern via DP / **dark matter = garder verbatim, ne jamais forcer l'abstraction**) → CONFLICT (overlap + polarité opposée → DP(A), jamais de merge silencieux) → EMIT : R11 extraction cross-file (fichier de référence partagé + pointeurs) ; R12 abstraction lift émis avec le template conventions.ssot génériqué : `## <Principe> (validé sur <instance>: <métrique>)` + `∀ <scope>:` + `trigger:` prédicat + `ref:` provenance + glose NL ≤1 ligne (AutoDoc porteur de charge) + confidence + ambiguity_flags. Sorties = NOUVEAUX artefacts uniquement ; remplacement des call-sites DP-gated par fichier ; supersede-not-destroy ; **v1 = report-only**. Validation GEPA-style via le vérificateur P3 (un agent suivant la règle dérivée doit reproduire les instances d'origine).

**Correctifs vérificateur à intégrer** :
- Critère d'amortissement runtime dans GATE : l'extraction R11 est token-NÉGATIVE à l'exécution pour des call-sites cross-skill (pointeur force un Read du référentiel complet ~550 tokens là où l'inline coûtait ~100) — extraire ssi les call-sites co-occurrent dans une même fenêtre (chaînes dev→plan→implement) OU reclasser l'objectif comme SSoT/cohérence et rapporter les deux chiffres (delta statique repo vs delta runtime par invocation). La valeur réelle du précédent DP(n) est la SSoT, pas les tokens.
- Break-even par cluster dans EMIT : skip si template + provenance + pointeurs ≥ somme des instances verbatim.
- Borner MINE : cap dur fichiers/octets, fan-out sous-agents par fichier (signatures seulement, jamais le corpus entier dans un contexte) — mode d'échec overflow documenté en mémoire projet.
- Opérationnaliser chaque prédicat de gate dans derive.md avec commandes exécutables (`git log -1 --format=%ct -- <file>` pour freshness ; procédure de normalisation définie) ; abandonner « current release » (plugins sans version) ; démoter D15/GEPA/LILO/RC-x en crédits non-porteurs.
- **Auto-contenance marketplace** : embarquer le template R12 génériqué dans derive.md (ne jamais référencer `~/projects/ssot/` par chemin) ; cibles dev-core = exemples dogfood-only ; ajouter des descriptions de cibles génériques hors-Roxabi.
- Règle de déréférencement obligatoire pour chaque pointeur émis : Let-bind vers un chemin runtime-résolvable complet (pattern `Q := read ${CLAUDE_PLUGIN_ROOT}/...`) ; interdire le `→ NAME(n)` nu.
- cortex_link recadré : dé-risque le **schéma** (taxonomie de routage, UX de conflit, provenance, queue d'approbation) à 0 € ; les seuils ≥3/≥3 sont des placeholders, pas des données de calibration pour cortex (distribution doc ≠ traces épisodiques).
- Premières cibles concrètes (dogfood) : boilerplate I/V (15+ skills), verify-tables de pipeline, vocabulaire de glyphes de statut.

### P5 — Dispatch + scope multi-cibles + restructuration (l'architecture habilitante — à faire en premier)

Phase 0 dispatch (compress défaut | derive | expand | lint | glossary ; ambigu → DP(B)) ; Phase 1 réécrite : fichier | glob | dossier | nom de plugin, auto-découverte des deux layouts (marketplace + legacy .claude/) ; SKILL.md ≤ ~110 lignes, corps de modes lazy-loaded dans `references/<mode>.md`.

**Correctifs vérificateur à intégrer** :
- Économie de tokens recadrée : le corps SKILL.md n'est payé qu'à l'invocation ; la surface toujours-payée est la **description frontmatter** — budget explicite (≤ +15 tokens), triggers composés portant lexicalement le contexte : « expand notation » | « lint notation » | « derive pattern from skills » ; supprimer « glossary » et « decompress » nus (false-fire garanti).
- **Gate anti-mode-fantôme** : mode valide ⟺ `references/<mode>.md ∃` ; ∄ → halt « mode not yet implemented » (¬improviser) ; ne pas annoncer `--level`/`--verify` dans argument-hint avant que P3/P7 existent (ou stubs dans le même PR).
- Ajouter la ligne de chargement DP manquante (bug préexistant) : SKILL.md:25,49 utilisent DP(A)/DP(B) sans instruction de Read — un lecteur frais voit un token indéfini.
- Budget de lecture multi-cibles : résoudre le scope → lister les fichiers → si N>1, un seul DP(A) batché (liste + estimations) avant toute lecture au-delà de la découverte ; cap N≤10, au-delà chunked ; diff consolidé avec opt-out par fichier (le DP(A)×N par fichier serait inutilisable → violation garantie de la safety rule 4).
- Corrections de précision : « la résolution par NOM hardcode le layout legacy (les chemins directs marchent) » ; check line-budget dans `tools/validate_plugins.py` (gate existant), pas de nouveau CI ; cortex_link : citer ADR-005 par son vrai titre (« Encode vs consolide — contrat Observation » ; « leaf densification » n'existe pas), créditer le dé-risque opérationnel à P3/P4/P8.

### P6 — Guardrails de fidélité + politique token-honnête

Remplace la liste plate ¬compress (SKILL.md:47). G1 transformation de polarité : `¬use Y` → `use Z (¬Y)` quand une alternative concrète Z existe (jamais inventer Z ; sans alternative → flag « needs external verification » + ledger). G2 : familiarité/no-free-coinage (nouveaux symboles ∈ whitelist inline ; pas de frappe libre de nouvelles vars indicées). G3 glose NL obligatoire : `(prédicat ∨ O-block ∨ Let-bind) ∨ (symbole ∉ whitelist) ∨ (chaîne > 3 opérateurs)` → glose `— …` ≤1 ligne ; symboles nus interdits en sortie. G4 plancher verbatim : commandes, noms d'outils, spawn templates, règles de sécurité restent en mots, évidence citée inline. Réalignement : R1 démote en règle de désambiguïsation (avec l'inégalité de break-even énoncée dans le skill) ; R5/R6/R7 promus transformation économique primaire.

**Correctifs vérificateur à intégrer** :
- **Supprimer les tiers de comptage hardcodés** (claim « ∀ ∃ ∈ ∧ ∨ = 1 token » mesurablement faux : tous à 2 sur cl100k sauf ¬ et :=) → principe énoncé : « la substitution de glyphes est token-neutre au mieux ; choisir les glyphes pour le registre/la précision, jamais pour l'économie ; les gains mesurés viennent de l'élagage de prose » + procédure de mesure optionnelle (API, tokenizer+date enregistrés). Jamais encoder un gagnant tokenizer-relatif (⟺/⇔ **s'inverse** entre cl100k et o200k) comme règle intemporelle.
- Seuil R1 corrigé : Let-bind ssi `(T_phrase − T_var) × occ > T_letline (≈8-10)` — en pratique phrase ≥3 tokens ∧ occ ≥4, ou phrase ≥4 ∧ occ ≥3.
- Auto-contenance : whitelist inline = canonique dans SKILL.md, pointeur glossaire = enrichissement optionnel gardé par test d'existence (dissout le couplage d'ordre avec P1) ; ledger = bloc de format fixe dans la présentation Phase 4, persistance vault optionnelle ; toute référence au mode lint spécifiée ou rayée.
- Épingler l'évidence durablement : extraits porteurs (Tencent δ<0.01 + taxonomie d'échecs, MetaGlyph 0% arrow, ablation pseudo-code) avec IDs arXiv dans `plugins/compress/references/evidence.md`, cité inline per G4.
- Schéma consommable pour le flag de contrainte négative : `{constraint | polarity | alternative-exists | verification-method}` émis en Phase 4 — devient le contrat que la boucle d'actuation cortex vérifiera avant tout auto-PR d'instructions compressées.
- Honnêteté du rationale : G1/G3 **dépensent** des tokens pour acheter de la conformité (conformité > économie pour les règles safety-critical) — ne pas prétendre que fidélité et économie pointent toujours dans la même direction.

### P7 — Niveaux L0-L3 + R13 + marqueurs (non vérifié — correctifs P2/P3/P5 applicables par symétrie)

`--level` par fichier ou section, défaut L2 auto-classifié (override DP(A)). **L0** verbatim (règles de sécurité, noms d'outils, commandes, spawn templates — classe never-evict) ; **L1** prose terse (R5/R6/R7, digraphes ASCII — là où vivent les économies mesurées ; pour docs lus par humains/agents externes) ; **L2** symbolique maison (défaut, étendu aux constructs de production que R1-R10 rate) ; **L3** split externalisation : cœur invariant compressé sous budget token explicite (~500 tokens, doctrine paid-per-message) + doc de résidu lié `→ path — gloss` (pattern pyramide ssot + résultat Vercel index+pointeurs). « Derived » n'est PAS un niveau (c'est le mode P4). R13 : chaque section atterrit entièrement à UN niveau (CDCT : les échecs de conformité culminent à compression MOYENNE — la zone d'ambiguïté). Marqueur : `<!-- compress: level=L2 src-sha=<sha> glossary=v1 -->` après le frontmatter — détection de niveau remplace l'edge case « already formal » ; sha périmé (édition manuelle) force re-vérification avant re-compression.

### P8 — Mode lint corpus (non vérifié — strictement après P1)

`/compress lint <scope>` — rapport read-only par défaut ; `--fix` DP-gated. Étape 1 lint déterministe (Grep) contre le glossaire : classes de drift en patterns fixes (`→ → ` ×44, `||`-pour-∨, `←`/`=`-pour-:=, collisions de variables réservées, symboles hors-glossaire, gloses manquantes, marqueurs périmés, contraintes négatives → proposition G1, jamais auto-appliquée) ; étape 2 table `file:line | classe | actuel | proposé` → DP(C) multi-select ; étape 3 : classes mécaniques appliquées par batch approuvé, classes sémantiques en DP par fichier ; exclusions dures : code blocks, frontmatter, spawn templates. Profils de genre : CLAUDE.md/ssot = always-on agressif invariant+pointeur ; fichiers memory = préserver provenance et dates ; skills = règles courantes. Règles opérationnelles : un PR par scope plugin, dry-run défaut, petits batches, **jamais lint-fix des fichiers d'un effort en vol** (mémoire descope-under-churn). Note post-P1 : `⇒` sort de la liste de drift tant que la décision DP ⇒/→ n'est pas prise.

---

## 4. Ordre d'exécution recommandé

La priorité de synthèse (impact) ≠ ordre d'exécution (dépendances) :

```
1. P5 dispatch+scope  ─┐  (architecture ; corrige aussi le bug DP-load préexistant)
2. P2 tokens+ledger   ─┤  (tue l'illusion ligne% jour 1 ; S→M)
3. P1 glossaire       ─┤  (vocabulaire SSoT + auto-protection validate_plugins)
4. P6 guardrails      ─┤  (peut précéder P1 grâce à la whitelist inline autonome)
5. P3 read-back+expand ┤  (la preuve de fidélité ; go/no-go pré-enregistré)
6. P7 niveaux L0-L3   ─┤
7. P8 lint corpus     ─┤  (strictement après P1)
8. P4 derive          ─┘  (la tête d'affiche — en dernier, v1 report-only,
                           validée par P3, notée par P1/P6, mesurée par P2)
```

Découpage PR suggéré : PR-A = P5+P2 (fondations mesure+architecture) · PR-B = P1+P6 (vocabulaire+politique, inclut bump dev-core coordonné) · PR-C = P3 (+P7) · PR-D = P8 · PR-E = P4.

## 5. Composants écartés (adjudications de synthèse)

- « L3 = artefact dérivé » comme niveau — la dérivation est un **mode**, pas un registre in-file (3 définitions L3 en conflit résolues).
- « L3 = full formal » séparé — fusionné dans L2 (deux registres symboliques adjacents recréeraient la zone d'ambiguïté médiane CDCT).
- Genre « entrées vault » pour lint — écarté entièrement (surface de données de roxabi-vault, risque de corruption de données personnelles, zéro payoff PoC).
- Drop-list glossaire `∩ ∪ ∅ ⊂ ∥ |X|` — corrigée par grep : tous vivants en production ; seul `↦` est inutilisé.
- Normalisation pré-légiférée « ⇔ remplace ⟺ » — contredite par l'usage mesuré (⟺ ×7 fichiers plugins, ⇔ ×1 dans ssot) ; décision par DP à comptages.
- Migration corpus immédiate — différée au mode lint (mémoire descope-under-staging-churn).

## 6. Le recadrage central (à retenir)

> La proposition de valeur de compress v1 — « les symboles économisent des tokens » — est **mesurablement fausse**. Ce qui est vrai et vaut le PoC : (1) l'élagage de prose économise ~40% ; (2) la notation achète de la **précision de registre** et une **SSoT de vocabulaire**, à condition de gloses NL et d'un glossaire gouverné ; (3) la conformité est gouvernée par la **polarité**, pas par l'encodage — d'où G1 ; (4) la fidélité doit être **prouvée par relecture indépendante**, pas auto-affirmée ; (5) le **réflexe de dérivation** (instances → patterns → principes avec trigger:/ref:/provenance, dark-matter escape hatch, gates humains) est la vraie nouveauté — c'est l'étage consolidate de cortex répété à 0 € sur des documents réels, et il a déjà fait ses preuves manuellement trois fois dans ce corpus.

**Références externes clés** : Tencent arXiv 2604.07192 (encodage : effet nul ; polarité : dominante) · MetaGlyph arXiv 2601.07354 (fidélité par-opérateur) · LILO ICLR 2024 (compress→name→AutoDoc) · GEPA ICLR 2026 (dérivation par réflexion sur traces) · Honovich 2022 (instruction induction) · Vercel (index always-on 100% vs 53%).
**Ancres cortex** : ADR-005 (Observation), Retain Job, schema_fit/dark matter, compiled truth, ADR-009 (deferred), diff_types d'actuation.
