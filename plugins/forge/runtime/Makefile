FORGE_DIR       := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS_DIR     := $(FORGE_DIR)scripts

SUPERVISOR_HUB  ?= $(HOME)/projects
HUB_SERVICES    := forge
-include $(SUPERVISOR_HUB)/hub.mk

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

.PHONY: build deploy du forge help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  build                   regenerate manifest + sync to _dist/"
	@echo "  deploy                  build then deploy to Cloudflare Pages"
	@echo "  du                      disk usage by project"
	@echo "  forge <action>          start|stop|reload|status|logs|errlogs"

build:
	@bash "$(SCRIPTS_DIR)/build.sh"

deploy: build
	@echo "Deploying to Cloudflare Pages..."
	@npx wrangler pages deploy "$(FORGE_DIR)_dist" --project-name=diagrams --branch=main --commit-dirty=true

du:
	@du -sh "$(FORGE_DIR)"*/

# ── Supervisor service (hub-dispatched) ─────────────────────────────────────────
# Usage (from this dir or from ~/projects):
#   make forge start|stop|reload|status|logs|errlogs

forge:
	@case "$(SVC_CMD)" in \
		start|reload) \
			if [ ! -f "$(FORGE_DIR)serve.py" ] || [ ! -f "$(FORGE_DIR)run.sh" ]; then \
				echo "Error: forge not initialized at $(FORGE_DIR)"; \
				echo "       Run 'make forge install' first."; \
				exit 1; \
			fi ;; \
	esac
	@$(HUB_SVC) forge $(SVC_CMD)
