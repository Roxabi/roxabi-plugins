# Playbook: Syncthing Setup for Multi-Machine Sync

> Keep shared data directories in bidirectional real-time sync between two machines using Syncthing.

**Proven on:** ROXABITOWER (local) <-> roxabituwer (production at 192.168.1.16)

---

## Synced Folders

| Folder ID | Path | Purpose |
|-----------|------|---------|
| `agent-sync` | `~/.agent` | Exploration artifacts, diagrams, brand assets (~464MB, ~3200 files) |
| `claude-projects-sync` | `~/.claude/projects` | Claude Code memory, conversation history, project configs |
| `lyra-sync` | `~/.lyra` | Lyra agent data |
| `vault-sync` | `~/.roxabi-vault` | Roxabi knowledge vault |
| `default` | `~/Sync` | General file sync |

---

## Why Syncthing

- `~/.agent/` contains images, MP4s, diagrams — too large/binary for git
- `~/.claude/projects/` contains memory and conversation history — needed on both machines
- Two machines need the same content, edits happen on both sides
- Syncthing: bidirectional, real-time, no cloud, no manual push/pull, set-and-forget

---

## Prerequisites

- Two Linux machines with SSH access between them
- Target directories exist on both machines
- `apt` package manager (adjust for other distros)

---

## Step 1: Install

```bash
# Local
sudo apt-get install -y syncthing

# Production
ssh PROD_HOST 'sudo apt-get install -y syncthing'
```

Verify:
```bash
syncthing --version
ssh PROD_HOST 'syncthing --version'
```

---

## Step 2: Enable as user service

```bash
# Local
systemctl --user enable --now syncthing

# Production
ssh PROD_HOST 'systemctl --user enable --now syncthing'
```

This auto-starts Syncthing on boot (requires `loginctl enable-linger $USER` on headless servers).

Verify:
```bash
systemctl --user is-active syncthing
ssh PROD_HOST 'systemctl --user is-active syncthing'
```

---

## Step 3: Get device IDs and API keys

```bash
# Device IDs
LOCAL_ID=$(syncthing cli show system | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")
PROD_ID=$(ssh PROD_HOST 'syncthing cli show system' | python3 -c "import sys,json; print(json.load(sys.stdin)['myID'])")

# API keys
LOCAL_API=$(syncthing cli config gui apikey get)
PROD_API=$(ssh PROD_HOST 'syncthing cli config gui apikey get')

echo "Local ID:  $LOCAL_ID"
echo "Prod ID:   $PROD_ID"
echo "Local API: $LOCAL_API"
echo "Prod API:  $PROD_API"
```

---

## Step 4: Pair devices

```bash
# Add production device to local
curl -s -X POST "http://127.0.0.1:8384/rest/config/devices" \
  -H "X-API-Key: $LOCAL_API" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceID\": \"$PROD_ID\",
    \"name\": \"production\",
    \"addresses\": [\"tcp://PROD_IP:22000\"],
    \"autoAcceptFolders\": false
  }"

# Add local device to production
ssh PROD_HOST "curl -s -X POST 'http://127.0.0.1:8384/rest/config/devices' \
  -H 'X-API-Key: $PROD_API' \
  -H 'Content-Type: application/json' \
  -d '{
    \"deviceID\": \"$LOCAL_ID\",
    \"name\": \"local\",
    \"addresses\": [\"dynamic\"],
    \"autoAcceptFolders\": false
  }'"
```

> **Important:** Set `autoAcceptFolders` to `false`. Auto-accept can create the folder at the wrong path (e.g. `~/agent-sync` instead of `~/.agent`). Configure folders explicitly on both sides instead.

---

## Step 5: Create .stignore files

Create `~/.agent/.stignore` on the local machine (it will sync to production):

```
// Build artifacts — regenerated on each machine
_dist
// Temp / editor files
*~
*.tmp
*.swp
.DS_Store
// Python cache
__pycache__
*.pyc
```

---

## Step 6: Share folders on both sides

For each folder, run on both machines. Example for `agent-sync`:

```bash
# On local
curl -s -X POST "http://127.0.0.1:8384/rest/config/folders" \
  -H "X-API-Key: $LOCAL_API" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"agent-sync\",
    \"label\": \".agent\",
    \"path\": \"$HOME/.agent\",
    \"type\": \"sendreceive\",
    \"markerName\": \".stfolder\",
    \"devices\": [
      {\"deviceID\": \"$LOCAL_ID\"},
      {\"deviceID\": \"$PROD_ID\"}
    ],
    \"fsWatcherEnabled\": true,
    \"fsWatcherDelayS\": 10,
    \"versioning\": {
      \"type\": \"staggered\",
      \"params\": {
        \"cleanInterval\": \"3600\",
        \"maxAge\": \"7776000\"
      },
      \"cleanupIntervalS\": 3600
    }
  }"
```

