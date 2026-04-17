IDNA_DIR        ?= $(HOME)/.roxabi/idna
PLUGIN_DIR      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REFS_DIR        := $(PLUGIN_DIR)references

-include $(SUPERVISOR_HUB)/hub.mk

.PHONY: deploy register help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  deploy   copy references/ and runtime Makefile → $(IDNA_DIR)/"
	@echo "  register symlink supervisor config + generate hub delegation"
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
	@$(HUB_GEN_MK) idna "$(IDNA_DIR)" idna
	$(call hub-link-conf,idna,$(PLUGIN_DIR)supervisor/conf.d/idna.conf)
	$(hub_reread)
	@echo "Done."
