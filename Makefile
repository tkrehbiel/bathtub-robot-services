STAGE ?= dev
GTS_USER ?= admin
GTS_EMAIL ?= admin@example.com
GTS_PASSWORD ?= AdminPassword123

.PHONY: up down setup-gts deploy-local deploy-aws logs-poller logs-notifier test-local clean

up:
	docker compose up -d
	@echo "Waiting for LocalStack to be ready..."
	@until curl -s http://localhost:4566/_localstack/health | grep -q '"dynamodb":'; do sleep 1; done
	@echo "LocalStack is ready!"
	@echo "Waiting for GotoSocial to be ready..."
	@until [ $$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/) -eq 200 ]; do sleep 1; done
	@echo "GotoSocial is ready!"

down:
	docker compose down

setup-gts:
	@echo "Creating admin account in GotoSocial..."
	docker exec gotosocial /gotosocial/gotosocial admin account create --username $(GTS_USER) --email $(GTS_EMAIL) --password '$(GTS_PASSWORD)' || true
	docker exec gotosocial /gotosocial/gotosocial admin account confirm --username $(GTS_USER) || true
	@echo "Registering application and obtaining Access Token..."
	node scripts/setup-gts-token.js
	@echo "Making admin account public and discoverable..."
	docker exec gts-db psql -U gotosocial -c "update accounts set locked = false, discoverable = true, hides_cc_public_from_unauthed_web = false where username = '$(GTS_USER)';"
	@echo "Restarting GotoSocial to apply database overrides..."
	docker compose restart gotosocial
	@until [ $$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/) -eq 200 ]; do sleep 1; done
	@echo "GotoSocial is ready with authorized token!"

deploy-local:
	# Local stack deployment using the container DNS for gotosocial
	FEDIVERSE_INSTANCE_URL=http://gotosocial:8080 \
	FEDIVERSE_ACCESS_TOKEN=$$(cat .gts-token 2>/dev/null || echo "mock-token") \
	NOTIFICATION_EMAIL=alerts@example.com \
	npx serverless deploy --stage local --force

get-prod-token:
	node scripts/get-prod-token.js

deploy-aws:
	npm run deploy:aws -- --stage $(STAGE)

prepopulate-aws:
	STAGE=$(STAGE) node scripts/prepopulate-db.js

test-local:
	# Trigger the poller manually in LocalStack using standard aws CLI
	aws --endpoint-url=http://localhost:4566 lambda invoke --function-name bathtub-robot-services-local-poller /dev/stdout

logs-poller:
	aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/bathtub-robot-services-local-poller

logs-notifier:
	aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/bathtub-robot-services-local-fediverse-notifier

clear-posts:
	@echo "Clearing local DynamoDB poll history..."
	node scripts/clear-history.js

clean:
	docker compose down -v
	rm -rf .localstack .gts-storage .gts-token