Repeat for each folder in the [Synced Folders](#synced-folders) table, adjusting `id`, `label`, and `path`.

### Folder markers

By default Syncthing uses `.stfolder` as the marker. For directories where a stable subdirectory
always exists, set `markerName` to that subdirectory instead — this prevents false "marker missing"
errors if `.stfolder` gets accidentally deleted.

| Folder ID | Recommended marker |
|-----------|-------------------|
| `agent-sync` | `.stfolder` (default) |
| `claude-projects-sync` | `-home-mickael-projects` (always created by Claude Code) |
| `lyra-sync` | `.stfolder` (default) |
| `vault-sync` | `.stfolder` (default) |

To update a marker on a running instance:

```bash
# Local
curl -s -X PATCH "http://127.0.0.1:8384/rest/config/folders/claude-projects-sync" \
  -H "X-API-Key: $LOCAL_API" \
  -H "Content-Type: application/json" \
  -d '{"markerName": "-home-mickael-projects"}'

# Production
ssh PROD_HOST "curl -s -X PATCH 'http://127.0.0.1:8384/rest/config/folders/claude-projects-sync' \
  -H 'X-API-Key: $PROD_API' \
  -H 'Content-Type: application/json' \
  -d '{\"markerName\": \"-home-mickael-projects\"}'"
```

---

## Step 7: Verify

```bash
# Check connection
curl -s "http://127.0.0.1:8384/rest/system/connections" \
  -H "X-API-Key: $LOCAL_API" | python3 -c "
import sys, json
for did, info in json.load(sys.stdin)['connections'].items():
    print(f'{did[:7]}... connected={info[\"connected\"]}')"

# Check sync status for a folder
curl -s "http://127.0.0.1:8384/rest/db/status?folder=agent-sync" \
  -H "X-API-Key: $LOCAL_API" | python3 -c "
import sys, json
s = json.load(sys.stdin)
print(f'State: {s[\"state\"]}')
print(f'Synced: {s[\"inSyncFiles\"]}/{s[\"globalFiles\"]} files')
print(f'Need: {s[\"needBytes\"] / 1024 / 1024:.0f} MB')"
```

---

## Versioning: Staggered retention

Old versions are stored in `<folder>/.stversions/` with this retention:

| Window | Kept |
|--|--|
| Last hour | Every version |
| Last day | One per hour |
| Last month | One per day |
| Last 90 days | One per week |
| Older than 90 days | Deleted |

Cleanup runs every hour. Max age is 90 days (`7776000` seconds).

---

## Troubleshooting

### "folder marker missing" error

Syncthing refuses to sync as a safety measure when it can't find the marker file/directory.

**Preferred fix — use a stable marker** (permanent, won't recur):
```bash
# Check what's in the folder that always exists
ls ~/.claude/projects/

# Set markerName to a directory that's always there
KEY=$(syncthing cli config gui apikey get)
curl -s -X PATCH "http://127.0.0.1:8384/rest/config/folders/<folder-id>" \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"markerName": "<always-present-subdir>"}'
```

**Quick fix — recreate the marker** (may recur):
```bash
mkdir -p <folder-path>/.stfolder
```

### Folder stuck in "error" state with no reported errors

Check what file is pending:
```bash
KEY=$(syncthing cli config gui apikey get)
curl -s -H "X-API-Key: $KEY" "http://127.0.0.1:8384/rest/db/need?folder=<folder-id>"
```

Force a rescan:
```bash
curl -s -X POST -H "X-API-Key: $KEY" "http://127.0.0.1:8384/rest/db/scan?folder=<folder-id>"
```

### Check logs
```bash
journalctl --user -u syncthing -n 30 --no-pager
```

### Web UI
- Local: http://localhost:8384
- Production: `ssh -L 8385:127.0.0.1:8384 PROD_HOST` then http://localhost:8385

### Restart
```bash
systemctl --user restart syncthing
```

---

## Quick reference

| | |
|--|--|
| **Service** | `systemctl --user {status,restart,stop} syncthing` |
| **Web UI** | `http://localhost:8384` |
| **API key** | `syncthing cli config gui apikey get` |
| **Ignored files** | `<folder>/.stignore` |
| **Old versions** | `<folder>/.stversions/` |
| **Sync mode** | Send & Receive (bidirectional) |
| **Versioning** | Staggered, 90-day max age |
