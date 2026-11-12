# Audit de portefeuille de sites

Procédure lecture seule. Un agent l'exécute de bout en bout sur un portefeuille déclaré par l'opérateur. Elle produit des **preuves**, des **statuts** et des recommandations. Elle ne déploie rien, ne corrige rien et ne soumet aucun formulaire.

Les résultats vivent dans un dossier d'exécution hors de ce dépôt public. Ce dépôt ne reçoit ni domaine réel, ni nom de personne, ni secret, ni mesure.

Ordre : cadrage → inventaire → **pin** → gel du **corpus** → une **fiche** par domaine, branche selon le **rôle** → gate → synthèse réseau. La synthèse commence seulement quand la gate est verte.

## Vocabulaire

| Mot | Sens |
|-----|------|
| Portefeuille | Ensemble de domaines qu'une même décision peut conserver, différencier, fusionner ou arrêter. |
| Rôle | `site` (principal ou satellite), `redirect`, `shortener`, `inactif`. Le rôle se prouve par le comportement observé, pas par la forme du nom. |
| Hébergeur | Système qui produit la réponse HTTP d'origine. Distinct du proxy DNS. |
| Pin | Révision exacte : URL distante, branche, SHA. `HEAD` et révision déployée sont deux champs. |
| Surface | `static`, `form`, `auth`, `functions`. Une propriété peut en cumuler. |
| Corpus | Questions GEO gelées avant la première observation. |
| Preuve | Artefact horodaté dans `raw/`, ligne de source du pin, ou enregistrement daté d'un contrôleplane authentifié. Un souvenir n'est pas une preuve. |
| Statut | `satisfaisant`, `à corriger`, `critique`, `non mesurable`, `non applicable`. |
| Disponibilité | `disponible`, `inaccessible`, `non configuré`, `non applicable`. `non configuré` seulement si une source autorisée établit l'absence. Invisible depuis un compte = `inaccessible` pour ce compte. |
| Proxy-metric | Compteur d'un tableau de bord fournisseur (exemple : visiteurs ou insights Cloudflare). Observation de livraison ou de cache, pas une acquisition organique, pas une faille. |
| Couverture | Périmètre déclaré. Un échec d'outil la conserve et nomme le blocage. |
| Contrôleplane | API ou console authentifiée déjà accessible (exemples : Cloudflare, GitHub). Source autorisée, au même titre qu'une page publique ou un export opérateur. Le jeton reste hors dossier. |

**Statut d'axe** = le pire statut applicable de cet axe, hors classification de métrique. **Statut de fiche** = le pire statut d'axe. Un bucket Good / Needs Improvement / Poor ne le rend pas `critique`. Aucune moyenne.

**Gravité** d'un constat : `critique`, `à corriger`, `observation`. **Confiance** : quatre qualités cohérentes, pas un décompte d'artefacts. Direct = la mesure elle-même. Attribution = liée au domaine, au SHA et à la période. Couverture = l'échantillon ou la fenêtre demandés. Fraîcheur = datée, dans la fenêtre de l'audit. `élevée` = les quatre tiennent. `moyenne` = une manque. `faible` = deux manquent, ou la preuve est indirecte. Deux artefacts concordants ne passent pas au-dessus d'un artefact direct qui réunit les quatre.

**Fait** se juge par le critère **Fait quand** de l'étape. Un champ sans preuve reçoit un statut et la raison, jamais une valeur inventée.

## Dossier d'exécution

Chemin choisi par l'opérateur, hors de ce dépôt. Exemple de forme : `<espace-privé>/audit-portefeuille-<date>/`.

```
manifest.md
inventaire.md
corpus.md
synthese.md
domaines/<slug>/fiche.md
raw/<UTC>/...
```

`<slug>` est un identifiant opaque (`d01`), pas un domaine réel recopié dans ce dépôt. Le domaine réel reste dans le dossier privé.

Chaque fichier de `raw/` nomme l'URL ou le chemin source, l'outil, l'heure UTC et le pin. Une query qui porte un jeton est retirée du nom de fichier et du rapport ; le statut note « query retirée ».

## Règles transverses

