# syntax=docker/dockerfile:1
# One image for all server processes (api, worker, addon). docker-compose.yml
# starts the same image with a different command per service.

FROM node:22-bookworm-slim AS build
ENV CI=true
WORKDIR /app
RUN corepack enable

# Install dependencies first so this layer is cached until a manifest changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/addon/package.json apps/addon/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
COPY packages/subtitle-parser/package.json packages/subtitle-parser/
COPY packages/ai-providers/package.json packages/ai-providers/
COPY packages/translation-engine/package.json packages/translation-engine/
COPY packages/subtitle-sources/package.json packages/subtitle-sources/
COPY packages/jobs/package.json packages/jobs/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# Drop dev dependencies; what remains is exactly what runs in production.
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    ASC_ROOT=/app \
    DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
USER node
VOLUME ["/data"]
EXPOSE 7000 7001 7002
CMD ["node", "apps/api/dist/main.js"]
