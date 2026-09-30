VERSION := $(shell cat VERSION)

.PHONY: build check

build:
	docker build -f aimock/Dockerfile -t wotbot-demo-kit/aimock:$(VERSION) .
	docker build -f directory/Dockerfile -t wotbot-demo-kit/directory:$(VERSION) .

check:
	node --test tests/aimock-request-context.test.mjs
	python3 -m unittest discover -s tests -p 'test_*.py'
	python3 -m py_compile directory/*.py