- **Mandat.** L'audit s'arrête à la recommandation. Une migration, un déploiement ou une correction demande un mandat distinct, consigné comme non exécuté.
- **Lecture.** Sources autorisées : pages et URL inventoriées, contrôleplane, UI GSC, API documentées en lecture seule. Un SELECT envoyé en POST reste une lecture s'il ne mute pas. Cloner ou fetch une source découverte par un registre autorisé (DNS, contrôleplane, GitHub, liens déjà lus), pas seulement une page publique. Défaut : une observation par URL. Exceptions, sans plafond de couverture : 3 runs lab mobile et 3 desktop par URL de l'échantillon performance ; au moins 3 observations GEO par question accessible ; chaque variante de redirect. Jamais de cron, de job, ni de PUT de sitemap. Clone frais, sans secret injecté.
- **Outillage.** Un outil d'audit isolé et épinglé s'installe si une mesure l'exige (Lighthouse local peut exiger son binaire). Les dépendances du produit ne s'installent pas. Le build produit ne se lance pas.
- **Formulaires.** Champs, `action`, mentions légales et bannière sont lus. Aucun envoi.
- **Lecture GSC.** Classement, indexation et métriques Search Console : export, ou observation UI authentifiée datée archivée dans `raw/`. Même poids. Sans cette lecture, la mesure est `non mesurable`. Pas de scraping automatisé de SERP pour produire un classement ; GSC, export ou outil SERP déjà autorisé. Les questions GEO suivent strictement le protocole et les interfaces autorisées, dans les conditions du fournisseur, sans contournement de captcha, de quota ou de login.
- **Secrets.** Type, chemin, commit, au plus quatre derniers caractères. La valeur reste hors dossier. Présent dans le pin ≠ présent dans l'historique ≠ exploitable.
- **Personnes.** Un WHOIS ou un auteur qui expose une personne physique est consigné par rôle (« registrant », « auteur de commit ») sans nom, e-mail ni téléphone.
- **Proxy-metric.** La citer seulement comme mesure de livraison. L'acquisition organique se prouve par une lecture GSC ou un analytics segmenté. Une faille se prouve par une preuve de l'axe sécurité.
- **Échec d'outil.** Consigner outil, erreur, heure, cible. Tenter les voies indépendantes déjà disponibles et proportionnées qui répondent à la même question : autre outil, contrôleplane authentifié, UI datée, artefact public. S'arrêter seulement quand le prérequis est effectivement inaccessible — chaque voie disponible a échoué ou n'existe pas. La ligne reste dans la couverture, statut `non mesurable`, blocages verbatim. `non applicable` n'est pas un substitut d'échec.
- **Pin et arbre sale.** Un clone ou worktree frais reçoit la révision lue. Un checkout local modifié n'est ni relu comme vérité, ni nettoyé, ni commité.
- **HEAD / prod.** Les deux SHA sont écrits. L'égalité se prouve par un artefact public (SHA dans le HTML, en-tête de release, checksum d'asset publié) correspondant à un objet Git, ou par la metadata de déploiement du contrôleplane authentifié qui lie domaine, SHA et dirty flag (exemple : déploiement Cloudflare). Ces voies se valent. `dirty=true` : le snapshot Git au SHA ne suffit pas à reproduire le déploiement exactement — le consigner, et ne pas traiter ce SHA comme pin reproductible. Sans aucune de ces preuves, la révision déployée est `non mesurable`. L'audit ne lance pas de build produit pour la fabriquer.

## 1. Cadrage

Créer le dossier et `manifest.md`.

| Champ | Règle |
|-------|--------|
| Date UTC | Horodatage de début |
| Opérateur | Rôle, pas un nom de personne |
| Périmètre semence | Liste fournie. Plancher, pas plafond |
| Horizon | Texte de l'opérateur, sinon « non déclaré — hypothèse à valider ». Aucun délai de remplacement |
| Critères business | Texte de l'opérateur, sinon la liste des critères utilisés plus bas, marqués hypothèse. Aucun chiffre d'affaires, trafic cible ou ROI inventé |
| Accès | analytics, CRM, Search Console, contrôleplane (Cloudflare, GitHub), coûts, backlinks, dépôts, moteurs GEO, PSI/CrUX : `disponible`, `inaccessible` ou `non configuré`, selon le vocabulaire |
| Dossier | Chemin privé |

