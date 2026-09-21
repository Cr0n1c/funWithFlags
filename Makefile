# Fun With Flags - local development helpers
.DEFAULT_GOAL := help
COMPOSE ?= docker compose
KIND_CLUSTER ?= fwf
HELM_NS ?= fwf

.PHONY: help up down logs ps reset build \
        ui-install ui-dev ui-lint ui-build \
        api-sync api-dev api-lint api-test api-migrate api-seed \
        helm-lint helm-template kind-up kind-deploy kind-test kind-down secrets

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- compose
up: ## Build and start the full local stack (db + api + ui) on http://localhost:8080
	$(COMPOSE) up --build -d
down: ## Stop the local stack (keeps the database volume)
	$(COMPOSE) down
reset: ## Stop the local stack and delete the database volume
	$(COMPOSE) down -v
logs: ## Tail logs from all services
	$(COMPOSE) logs -f
ps: ## Show service status
	$(COMPOSE) ps
build: ## Build both images
	$(COMPOSE) build

# --------------------------------------------------------------------- ui
ui-install: ## npm ci in ui/
	cd ui && npm ci
ui-dev: ## Vite dev server on :5173 proxying /api to :8000
	cd ui && npm run dev
ui-lint: ## ESLint + tsc for the UI
	cd ui && npm run lint && npm run type-check
ui-build: ## Production build of the UI
	cd ui && npm run build

# -------------------------------------------------------------------- api
api-sync: ## uv sync in api/
	cd api && uv sync --frozen
api-dev: ## Run the API locally with reload (needs a .env exported into the shell)
	cd api && uv run uvicorn app.asgi:app --reload --port 8000
api-lint: ## ruff + ty for the API
	cd api && uv run ruff format --check . && uv run ruff check . && uv run ty check app tests
api-test: ## pytest for the API
	cd api && uv run pytest -q
api-migrate: ## Run alembic migrations against the compose database
	$(COMPOSE) exec api funwithflags-api migrate
api-seed: ## Re-seed challenges from the mounted challenges file
	$(COMPOSE) exec api funwithflags-api seed

# ------------------------------------------------------------------- helm
helm-lint: ## helm lint with both value profiles
	helm lint charts/funwithflags --set config.okta.clientId=ci --set secrets.existingSecret=fwf --set database.host=db
	helm lint charts/funwithflags -f charts/funwithflags/values-local.yaml --set config.okta.clientId=ci
helm-template: ## Render the chart with local values
	helm template fwf charts/funwithflags -f charts/funwithflags/values-local.yaml --set config.okta.clientId=ci

kind-up: ## Create a kind cluster
	kind create cluster --name $(KIND_CLUSTER) --wait 120s
kind-deploy: build ## Load local images into kind and install the chart with values-local.yaml
	kind load docker-image funwithflags-ui:dev funwithflags-api:dev --name $(KIND_CLUSTER)
	helm upgrade --install fwf charts/funwithflags -n $(HELM_NS) --create-namespace \
	  -f charts/funwithflags/values-local.yaml \
	  --set config.okta.clientId=$${OKTA_CLIENT_ID:-local-dev-client} \
	  --set secrets.values.OKTA_CLIENT_SECRET=$${OKTA_CLIENT_SECRET:-replace-me} \
	  --wait --timeout 5m
	@echo "kubectl -n $(HELM_NS) port-forward svc/fwf-funwithflags-ui 8080:80"
kind-test: ## Run helm test against the kind install
	helm test fwf -n $(HELM_NS)
kind-down: ## Delete the kind cluster
	kind delete cluster --name $(KIND_CLUSTER)

secrets: ## Print fresh random values for SESSION_SECRET / FLAG_HASH_SECRET / DB_PASSWORD
	@echo "SESSION_SECRET=$$(openssl rand -hex 32)"
	@echo "FLAG_HASH_SECRET=$$(openssl rand -hex 32)"
	@echo "DB_PASSWORD=$$(openssl rand -hex 16)"
