FORGE_DIR       := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SCRIPTS_DIR     := $(FORGE_DIR)scripts

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

.PHONY: build deploy du start stop reload status logs errlogs help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  build        regenerate manifest + sync to _dist/"
	@echo "  deploy       build then deploy to Cloudflare Pages"
	@echo "  du           disk usage by project"
	@echo "  start        start forge service"
	@echo "  stop         stop forge service"
	@echo "  reload       restart forge service"
	@echo "  status       show forge service status"
	@echo "  logs         tail stdout log"
	@echo "  errlogs      tail stderr log"

build:
	@bash "$(SCRIPTS_DIR)/build.sh"

deploy: build
	@echo "Deploying to Cloudflare Pages..."
	@npx wrangler pages deploy "$(FORGE_DIR)_dist" --project-name=diagrams --branch=main --commit-dirty=true

du:
	@du -sh "$(FORGE_DIR)"*/

start:
	$(ensure_forge_init)
	@$(HUB_SVC) forge start

stop:
	@$(HUB_SVC) forge stop

reload:
	$(ensure_forge_init)
	@$(HUB_SVC) forge reload

status:
	@$(HUB_SVC) forge status

logs:
	@$(HUB_SVC) forge logs

errlogs:
	@$(HUB_SVC) forge errlogs
