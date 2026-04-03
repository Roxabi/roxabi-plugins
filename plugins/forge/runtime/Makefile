FORGE_DIR       := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SUPERVISOR_HUB  ?= $(HOME)/projects
SUPERVISORCTL   := $(SUPERVISOR_HUB)/scripts/supervisorctl.sh
SCRIPTS_DIR     := $(FORGE_DIR)scripts

-include $(FORGE_DIR).env
export CLOUDFLARE_ACCOUNT_ID
export CLOUDFLARE_API_TOKEN

define ensure_forge_init
	@if [ ! -f "$(FORGE_DIR)serve.py" ] || [ ! -f "$(FORGE_DIR)run.sh" ]; then \
		echo "Error: forge not initialized at $(FORGE_DIR)"; \
		echo "       Run 'make forge install' first."; \
		exit 1; \
	fi
endef

define ensure_forge_registered
	@if ! $(SUPERVISORCTL) avail 2>/dev/null | grep -q "^forge"; then \
		echo "forge is not registered with any supervisor."; \
		echo "Register with the local hub? Run: make -C ~/projects/roxabi-plugins/plugins/forge register"; \
		exit 1; \
	fi
endef

.PHONY: build deploy-cf deploy-prod du start stop reload status logs errlogs help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  build        regenerate manifest + sync to _dist/"
	@echo "  deploy-cf    build then deploy to Cloudflare Pages"
	@echo "  deploy-prod  rsync $(FORGE_DIR) to DEPLOY_HOST"
	@echo "  du           disk usage by project"
	@echo "  start        start forge service"
	@echo "  stop         stop forge service"
	@echo "  reload       restart forge service"
	@echo "  status       show forge service status"
	@echo "  logs         tail stdout log"
	@echo "  errlogs      tail stderr log"

build:
	@bash "$(SCRIPTS_DIR)/build.sh"

deploy-cf: build
	@echo "▸ Deploying to Cloudflare Pages..."
	@npx wrangler pages deploy "$(FORGE_DIR)_dist" --project-name=diagrams --branch=main --commit-dirty=true

deploy-prod:
	@test -n "$(DEPLOY_HOST)" || (echo "ERROR: DEPLOY_HOST not set in $(FORGE_DIR).env" && exit 1)
	@echo "── rsync $(FORGE_DIR) → production ──"
	@rsync -avz --delete \
		--exclude "__pycache__/" \
		--exclude "*.pyc" \
		--exclude ".DS_Store" \
		--exclude ".sync.log" \
		--exclude "_dist/" \
		--exclude "*.py" \
		--exclude "build.sh" \
		--exclude "manifest.json" \
		"$(FORGE_DIR)" "$(DEPLOY_HOST):$(FORGE_DIR)"
	@echo "Done."

du:
	@du -sh "$(FORGE_DIR)"*/

start:
	$(ensure_forge_init)
	$(ensure_forge_registered)
	$(SUPERVISORCTL) start forge

stop:
	$(SUPERVISORCTL) stop forge

reload:
	$(ensure_forge_init)
	$(ensure_forge_registered)
	$(SUPERVISORCTL) restart forge

status:
	@$(SUPERVISORCTL) status forge || true

logs:
	$(SUPERVISORCTL) tail -f forge

errlogs:
	$(SUPERVISORCTL) tail -f forge stderr