**Fait quand** : `manifest.md` existe, le dossier est hors de ce dépôt, et chaque accès est un des trois états — pas une case vide.

## 2. Inventaire

Découvrir, puis classer. Sources autorisées : liste opérateur, liens sortants des pages déjà lues, redirections observées, DNS des noms fournis (NS, A/AAAA, CNAME, TXT), chaînes HTTP, contrôleplane authentifié (zones, déploiements, dépôts liés). Un nom absent de ces sources n'est pas ajouté par ressemblance.

Pour chaque domaine, une ligne dans `inventaire.md` :

| Colonne | Contenu |
|---------|---------|
| slug | `d01`… |
| domaine | valeur réelle, dossier privé seulement |
| rôle | un seul rôle primaire |
| principal | `oui` / `non` / `ambigu` |
| proxy | fournisseur d'edge si un en-tête ou un CNAME le prouve (exemple : `cf-ray` ou `server: cloudflare`). Sinon `non observé` |
| hébergeur | origine qui sert le contenu. « Zone sur un proxy » n'est pas un hébergeur. Si l'origine n'est pas prouvée : `inaccessible` |
| dépôt | URL canonique, ou `inaccessible` |
| branche / SHA HEAD | du pin, ou `inaccessible` |
| SHA déployé | preuve HEAD/prod. Metadata contrôleplane domaine+SHA+dirty acceptée. `dirty=true` consigné. Sinon `non mesurable` |
| objectif, audience, offre, conversion | extraits de pages publiques, ou `inaccessible` |
| mise en ligne | date opérateur, timestamp de déploiement du contrôleplane, ou première capture publique étiquetée comme capture et non comme lancement |
| propriété | rôle du titulaire. Nom de personne omis |
| analytics | disponibilité, identifiant sans secret |
| Search Console | lecture GSC. Absente d'un compte = `inaccessible` pour ce compte |
| conversions | attribution analytics ou CRM, séparée de Search Console. Jamais un chiffre Search Console, jamais zéro inventé |
| coûts, contraintes | contrôleplane de facturation ou export opérateur. Sinon `inaccessible` |

Rôles :

- `site` — sert l'offre. `principal` si l'opérateur le nomme, ou si les autres propriétés y envoient comme foyer. Si deux candidats restent, `ambigu` : aucun n'est choisi par défaut. Un satellite est un `site` dont `principal` = `non`.
- `redirect` — la réponse utile est une redirection, pas un document d'offre.
- `shortener` — le service mappe un chemin court vers une URL plus longue. Le hostname court ne suffit pas.
- `inactif` — ne sert plus l'offre : NXDOMAIN, parking, ou déclaration opérateur corroborée par l'absence de document d'offre. Une page parking reste une surface.

**Fait quand** : chaque domaine découvert a une ligne ; proxy et hébergeur sont deux colonnes ; HEAD et SHA déployé sont deux colonnes ; chaque champ qualitatif a une disponibilité ; la méthode de découverte et son résultat sont dans le manifest. Un rôle n'est pas déduit du seul nom.

## 3. Pin des dépôts

Pour chaque dépôt `disponible` : cloner en frais, noter remote, branche par défaut, SHA HEAD, dirty state du checkout local (`ignoré` si sale). Lire la CI et, si le contrôleplane GitHub est accessible, déploiements, environnements et protections. Branche ou tag visé = intention, pas preuve de prod.

Dépôt absent des pages, des en-têtes, de la déclaration opérateur et du contrôleplane GitHub accessible : `inaccessible`. Pas de recherche au hasard de forges.

**Fait quand** : chaque ligne d'inventaire a un pin ou `inaccessible`, et aucun checkout local sale n'a été modifié.

## 4. Gel du corpus

Écrire `corpus.md` avant toute observation GEO. Marque = chaîne lisible dans le titre, le logo ou `Organization.name` du principal. Si la marque est inconnue, les questions « avec marque » sont `non mesurable` et le gel le dit.

Quinze questions, libellé exact, langue et locale fixées :

