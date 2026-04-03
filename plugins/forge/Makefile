FORGE_DIR       ?= $(HOME)/.roxabi/forge
SUPERVISOR_HUB  ?= $(HOME)/projects
SUPERVISORCTL   := $(SUPERVISOR_HUB)/scripts/supervisorctl.sh
PLUGIN_DIR      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: deploy register start stop reload status logs errlogs help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  deploy   copy server files + run.sh → $(FORGE_DIR)/"
	@echo "  register symlink supervisor config into hub"
	@echo "  start    start forge service"
	@echo "  stop     stop forge service"
	@echo "  reload   restart forge service (after deploy)"
	@echo "  status   show forge service status"
	@echo "  logs     tail stdout log"
	@echo "  errlogs  tail stderr log"

deploy:
	@echo "── deploy forge → $(FORGE_DIR)/ ──"
	@mkdir -p "$(FORGE_DIR)"
	@cp -v $(PLUGIN_DIR)references/server/serve.py $(FORGE_DIR)/serve.py
	@cp -v $(PLUGIN_DIR)references/server/index.html $(FORGE_DIR)/index.html
	@cp -v $(PLUGIN_DIR)supervisor/scripts/run.sh $(FORGE_DIR)/run.sh
	@chmod +x $(FORGE_DIR)/run.sh
	@echo "Done."

register:
	@echo "Registering forge with supervisor hub..."
	@mkdir -p "$(SUPERVISOR_HUB)/conf.d"
	@ln -sf "$(abspath supervisor/conf.d/forge.conf)" "$(SUPERVISOR_HUB)/conf.d/forge.conf"
	@if [ -S "$(SUPERVISOR_HUB)/supervisor.sock" ]; then \
		$(SUPERVISORCTL) reread && $(SUPERVISORCTL) update; \
	fi
	@echo "Done."

start:
	$(SUPERVISORCTL) start forge

stop:
	$(SUPERVISORCTL) stop forge

reload:
	$(SUPERVISORCTL) restart forge

status:
	$(SUPERVISORCTL) status forge

logs:
	$(SUPERVISORCTL) tail -f forge

errlogs:
	$(SUPERVISORCTL) tail -f forge stderr
