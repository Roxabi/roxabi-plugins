# Analyse : Task Master — Gestion du state de workflow

> Analyse comparative entre l'approche de Task Master (eyaltoledano/claude-task-master)
> et la proposition roxabi-plugins #42 (XDG state file pour dev-core).

**Date :** 2026-03-08
**Repo analysé :** [eyaltoledano/claude-task-master](https://github.com/eyaltoledano/claude-task-master) — ⭐ 25 827 étoiles
**Issue de référence :** [roxabi-plugins #42](https://github.com/Roxabi/roxabi-plugins/issues/42)

---

## 1. Architecture générale de Task Master

Task Master est un système de gestion de tâches orienté agents IA, publié sur npm (`task-master-ai`), conçu pour s'intégrer dans des éditeurs (Cursor, Windsurf, Lovable) via un serveur MCP (Model Context Protocol). Il gère des projets décomposés en tâches avec statuts, dépendances, sous-tâches et complexité. La version analysée est v0.17+.

### 1.1 Structure de fichiers — `.taskmaster/`

Tout l'état projet est stocké dans un répertoire `.taskmaster/` à la racine du projet :

```
.taskmaster/
├── config.json        # Configuration modèles IA, paramètres globaux
├── state.json         # État runtime : tag actif, métadonnées, timestamps
├── tasks/
│   └── tasks.json     # Les tâches (format taggé depuis v0.16.2)
├── reports/           # Rapports de complexité IA (JSON, un par tag)
├── docs/              # PRDs, recherches, roadmaps
└── loop-progress.txt  # Journal de progression (texte brut)
```

### 1.2 `tasks.json` — Structure taggée (v0.16.2+)

Depuis la v0.16.2, le format est un objet indexé par **tags** (contextes) :

```json
{
  "master": {
    "tasks": [
      {
        "id": 1,
        "title": "Implement user authentication",
        "description": "Create a secure authentication system using JWT tokens",
        "status": "pending",
        "dependencies": [2, 3],
        "priority": "high",
        "details": "Use GitHub OAuth client ID/secret, handle callback...",
        "testStrategy": "Test login/logout flow with valid and invalid credentials",
        "subtasks": [
          {
            "id": 1,
            "title": "Configure OAuth",
            "description": "Set up OAuth configuration",
            "status": "done",
            "dependencies": [],
            "details": "Configure GitHub OAuth app and store credentials",
            "testStrategy": null
          }
        ]
      }
    ]
  },
  "feature-auth": {
    "tasks": [...]
  }
}
```

**Statuts valides (tâches) :** `pending`, `in-progress`, `blocked`, `done`, `review`, `deferred`, `cancelled`
**Statuts valides (sous-tâches) :** `pending`, `done`, `completed`
**Priorités valides :** `low`, `medium`, `high`, `critical`

**Design clé :** chaque tag a sa propre séquence d'IDs (isolation complète). La migration depuis l'ancien format `{"tasks": [...]}` est automatique et transparente (→ tag `"master"`).

### 1.3 `state.json` — État runtime

Fichier minimal gérant le contexte actif du projet :

```json
{
  "currentTag": "loop",
  "lastUpdated": "2025-11-28T02:21:32.160Z",
  "lastSwitched": "2026-01-08T17:48:52.356Z",
  "migrationNoticeShown": true,
  "metadata": {
    "upgradePrompts": {
      "triggers": { ... },
      "metrics": {
        "totalTaskCount": 0,
        "tagCount": 0,
        "listCommandCount": 0,
        "tasksWithDependencies": 0
      },
      "lastUpdated": "...",
      "version": "1.0.0"
    },
    "exportedTags": {
      "feature-branch": {
        "briefId": "uuid",
        "briefUrl": "http://...",
        "exportedAt": "..."
      }
    }
  },
  "branchTagMapping": {}
}
```

Ce fichier est géré par `RuntimeStateManager` (`packages/tm-core/src/modules/config/services/`). Il supporte un override via `TASKMASTER_TAG` (variable d'environnement) pour les pipelines CI.

### 1.4 `WorkflowStateManager` — État workflow TDD (couche supérieure)

Pour les sessions longues avec workflow TDD, Task Master dispose d'un gestionnaire d'état **hors du projet** :

```
~/.taskmaster/{project-id}/sessions/
├── workflow-state.json    # Phase TDD, arbre de tâches, contexte de session
├── activity.jsonl         # Journal d'activité ligne par ligne
└── backups/               # Sauvegardes horodatées (5 max, rotation automatique)
```

**Génération du `project-id` :** le chemin absolu du projet est sanitisé (identique au pattern de Claude Code) :
```
/home/user/projects/foo  →  -home-user-projects-foo
```

**Écriture atomique :** la librairie `steno` gère le queuing et l'écriture via temp file + rename. Cela garantit l'absence de corruption même en cas d'écriture concurrente.

**Structure `WorkflowState` :**
- `phase` : `PREFLIGHT | BRANCH_SETUP | SUBTASK_LOOP | FINALIZE | COMPLETE`
- `context.currentSubtaskIndex` : progression dans la liste de sous-tâches
- `context.currentTDDPhase` : `RED | GREEN | COMMIT`
- `context.errors` : liste des erreurs récupérables par phase
- `context.lastTestResults` : résultats du dernier run de tests

### 1.5 Couche de stockage `FileStorage` — Interface `IStorage`

L'interface de stockage est définie dans `packages/tm-core/src/common/interfaces/storage.interface.ts`. Elle expose :

- `loadTasks(tag?)` / `saveTasks(tasks, tag?)` / `updateTask(id, updates, tag?)`
- `updateTaskStatus(id, newStatus, tag?)` → retourne `{success, oldStatus, newStatus, taskId}`
- `getAllTags()` / `createTag()` / `deleteTag()` / `renameTag()` / `copyTag()`
- **`watch(callback, options?)`** → retourne `{unsubscribe}` — utilise `fs.watch()` avec debounce (100ms par défaut)

L'implémentation `FileStorage` inclut :
- **File locking cross-process** (évite les writes concurrents)
- **Atomic writes** via temp file + `rename()` (POSIX atomique)
- **Re-read inside lock** (évite les updates perdus sur snapshot stale)
- **Stale lock detection** avec timeout 10 secondes

### 1.6 Exposition via MCP (Model Context Protocol)

Le serveur MCP expose **36 outils** dont :

| Outil | Description |
|-------|-------------|
| `set_task_status` | Définit le statut d'une ou plusieurs tâches/sous-tâches |
| `next_task` | Retourne la prochaine tâche éligible (dépendances résolues, priorité) |
| `get_operation_status` | Polling sur opérations asynchrones (retourne `{status, result, error}`) |
| `list_tags` | Liste tous les contextes disponibles |
| `use_tag` | Switche le contexte actif |
| `expand_task` | Génère des sous-tâches via IA |
| `parse_prd` | Génère des tâches à partir d'un PRD |

Le polling se fait **par appel d'outil** : pas de WebSocket, pas de push. Un agent appelle `get_operation_status` avec un `operationId` pour suivre une opération longue (analyze-complexity, parse-prd, etc.).

### 1.7 Résumé des localisations d'état

| Composant | Localisation | Contenu |
|-----------|-------------|---------|
| Tâches | `.taskmaster/tasks/tasks.json` (dans le projet) | Toutes les tâches, tags, statuts |
| Tag actif | `.taskmaster/state.json` (dans le projet) | Tag courant, métadonnées légères |
| Workflow TDD | `~/.taskmaster/{project-id}/sessions/` (global) | Phase TDD, progression, backups |
| Config | `.taskmaster/config.json` (dans le projet) | Modèles IA, paramètres globaux |
| Rapports | `.taskmaster/reports/task-complexity-report.json` | Complexité IA par tâche |

---

## 2. Comparaison avec roxabi-plugins #42

### 2.1 Objectif divergent mais complémentaire

| Aspect | Task Master | roxabi-plugins #42 |
|--------|-------------|-------------------|
| **But** | Gérer les tâches d'un projet IA | Exposer l'étape courante du workflow dev-core à des outils externes |
| **Consommateur** | L'agent IA lui-même (lecture/écriture) | tmux, statusbar, dashboards (lecture seule) |
| **Localisation** | `.taskmaster/` dans le projet + `~/.taskmaster/` pour TDD | `~/.local/state/dev-core/<project-hash>.json` (XDG) |
| **Scope** | Gestion de projet complète | Signal de step léger |
| **Format** | JSON riche (tasks, deps, subtasks, TDD phases) | JSON minimal (step, issue, title, ts) |
| **Standard** | `~/.taskmaster/` (non-standard) | XDG Base Directory Spec (`~/.local/state/`) |

### 2.2 Ce que Task Master fait que #42 ne fait pas (features non-requises)

- **Tagged contexts** : plusieurs contextes de travail dans un même projet (branches, features). Très puissant pour les worktrees.
- **Dependency graph** : DAG de dépendances avec détection de cycles.
- **Complexity analysis** : rapport IA, recommandations de sous-tâches.
- **MCP server** : 36 outils disponibles pour les agents.
- **Loop/TDD workflow** : machine à états persistante avec sauvegardes.
- **Watch interface** : `fs.watch()` sur `tasks.json` pour réagir aux changements.

### 2.3 Ce que #42 fait mieux que Task Master

- **XDG compliance** : `~/.local/state/` est la bonne localisation selon la spec XDG. Task Master utilise `~/.taskmaster/` (non-standard, pollue le `$HOME`).
- **Multi-session par design** : un fichier par projet, pensé pour être consommé sans couplage.
- **Légèreté** : 5 champs. Pas de gestion de tâches — juste un signal de step.

### 2.4 Points de convergence remarquables

1. **Project hash pour isolation multi-sessions** : Task Master génère un `project-id` en sanitisant le chemin absolu (même pattern que Claude Code). La prop #42 utilise MD5. Les deux évitent les collisions multi-projets.

2. **État hors du projet pour le runtime long** : Le `WorkflowStateManager` de Task Master a fait exactement ce choix pour la couche TDD — "Stores workflow state in global user directory to avoid git conflicts and support multiple worktrees." C'est **la même justification** que #42 pour utiliser XDG.

3. **Écriture atomique** : Task Master utilise `steno` (temp + rename). La prop #42 prescrit le même pattern. Identique.

4. **Override par variable d'environnement** : Task Master supporte `TASKMASTER_TAG`. Utile pour les pipelines CI. À considérer pour dev-core.

---

## 3. Recommandations pour l'implémentation #42

### 3.1 Garder la philosophie XDG — c'est la bonne décision

Task Master lui-même a migré ses sessions TDD vers `~/.taskmaster/` après avoir réalisé que stocker dans le projet causait du bruit git et des conflits sur les worktrees. La prop #42 fait ce choix dès le départ avec en plus le respect du standard XDG. Ne pas changer cette décision.

### 3.2 Adopter le project-id lisible plutôt que MD5

Le pattern de Task Master (et de Claude Code lui-même) sanitize le chemin absolu :
```
/home/mickael/projects/2ndBrain  →  -home-mickael-projects-2ndBrain
```

C'est plus lisible qu'un MD5 tronqué lors d'un `ls ~/.local/state/dev-core/`. Considérer ce format plutôt que `md5sum | cut -c1-16`.

**Exemple résultant :**
```
~/.local/state/dev-core/-home-mickael-projects-2ndBrain.json
```

### 3.3 Ajouter un champ `worktree` au schéma (optionnel)

Task Master a introduit les tags précisément pour les worktrees parallèles. Deux worktrees du même repo ont des `cwd` différents → hashes différents → pas de collision. Documenter ce comportement et optionnellement ajouter :

```json
{
  "step": "implement",
  "issue": 42,
  "title": "Dark mode toggle",
  "project": "/home/mickael/projects/foo",
  "worktree": "/home/mickael/projects/foo-feat-42",
  "ts": 1741430400
}
```

### 3.4 TTL implicite via le champ `ts`

Task Master a `lastUpdated` et `lastSwitched` pour détecter les sessions mortes. Pour #42, le consommateur (script tmux) devrait ignorer les fichiers dont `ts` a plus de N minutes (ex : 30 min). Cela évite d'afficher un step "implement" pour une session Claude Code fermée.

Pas besoin d'un champ `expires` — laisser la logique côté consommateur.

### 3.5 Ajouter `DEV_CORE_STATE_PATH` optionnel

Override par variable d'environnement pour les pipelines CI qui n'ont pas de `$HOME` standard ou veulent écrire ailleurs. Pattern directement inspiré de `TASKMASTER_TAG` et `XDG_STATE_HOME`.

### 3.6 Écriture atomique — `rename()` sans dépendance externe

La prop #42 est implémentée en TypeScript/Bun. Le pattern natif suffit, pas besoin de `steno` :

```typescript
const tmp = statePath + '.tmp.' + process.pid;
await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
await fs.promises.rename(tmp, statePath);  // atomic sur POSIX (même filesystem)
```

Ajouter `process.pid` au suffixe `.tmp` pour éviter les collisions si deux processes écrivent simultanément (peu probable mais défensif).

### 3.7 Ne pas co-localiser avec `~/.taskmaster/`

Task Master expose `~/.taskmaster/{project-id}/sessions/`. On pourrait écrire dans ce répertoire pour les projets qui utilisent les deux. Mais `~/.local/state/dev-core/` est préférable car :
- Indépendant de Task Master
- Suit le standard Linux (même convention que `~/.local/state/claude/`)
- Ne crée pas de couplage

---

## 4. Synthèse — Table de décision

| Décision Task Master | Application pour roxabi-plugins #42 | Verdict |
|----------------------|--------------------------------------|---------|
| État hors du projet pour éviter le bruit git | XDG `~/.local/state/dev-core/` | ✅ Déjà fait, meilleur que TM |
| Project-id lisible (chemin sanitisé) | Remplacer MD5 par chemin sanitisé | Recommandé |
| Écriture atomique (temp + rename) | `fs.promises.rename()` natif | ✅ Déjà dans la prop |
| Override par env var | Ajouter `DEV_CORE_STATE_PATH` | Ajouter |
| `lastUpdated` dans chaque write | `ts` Unix timestamp | ✅ Déjà dans la prop |
| Discovery multi-sessions | `--list` lisant tous les fichiers du dir | Ajouter |
| Isolation multi-projets | Hash par `cwd` | ✅ Déjà dans la prop |

**Conclusion :** La prop #42 est bien conçue et plus propre que Task Master sur la localisation (XDG > `~/.taskmaster/`). Les enrichissements principaux sont : (1) project-id lisible plutôt que MD5, (2) variable d'environnement d'override, (3) mode `--list` pour discovery multi-sessions.
