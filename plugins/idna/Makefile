IDNA_DIR        ?= $(HOME)/.roxabi/idna
SUPERVISOR_HUB  ?= $(HOME)/projects
SUPERVISORCTL   := $(SUPERVISOR_HUB)/scripts/supervisorctl.sh
REFS_DIR        := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))references

.PHONY: deploy register start stop reload status logs errlogs ls clean help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  deploy   copy references/ → $(IDNA_DIR)/"
	@echo "  register symlink supervisor config into hub"
	@echo "  start    start idna service"
	@echo "  stop     stop idna service"
	@echo "  reload   restart idna service (after deploy)"
	@echo "  status   show idna service status"
	@echo "  logs     tail stdout log"
	@echo "  errlogs  tail stderr log"
	@echo "  ls       list sessions in $(IDNA_DIR)/"
	@echo "  clean    remove all session dirs (keeps scripts)"

deploy:
	@echo "── deploy references/ → $(IDNA_DIR)/ ──"
	@rsync -av --exclude "__pycache__/" --exclude "*.pyc" \
		$(REFS_DIR)/ $(IDNA_DIR)/
	@echo "Done."

register:
	@echo "Registering IDNA with supervisor hub..."
	@mkdir -p "$(SUPERVISOR_HUB)/conf.d"
	@ln -sf "$(abspath supervisor/conf.d/idna.conf)" "$(SUPERVISOR_HUB)/conf.d/idna.conf"
	@if [ -S "$(SUPERVISOR_HUB)/supervisor.sock" ]; then \
		$(SUPERVISORCTL) reread && $(SUPERVISORCTL) update; \
	fi
	@echo "Done."

start:
	$(SUPERVISORCTL) start idna

stop:
	$(SUPERVISORCTL) stop idna

reload:
	$(SUPERVISORCTL) restart idna

status:
	$(SUPERVISORCTL) status idna

logs:
	$(SUPERVISORCTL) tail -f idna

errlogs:
	$(SUPERVISORCTL) tail -f idna stderr

ls:
	@ls $(IDNA_DIR)/

clean:
	@echo "Removing session dirs from $(IDNA_DIR)/..."
	@find $(IDNA_DIR)/ -mindepth 1 -maxdepth 1 -type d \
		! -name templates ! -name __pycache__ \
		-exec rm -rf {} +
	@echo "Done."
