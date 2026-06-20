# CAD Viewer — Docker convenience targets.
#
#   make build     build the Docker image
#   make run       start the service (standalone container)
#   make compose   alternative start via Docker Compose
#
# Override defaults on the command line, e.g.  make run PORT=9000

IMAGE   ?= cad-viewer
NAME    ?= cad-viewer
PORT    ?= 8000

.DEFAULT_GOAL := help

.PHONY: help build run compose stop down logs clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Build the Docker image
	docker build -t $(IMAGE) .

run: build ## Start the service (standalone container, detached) on http://localhost:$(PORT)
	docker rm -f $(NAME) 2>/dev/null || true
	docker run -d --name $(NAME) -p $(PORT):8000 $(IMAGE)
	@echo "CAD viewer running -> http://localhost:$(PORT)/"

compose: ## Alternative start via Docker Compose (detached, builds if needed)
	PORT=$(PORT) docker compose up -d --build
	@echo "CAD viewer running -> http://localhost:$(PORT)/"

stop: ## Stop and remove the standalone container
	docker rm -f $(NAME) 2>/dev/null || true

down: ## Stop and remove the Compose stack
	docker compose down

logs: ## Follow the standalone container logs
	docker logs -f $(NAME)

clean: stop down ## Tear everything down and remove the image
	docker rmi $(IMAGE) 2>/dev/null || true
