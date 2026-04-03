FORGE_DIR       ?= $(HOME)/.roxabi/forge
PLUGIN_DIR      := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

-include $(SUPERVISOR_HUB)/hub.mk

.PHONY: deploy register help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  deploy   copy server files, scripts, and runtime Makefile → $(FORGE_DIR)/"
	@echo "  register symlink supervisor config + generate hub delegation"
	@echo ""
	@echo "For day-to-day operations (build/deploy-cf/deploy-prod/start/stop/etc.):"
	@echo "  make -C $(FORGE_DIR) <target>"
	@echo "  or: make forge <target>  (from ~/projects/)"

deploy:
	@echo "── deploy forge → $(FORGE_DIR)/ ──"
	@mkdir -p "$(FORGE_DIR)/scripts"
	@cp -v $(PLUGIN_DIR)references/server/serve.py $(FORGE_DIR)/serve.py
	@cp -v $(PLUGIN_DIR)references/server/index.html $(FORGE_DIR)/index.html
	@cp -v $(PLUGIN_DIR)supervisor/scripts/run.sh $(FORGE_DIR)/run.sh
	@chmod +x $(FORGE_DIR)/run.sh
	@cp -v $(PLUGIN_DIR)runtime/Makefile $(FORGE_DIR)/Makefile
	@cp -v $(PLUGIN_DIR)runtime/.env.example $(FORGE_DIR)/.env.example
	@cp -v $(PLUGIN_DIR)../../forge/scripts/build.sh $(FORGE_DIR)/scripts/build.sh
	@cp -v $(PLUGIN_DIR)../../forge/scripts/gen-manifest.py $(FORGE_DIR)/scripts/gen-manifest.py
	@cp -v $(PLUGIN_DIR)../../forge/scripts/gen-deps.py $(FORGE_DIR)/scripts/gen-deps.py
	@cp -v $(PLUGIN_DIR)../../forge/scripts/gen-image-manifests.py $(FORGE_DIR)/scripts/gen-image-manifests.py
	@cp -v $(PLUGIN_DIR)../../forge/scripts/seed-meta.py $(FORGE_DIR)/scripts/seed-meta.py
	@cp -v $(PLUGIN_DIR)../../forge/scripts/update-meta.py $(FORGE_DIR)/scripts/update-meta.py
	@chmod +x $(FORGE_DIR)/scripts/build.sh
	@echo "Done."
	@echo ""
	@echo "Note: if $(FORGE_DIR)/.env doesn't exist yet, copy .env.example and fill in credentials:"
	@echo "  cp $(FORGE_DIR)/.env.example $(FORGE_DIR)/.env"

register:
	@echo "Registering forge with supervisor hub..."
	@$(HUB_GEN_MK) forge "$(FORGE_DIR)" forge
	$(call hub-link-conf,forge,$(PLUGIN_DIR)supervisor/conf.d/forge.conf)
	$(hub_reread)
	@echo "Done."
