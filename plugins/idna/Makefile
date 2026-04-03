IDNA_DIR        ?= $(HOME)/.roxabi/idna
SUPERVISOR_HUB  ?= $(HOME)/projects
SUPERVISORCTL   := $(SUPERVISOR_HUB)/scripts/supervisorctl.sh
PLUGIN_DIR      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REFS_DIR        := $(PLUGIN_DIR)references

.PHONY: deploy register help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  deploy   copy references/ and runtime Makefile → $(IDNA_DIR)/"
	@echo "  register symlink supervisor config into hub"
	@echo ""
	@echo "For day-to-day operations (start/stop/reload/logs/ls/clean/etc.):"
	@echo "  make -C $(IDNA_DIR) <target>"
	@echo "  or: make idna <target>  (from ~/projects/)"

deploy:
	@echo "── deploy references/ → $(IDNA_DIR)/ ──"
	@mkdir -p "$(IDNA_DIR)"
	@rsync -av --exclude "__pycache__/" --exclude "*.pyc" \
		$(REFS_DIR)/ $(IDNA_DIR)/
	@cp -v $(PLUGIN_DIR)runtime/Makefile $(IDNA_DIR)/Makefile
	@echo "Done."

register:
	@echo "Registering IDNA with supervisor hub..."
	@mkdir -p "$(SUPERVISOR_HUB)/conf.d"
	@ln -sf "$(abspath $(PLUGIN_DIR)supervisor/conf.d/idna.conf)" "$(SUPERVISOR_HUB)/conf.d/idna.conf"
	@if [ -S "$(SUPERVISOR_HUB)/supervisor.sock" ]; then \
		$(SUPERVISORCTL) reread && $(SUPERVISORCTL) update; \
	fi
	@echo "Done."
