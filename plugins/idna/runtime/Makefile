IDNA_DIR        := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

-include $(SUPERVISOR_HUB)/hub.mk

define ensure_idna_init
	@if [ ! -f "$(IDNA_DIR)idna_server.py" ]; then \
		echo "Error: idna not initialized at $(IDNA_DIR)"; \
		echo "       Run 'make idna install' first."; \
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
	@$(HUB_SVC) idna start

stop:
	@$(HUB_SVC) idna stop

reload:
	$(ensure_idna_init)
	@$(HUB_SVC) idna reload

status:
	@$(HUB_SVC) idna status

logs:
	@$(HUB_SVC) idna logs

errlogs:
	@$(HUB_SVC) idna errlogs

ls:
	@ls "$(IDNA_DIR)"

clean:
	@echo "Removing session dirs from $(IDNA_DIR)..."
	@find "$(IDNA_DIR)" -mindepth 1 -maxdepth 1 -type d \
		! -name templates ! -name __pycache__ \
		-exec rm -rf {} +
	@echo "Done."
