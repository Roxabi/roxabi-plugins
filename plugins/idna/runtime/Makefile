IDNA_DIR        := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
SUPERVISOR_HUB  ?= $(HOME)/projects
SUPERVISORCTL   := $(SUPERVISOR_HUB)/scripts/supervisorctl.sh

define ensure_idna_init
	@if [ ! -f "$(IDNA_DIR)idna_server.py" ]; then \
		echo "Error: idna not initialized at $(IDNA_DIR)"; \
		echo "       Run 'make idna install' first."; \
		exit 1; \
	fi
endef

define ensure_idna_registered
	@if ! $(SUPERVISORCTL) avail 2>/dev/null | grep -q "^idna"; then \
		echo "idna is not registered with any supervisor."; \
		echo "Register with the local hub? Run: make -C ~/projects/roxabi-plugins/plugins/idna register"; \
		exit 1; \
	fi
endef

.PHONY: start stop reload status logs errlogs ls clean help

.DEFAULT_GOAL := help

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  start    start idna service"
	@echo "  stop     stop idna service"
	@echo "  reload   restart idna service"
	@echo "  status   show idna service status"
	@echo "  logs     tail stdout log"
	@echo "  errlogs  tail stderr log"
	@echo "  ls       list sessions in $(IDNA_DIR)"
	@echo "  clean    remove all session dirs (keeps scripts)"

start:
	$(ensure_idna_init)
	$(ensure_idna_registered)
	$(SUPERVISORCTL) start idna

stop:
	$(SUPERVISORCTL) stop idna

reload:
	$(ensure_idna_init)
	$(ensure_idna_registered)
	$(SUPERVISORCTL) restart idna

status:
	@$(SUPERVISORCTL) status idna || true

logs:
	$(SUPERVISORCTL) tail -f idna

errlogs:
	$(SUPERVISORCTL) tail -f idna stderr

ls:
	@ls "$(IDNA_DIR)"

clean:
	@echo "Removing session dirs from $(IDNA_DIR)..."
	@find "$(IDNA_DIR)" -mindepth 1 -maxdepth 1 -type d \
		! -name templates ! -name __pycache__ \
		-exec rm -rf {} +
	@echo "Done."
