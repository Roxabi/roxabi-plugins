FORGE_DIR ?= $(HOME)/.roxabi/forge
DEPLOY_HOST := $(shell grep '^DEPLOY_HOST=' .env 2>/dev/null | cut -d= -f2)

forge-build:
	@bash forge/scripts/build.sh

forge-deploy:
	@bash forge/scripts/build.sh
	@echo "▸ Deploying to Cloudflare Pages…"
	@set -a; [ -f .env ] && . ./.env; set +a; CLOUDFLARE_ACCOUNT_ID=b5e90be971920ce406f7b679c4f1cd33 npx wrangler pages deploy $(FORGE_DIR)/_dist --project-name=diagrams --branch=main --commit-dirty=true

forge-deploy-prod:
	@echo "── rsync $(FORGE_DIR)/ → production ──"
	@rsync -avz --delete \
		--exclude "__pycache__/" \
		--exclude "*.pyc" \
		--exclude ".DS_Store" \
		--exclude ".sync.log" \
		--exclude "_dist/" \
		--exclude "*.py" \
		--exclude "build.sh" \
		--exclude "manifest.json" \
		$(FORGE_DIR)/ $(DEPLOY_HOST):$(FORGE_DIR)/
	@echo "Done."

forge-du:
	@du -sh $(FORGE_DIR)/*/