| id | type | marque | nombre |
|----|------|--------|--------|
| I1–I6 | informationnelle | non | 6 |
| IM1–IM3 | informationnelle | oui | 3 |
| C1–C3 | commerciale | non | 3 |
| CM1–CM3 | commerciale | oui | 3 |

Les libellés viennent des sujets visibles (titres, H1, offre). Confiance `faible` si le sujet est seulement implicite. Après la première observation, le corpus ne gagne ni ne perd de question.

**Fait quand** : quinze libellés figés, ou le sous-ensemble marque marqué `non mesurable` avec la raison, et l'heure de gel est écrite.

## 5. Fiche — branche `site`

Copier le squelette [Fiche](#fiche) vers `domaines/<slug>/fiche.md`. Renseigner les quatre axes. Une URL d'échantillon absente de l'inventaire n'est pas inventée : le créneau est `non applicable` avec la raison.

### SEO

Séparer trois faits : **indexabilité** (robots, `noindex`, canonical, code HTTP — la page peut être indexée), **indexation** (elle l'est, d'après une lecture GSC), **classement** (position sur une requête, même lecture). L'un ne prouve pas le suivant. Un crawl entravé ne tranche aucun des trois.

| Objet | Preuve attendue | Si l'accès manque |
|-------|-----------------|-------------------|
| Intentions | Requêtes marque / hors marque, lecture GSC. Périodes de même longueur. Âge de la propriété et saison notés. Pas d'annualisation si la propriété est plus jeune que la fenêtre | `non mesurable` |
| Concurrence | Outil SERP déjà autorisé, export opérateur, ou lecture publique d'un document concurrent explicitement découvert. Search Console observe les requêtes et pages propres, pas les URL concurrentes | `non mesurable`. Pas de scrape de page de résultats |
| Originalité, profondeur, expertise, preuves | Pages du pin et HTML servi : auteur, sources, données propres, date. L'absence de preuve est « preuve non publiée », pas « expertise absente » | — |
| Crawl et rendu | HTML brut. Rendu navigateur si un navigateur est disponible. Écart brut/rendu consigné | rendu `non mesurable` si pas de navigateur ; le HTML brut reste dû |
| robots, sitemap, canonicals, redirects | Fichiers et en-têtes servis | — |
| hreflang | Seulement si plusieurs langues ou régions sont servies. Sinon `non applicable` | — |
| Status, meta, données structurées | Code, title, meta, JSON-LD comparé au texte visible. Un schéma spécial n'est pas une condition de classement | — |
| Liens internes | Graphe des URL échantillonnées | — |
| Backlinks | Export opérateur ou outil déjà accessible | `non mesurable` |
| Search Console | Impressions, clics, CTR, marque / hors marque, fenêtres comparables. Pas les conversions | Absente d'un compte = `inaccessible` pour ce compte, mesures `non mesurable`. Pas `non configuré` sans preuve d'absence |
| Conversions | Attribution analytics ou CRM, pas Search Console. Action configurée et lisible | `non configuré` ou `inaccessible`, jamais zéro inventé |

Risques doorway, link spam, scaled content, doublons : un constat nomme la politique seulement avec des URL et un extrait qui correspondent aux exemples de la [politique spam](https://developers.google.com/search/docs/essentials/spam-policies). Le nombre de domaines, un texte « qui semble généré » ou un satellite ne suffisent pas. Sinon le constat dit « doublon observé » ou « intention proche », gravité `observation`.

**Fait quand** : chaque ligne du tableau a un statut ; indexabilité, indexation et classement sont trois lignes ; aucun risque de politique n'est posé sans URL.

### GEO

GEO (Generative Engine Optimization) observe si des moteurs citent le portefeuille. Trois accès restent distincts :

| Accès | Exemple officiel | Conséquence si le texte est bloqué |
|-------|------------------|-------------------------------------|
| Crawl de recherche | `Googlebot` ; `OAI-SearchBot` | Exploration entravée pour cet agent. L'indexation se vérifie à part, par lecture GSC. Le blocage ne rend pas la page non éligible ni non indexée. Les autres accès restent distincts |
| Crawl d'entraînement | `Google-Extended` ; `GPTBot` | Signal d'entraînement, pas un classement Search |
| Fetch déclenché par l'utilisateur | `ChatGPT-User` (robots.txt peut ne pas s'appliquer) | Une règle robots ne prouve pas l'absence au moment de la question |

Source : [fonctionnalités IA Google](https://developers.google.com/search/docs/appearance/ai-features), [bots OpenAI](https://developers.openai.com/api/docs/bots). Les noms sont des exemples, pas une liste fermée. Pour chaque moteur réellement interrogé, noter quel accès la réponse utilise.

`llms.txt`, un fichier « AI » ou un schéma spécial : fait d'inventaire. Ce n'est pas une condition Google. Google indique qu'aucun fichier machine ni schéma dédié n'est requis pour AI Overviews ou AI Mode.

Mesure, seulement si l'opérateur a déjà un accès au moteur (pas de création de compte) :

- mêmes moteur, mode (recherche classique, aperçu IA, chat), langue et locale que le gel ;
- au moins 3 observations par question, contextes neufs, méthode de fraîcheur écrite ;
- réponse intégrale datée dans `raw/` ;
- par observation : mention, URL citée exacte ou aucune, exactitude (`correct` / `partiel` / `incorrect` / `non évaluable`) jugée contre le HTML du pin, referral ;
- agrégat `n/N` par question et par domaine.

Referral = session analytics dont la source est ce moteur, sur une période comparable. Sans analytics segmenté, referral = `non mesurable`. Mention, citation, exactitude et referral restent quatre colonnes.

Search Console : AI Overviews et AI Mode sont inclus dans le type Web. Les totaux Web restent des totaux Web. Les en extraire est `non mesurable` sauf lecture GSC qui les sépare.

Moteur inaccessible : chaque cellule de ce moteur est `non mesurable`. Ce n'est pas une absence de citation. Aucune autorité IA unique. Aucune causalité tirée d'une mention.

**Fait quand** : le corpus gelé est celui qui a été mesuré ; chaque question × moteur accessible a `n/N` et des réponses archivées ; chaque moteur inaccessible a un blocage ; les quatre colonnes ne sont pas fusionnées.

### Sécurité et qualité

Classer la **surface** d'abord. Le contrôle hors surface est `non applicable`.

| Contrôle | static | form | auth | functions |
|----------|--------|------|------|-----------|
| TLS, en-têtes, cache | mesurer | mesurer | mesurer | mesurer |
| Scripts tiers | mesurer | mesurer | mesurer | mesurer |
| CORS | `non applicable` sans API publique | idem | idem | mesurer si une réponse publique porte `Access-Control-Allow-Origin` |
| Validation, privacy, consentement | `non applicable` | lire le formulaire et les mentions, ne pas envoyer | lire la page de connexion publique | selon endpoints publics |
| Auth | `non applicable` | `non applicable` | lire la source du pin et les cookies d'une réponse publique. Pas de tentative de login | idem si l'endpoint exige une session |

En-têtes à consigner sur chaque URL échantillon, présence ou absence : HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, contrôle de frame. L'absence est un constat `à corriger` si la surface sert du HTML public ; elle n'est pas une faille prouvée. TLS : certificat servi, échéance, hostname. Pas de balayage de ports.

Scripts tiers : `src`, hôte, finalité visible, bannière de consentement oui/non. La bannière ne prouve pas le blocage réel : le comparer au HTML servi.

Secrets : motifs dans le pin et l'historique Git du clone frais. Rapport masqué. Alerte de dépendance : export déjà accessible (onglet sécurité, advisory) lu contre le lockfile. Atteignabilité = import lu dans un chemin servi. Exploitabilité = conditions de l'advisory réunies par une preuve, sans procédure d'exploitation dans la fiche. Les trois colonnes restent séparées. Les dépendances du produit ne s'installent pas. L'outillage d'audit suit la règle Outillage.

Actions GitHub : YAML du pin, et contrôleplane GitHub s'il est accessible (permissions effectives, environnements prod / preview, protections, noms de secrets). Clé `permissions` absente et API muette = `non mesurable` pour le scope effectif. Pin d'action : SHA ou ref mutable. `pull_request_target` avec checkout du code de PR : citer les lignes. Ref mutable sur un workflow qui touche un secret ou la prod : `à corriger`. Le même ref sans secret et sans prod : `observation`.

Reproductibilité : lockfile présent ou absent est un signal. Sans exécution du build, la reproductibilité reste `non vérifiée` — la présence du lockfile n'est pas une preuve. Duplication et cadence de mise à jour entre dépôts, lues dans les fichiers. Comportements critiques (allowlist de redirect, handler de formulaire, session) : citer les tests déjà dans le pin, ou leur absence. Les suites produit ne sont pas lancées. Pas de lint ni de build produit.

**Fait quand** : la surface est écrite ; chaque contrôle est un statut ; secrets masqués ; alertes, atteignabilité et exploitabilité sont trois colonnes.

### Performance

Échantillon, URL finales après redirection, toutes servies par le SHA déployé ou, à défaut, par le même jour d'observation :

- accueil ;
- pages d'acquisition dont la conversion est visible (contact, inscription, achat). Aucune page de ce type : créneau `non applicable` ;
- au moins une URL par type de template existant dans le pin ou dans les motifs d'URL. Un type sans URL 200 : `non applicable` ;
- interactions critiques (menu, focus de champ, accordéon) exercées dans un navigateur, sans envoi de formulaire.

Lab : 3 runs mobile et 3 runs desktop, même outil, même URL, même jour, même révision. Consigner les 6 valeurs, la médiane, le min et le max. Un run en échec passe par les voies lab disponibles et proportionnées (PSI, puis Lighthouse local épinglé). Un échec qui reste est un trou `non mesurable`, jamais une valeur comblée. Mobile et desktop ne sont pas mélangés. Si l'écart min–max du médian change de bucket Good / Needs Improvement / Poor, la série est instable et la confiance lab est `faible`.

Outil : PSI si accessible, sinon Lighthouse local via l'outillage isolé épinglé, étiqueté `lab local`. PSI lab simule un mobile milieu de gamme bridé et un desktop filaire ; copier le bloc d'environnement (lieu inclus). Le score Lighthouse est consigné et n'est pas un rang.

Champ : CrUX, p75, fenêtre 28 jours, URL et origine séparées, mobile et desktop séparés, pour LCP, INP, CLS. Un repli PSI vers l'origine est copié dans la ligne origine, pas dans la ligne URL. Donnée insuffisante = `non mesurable`, pas un succès. Un assessment PSI qui ignore un INP manquant n'est pas repris comme statut INP.

Seuils champ, p75, [Web Vitals](https://web.dev/articles/vitals) et [PSI](https://developers.google.com/speed/docs/insights/v5/about). Ces colonnes classent la métrique. Elles ne sont pas la gravité du constat, ni le statut d'axe, ni le statut de fiche. Gravité et impact se jugent à part.

| Métrique | Good | Needs Improvement | Poor |
|----------|------|-------------------|------|
| LCP | ≤ 2,5 s | ≤ 4 s | > 4 s |
| INP | ≤ 200 ms | ≤ 500 ms | > 500 ms |
| CLS | ≤ 0,1 | ≤ 0,25 | > 0,25 |

Lighthouse standard ne mesure pas l'INP. TBT est un indicateur lab complémentaire, consigné à part, jamais copié dans la colonne INP. INP sans CrUX = `non mesurable`.

Causes (waterfall, images, fonts, JS, tiers, TTFB, cache) : seulement si une trace lab ou un waterfall les montre. La lecture du code annote une cause déjà tracée ; elle ne la crée pas.

Preuve visuelle : capture datée, URL, viewport, dans `raw/`, pour chaque URL échantillonnée. Sans navigateur, la preuve visuelle est `non mesurable` ; les runs lab restent dus s'ils existent.

**Fait quand** : la table d'échantillon est complète ; chaque URL a 3+3 runs ou un blocage par run manquant ; médiane et dispersion sont écrites ; CrUX URL, CrUX origine et manques sont trois lignes ; aucun score n'est traité comme un rang.

## 6. Fiche — branche `redirect`

Même squelette. Les quatre axes existent ; les objets sans document sont `non applicable`, pas omis.

- Inventaire complet, y compris chaîne : chaque saut (URL, status, `Location`, schéma, hôte, chemin, query conservée ou perdue). Une boucle est `critique`. Un saut au-delà du premier est une `observation` à justifier, pas une faute automatique.
- SEO : le redirect n'est pas un document. Indexabilité de page = `non applicable`. Canonical utile = cible. Classement de l'URL de redirect = `non mesurable` sans lecture GSC, jamais un rang inventé.
- GEO : `non applicable`, sauf si une réponse archivée cite cette URL — alors mesurer cette citation.
- Sécurité : TLS du saut, HSTS, cible construite dans le pin (allowlist ou cible fixe). Pas d'injection de paramètre.
- Performance : TTFB du saut, 3+3 si l'outil le donne. LCP, INP, CLS = `non applicable`.

**Fait quand** : la chaîne est complète et chaque axe a un statut, y compris les `non applicable` justifiés.

## 7. Fiche — branche `shortener`

- Résoudre les slugs fournis par l'opérateur, liés depuis une page du portefeuille, ou listés par un contrôleplane autorisé. Pas d'énumération.
- Destination, status, destination dans le portefeuille ou non, schéma `https` ou non.
- Clics : lecture analytics (export ou UI authentifiée datée), sinon `inaccessible`. Pas de formulaire de stats.
- SEO : robots et en-têtes. Classement `non applicable` sauf si l'URL courte est une page dans la lecture GSC.
- GEO : `non applicable`, sauf citation archivée de l'URL courte.
- Sécurité : allowlist lue dans le pin, ou `inaccessible`. Une destination externe observée est une `observation` ; elle devient `à corriger` seulement si la source montre une cible contrôlée par l'appelant.
- Performance : CWV `non applicable`. TTFB du saut si mesuré.

**Fait quand** : chaque slug résolu a une destination prouvée, et les slugs non listés ne sont pas devinés.

## 8. Fiche — branche `inactif`

- DNS et HTTP observés (NXDOMAIN, parking, erreur). Coût résiduel : contrôleplane de facturation, export, ou `inaccessible`.
- Indexation résiduelle : lecture GSC. Sans cette lecture, `non mesurable`.
- SEO document, GEO et CWV : `non applicable` s'il n'y a pas de document d'offre. Une page parking a une surface sécurité minimale (TLS, contenu servi).
- Le rôle `inactif` ne décide pas `arrêter` à lui seul.

**Fait quand** : la fiche existe et distingue « pas de surface » de « surface non mesurée ».

## Fiche

Squelette obligatoire :

```markdown
# <slug> — <rôle>

## Identité
domaine, pin HEAD, SHA déployé, hébergeur, proxy, surface, révision de fiche

## Disponibilités
analytics, CRM, Search Console, backlinks, coûts, conversions, CrUX, moteurs GEO, contrôleplane

## Échantillon
URL, template, raison d'inclusion

## Axes
| axe | statut | limite |
|-----|--------|--------|
| SEO | | |
| GEO | | |
| sécurité | | |
| performance | | |

## Constats
| id | axe | gravité | confiance | preuve | révision | portée | impact | action | effort |
|----|-----|---------|-----------|--------|----------|--------|--------|--------|--------|

## Mesures
tables SEO, GEO n/N, lab min/médiane/max, CrUX p75 URL et origine

## Limites
données tiers manquantes, données commerciales manquantes, blocages verbatim

## Top 5
cinq actions au plus, chacune citant un id de constat. Moins de cinq si moins de constats actionnables.
```

`effort` : `S` un fichier ou une config, `M` un site, `L` plusieurs dépôts ou une migration. Pas d'heures inventées.

Id : `F-<slug>-<n>`.

**Fait quand** : le fichier existe, les quatre axes ont un statut, les disponibilités manquantes sont explicites, et le top 5 ne cite que des constats de cette fiche.

## 9. Gate

Ouvrir la synthèse seulement si, pour chaque ligne d'inventaire, `domaines/<slug>/fiche.md` existe et ses quatre axes ont un statut. Une fiche manquante se rédige. Elle ne se retire pas de l'inventaire.

**Fait quand** : le manifest a une table de couverture `slug → fiche → quatre statuts`, sans trou.

## 10. Synthèse réseau

Écrire `synthese.md` après la gate. Chaque chiffre vient d'une fiche ou est `non mesurable`.

| Question | Règle |
|----------|--------|
| Intentions | Recouvrement des intentions on-page entre propriétés, avec URL |
| Cannibalisation | Deux propriétés avec des impressions sur la même requête = chevauchement, pas une cannibalisation nuisible. Confirmée seulement avec un effet de substitution, une perte, ou un contexte SERP qui le montre. Sinon « risque de cannibalisation ». Sans lecture GSC, le chevauchement on-page reste « intentions proches » |
| Maillage | Liens observés entre propriétés dans le HTML échantillonné. L'absence est un fait, pas une faute automatique |
| Originalité | Paires de pages au texte substantiellement identique, ou preuves propres citées |
| Contribution observée | Clics ou sessions si la donnée existe. Total, pas un effet causal |
| Contribution hors renvoi | Part de cette contribution dont la source n'est pas le principal, si le segment existe. Observation, pas une incrémentalité |
| Incrémentalité | Différence causale contre le scénario sans ce site. Exige un contre-factuel, une expérience, ou une méthode justifiée et écrite. Sinon `non mesurable`. Soustraire les referrals du principal n'est pas une incrémentalité |
| Coûts, ROI attribuable | ROI seulement si coût et valeur de conversion attribuée existent sur la même période. Sinon `non mesurable` |
| Maintenance | Dépôts, lockfiles, workflows, écarts de pin |
| Concentration | Nombre de propriétés par proxy, par hébergeur, par dépôt, par propriété analytics |

**Test d'utilité sans renvoi principal**, pour chaque propriété non principale. La juger comme si le principal ne la liait pas :

1. Public et besoin, d'après l'offre servie.
2. Valeur originale : preuve, profondeur, objet que le principal ne porte pas.
3. Parcours utile sans lien entrant depuis le principal.
4. Acquisition hors renvoi : donnée complémentaire, lue avec l'âge et l'horizon. Elle ne décide pas seule. Une visite n'est pas un succès, zéro n'est pas un échec, surtout si le site est plus jeune que l'horizon ou si la mesure manque.

Valeur propre lisible et acquisition non encore mesurable : décision `conditionnelle` ou `expérimentale`, recommandations atteignables conservées. Valeur propre illisible : `différer faute de preuve`. Un site neuf n'est pas différé par défaut.

Alternative de consolidation : un paragraphe, même si la décision est de conserver. Ce qui fusionnerait, ce qui serait perdu, delta de coût seulement s'il est connu.

Décision primaire, une par domaine, chacune citant des id de constats ou un manque de preuve. Elle peut porter le qualificatif `conditionnelle` ou `expérimentale`.

| Décision | Quand |
|----------|--------|
| conserver / développer | valeur propre ou rôle principal. Acquisition non mesurable : qualificatif `conditionnelle` ou `expérimentale`, recommandations atteignables conservées |
| différencier | intentions proches et valeur ou parcours distinct. L'acquisition manquante ne l'interdit pas |
| fusionner / rediriger | même intention, valeur propre non établie, cible nommée |
| arrêter | `inactif`, ou absence de public, de besoin et de parcours, avec coût ou risque résiduel prouvé. Un trafic nul plus jeune que l'horizon ne suffit pas |
| différer faute de preuve | la valeur propre elle-même ne peut pas être lue |

Une migration éventuelle est une ligne « recommandée, hors mandat ». Elle n'est pas exécutée.

Top 5 portefeuille : cinq actions, id de constat, effort, propriété concernée. Un `critique` figure dans ces cinq ou le texte dit pourquoi il est déjà couvert par une action listée.

Limites finales : recopier chaque `non mesurable` de la couverture. Horizon et critères business non déclarés restent marqués « hypothèse à valider ».

**Fait quand** : chaque domaine a une décision primaire ; le test d'utilité est renseigné pour chaque propriété non principale ; aucun chiffre hors preuve ; le top 5 cite des constats ; les manques tiers et commerciaux sont listés.

## Références

- [Spam policies](https://developers.google.com/search/docs/essentials/spam-policies)
- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Page experience](https://developers.google.com/search/docs/appearance/page-experience)
- [About PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/about)
- [Web Vitals](https://web.dev/articles/vitals)
- [Overview of OpenAI Crawlers](https://developers.openai.com/api/docs/bots)
