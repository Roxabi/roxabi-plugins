# Forge Makefile Targets

Drop-in Makefile snippet for projects that want `make forge` targets. Copy the relevant section into your project's Makefile.

---

## Minimal (serve only)

For projects that just need local serving — no daemon, no deploy.

```makefile
FORGE_DIR ?= $(HOME)/.roxabi/forge

.PHONY: forge

forge:
	@echo "Usage: make forge serve|stop"

forge-serve:
	@echo "Serving $(FORGE_DIR) on :8080…"
	@cd $(FORGE_DIR) && python3 -m http.server 8080

forge-stop:
	@pkill -f "http.server 8080" 2>/dev/null || echo "Not running"
```

---

## Full (daemon + deploy)

For projects with supervisord. Assumes a `forge` program in supervisor config and a `serve.py` dev server.

```makefile
FORGE_DIR     ?= $(HOME)/.roxabi/forge
SUPERVISORCTL ?= supervisorctl -c supervisord.conf

.PHONY: forge

forge:
ifeq ($(word 2,$(MAKECMDGOALS)),status)
	$(SUPERVISORCTL) status forge
else ifeq ($(word 2,$(MAKECMDGOALS)),start)
	$(SUPERVISORCTL) start forge
else ifeq ($(word 2,$(MAKECMDGOALS)),stop)
	$(SUPERVISORCTL) stop forge
else ifeq ($(word 2,$(MAKECMDGOALS)),reload)
	$(SUPERVISORCTL) restart forge
else ifeq ($(word 2,$(MAKECMDGOALS)),logs)
	$(SUPERVISORCTL) tail -f forge
else ifeq ($(word 2,$(MAKECMDGOALS)),errors)
	$(SUPERVISORCTL) tail -f forge stderr
else ifeq ($(word 2,$(MAKECMDGOALS)),build)
	@bash scripts/forge-build.sh
else ifeq ($(word 2,$(MAKECMDGOALS)),deploy)
	@bash scripts/forge-build.sh
	@npx wrangler pages deploy $(FORGE_DIR)/_dist --project-name=forge --branch=main --commit-dirty=true
else
	@echo "Usage: make forge start|stop|reload|status|logs|errors|build|deploy"
endif
```

### Supervisor config (`conf.d/forge.conf`)

```ini
[program:forge]
command=%(ENV_HOME)s/path/to/serve.py
directory=%(ENV_HOME)s/.roxabi/forge
environment=DIAGRAMS_DIR="%(ENV_HOME)s/.roxabi/forge"
autostart=true
autorestart=true
startsecs=3
stdout_logfile=%(ENV_HOME)s/.local/state/logs/forge.log
stdout_logfile_maxbytes=5MB
stderr_logfile=%(ENV_HOME)s/.local/state/logs/forge_error.log
stderr_logfile_maxbytes=5MB
```

---

## Commands reference

| Command | What it does |
|---------|-------------|
| `make forge start` | Start the forge dev server |
| `make forge stop` | Stop the server |
| `make forge reload` | Restart after changes |
| `make forge status` | Check if running |
| `make forge logs` | Tail stdout |
| `make forge errors` | Tail stderr |
| `make forge build` | Rebuild `_dist/` (manifest + image manifests + rsync) |
| `make forge deploy` | Build + deploy to Cloudflare Pages |
