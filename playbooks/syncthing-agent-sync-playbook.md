# Playbook: Syncthing Setup for ~/.agent Sync

> Keep `~/.agent/` (exploration artifacts, diagrams, brand assets) in bidirectional real-time sync between two machines using Syncthing.

**Proven on:** ROXABITOWER (local) <-> roxabituwer (production at 192.168.1.16), ~464MB, ~3200 files

---

## Why Syncthing

- `~/.agent/` contains images, MP4s, diagrams — too large/binary for git
- Two machines need the same content, edits happen on both sides
- Syncthing: bidirectional, real-time, no cloud, no manual push/pull, set-and-forget

---

## Prerequisites

- Two Linux machines with SSH access between them
- `~/.agent/` directory exists on both machines
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

# API keys (from config XML)
LOCAL_API=$(grep -oP "(?<=<apikey>)[^<]+" ~/.local/state/syncthing/config.xml)
PROD_API=$(ssh PROD_HOST 'grep -oP "(?<=<apikey>)[^<]+" ~/.local/state/syncthing/config.xml')

echo "Local ID:  $LOCAL_ID"
echo "Prod ID:   $PROD_ID"
echo "Local API: $LOCAL_API"
echo "Prod API:  $PROD_API"
```

> Config may be at `~/.config/syncthing/config.xml` on some distros.

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

## Step 5: Create .stignore

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

## Step 6: Share the folder on both sides

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

# On production
ssh PROD_HOST "curl -s -X POST 'http://127.0.0.1:8384/rest/config/folders' \
  -H 'X-API-Key: $PROD_API' \
  -H 'Content-Type: application/json' \
  -d '{
    \"id\": \"agent-sync\",
    \"label\": \".agent\",
    \"path\": \"/home/$USER/.agent\",
    \"type\": \"sendreceive\",
    \"devices\": [
      {\"deviceID\": \"$PROD_ID\"},
      {\"deviceID\": \"$LOCAL_ID\"}
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
  }'"
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

# Check sync status (both sides)
curl -s "http://127.0.0.1:8384/rest/db/status?folder=agent-sync" \
  -H "X-API-Key: $LOCAL_API" | python3 -c "
import sys, json
s = json.load(sys.stdin)
print(f'State: {s[\"state\"]}')
print(f'Synced: {s[\"inSyncFiles\"]}/{s[\"globalFiles\"]} files')
print(f'Need: {s[\"needBytes\"] / 1024 / 1024:.0f} MB')"

# Compare both sides
echo "=== LOCAL ===" && du -sh ~/.agent/ && find ~/.agent -type f | wc -l
echo "=== PRODUCTION ===" && ssh PROD_HOST 'du -sh ~/.agent/ && find ~/.agent -type f | wc -l'
```

---

## Versioning: Staggered retention

Old versions are stored in `~/.agent/.stversions/` with this retention:

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
The `.stfolder` marker is missing from the sync directory. Usually caused by auto-accept creating a folder at the wrong path. Fix:
```bash
# Delete the bad folder config
curl -s -X DELETE "http://127.0.0.1:8384/rest/config/folders/agent-sync" -H "X-API-Key: $API_KEY"
# Remove any accidental directory (e.g. ~/agent-sync)
rm -rf ~/agent-sync
# Re-create with the correct path (Step 6)
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
| **Config** | `~/.local/state/syncthing/config.xml` |
| **Ignored files** | `~/.agent/.stignore` |
| **Old versions** | `~/.agent/.stversions/` |
| **Folder ID** | `agent-sync` |
| **Sync mode** | Send & Receive (bidirectional) |
| **Versioning** | Staggered, 90-day max age |
