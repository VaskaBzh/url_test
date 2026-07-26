.DEFAULT_GOAL := help

.PHONY: help install dev server client build test docker-up docker-down

## Display the available commands.
help:
	@echo "Available commands:"
	@echo "  make install     Install server and client dependencies"
	@echo "  make dev         Start NestJS and Vite development servers"
	@echo "  make server      Start only the NestJS development server"
	@echo "  make client      Start only the Vue development server"
	@echo "  make build       Build both applications"
	@echo "  make test        Run the server e2e tests"
	@echo "  make docker-up   Build and start Docker Compose"
	@echo "  make docker-down Stop Docker Compose"

## Install the exact dependency versions recorded in both lock files.
install:
	npm --prefix server ci
	npm --prefix client ci

## Start the API on port 3000 and the Vue client on port 5173.
dev:
	@npm --prefix server run start:dev & server_process_id=$$!; \
	npm --prefix client run dev & client_process_id=$$!; \
	trap 'kill $$server_process_id $$client_process_id 2>/dev/null' EXIT INT TERM; \
	wait $$server_process_id $$client_process_id

## Start only the NestJS API with file watching.
server:
	npm --prefix server run start:dev

## Start only the Vue development server.
client:
	npm --prefix client run dev

## Build the NestJS API and Vue client for production.
build:
	npm --prefix server run build
	npm --prefix client run build

## Run the API end-to-end test suite.
test:
	npm --prefix server run test:e2e -- --runInBand

## Build and run the Docker Compose environment.
docker-up:
	docker compose up --build

## Stop and remove Docker Compose containers.
docker-down:
	docker compose down
