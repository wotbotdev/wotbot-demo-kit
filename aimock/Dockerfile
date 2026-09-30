ARG AIMOCK_BASE_IMAGE=ghcr.io/copilotkit/aimock@sha256:163ecad18171e7d28752c386f448cc168bae71b2278d6b9e61a50f454860d8ed
FROM ${AIMOCK_BASE_IMAGE}

COPY aimock/request-context.mjs /app/request-context.mjs
COPY aimock/wotbot-aimock.mjs /app/wotbot-aimock.mjs

ENTRYPOINT ["node", "/app/wotbot-aimock.mjs"]
CMD []
