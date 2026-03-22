FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV CI=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build:plugin-env \
 && pnpm build \
 && pnpm web:build \
 && pnpm web:prepack


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/home/node
ENV DENCHCLAW_DAEMONLESS=1
ENV DENCHCLAW_TELEMETRY_DISABLED=1
ENV DO_NOT_TRACK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends lsof \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && mkdir -p /home/node/.openclaw-dench \
 && chown -R node:node /app /home/node

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/denchclaw.mjs ./denchclaw.mjs
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/assets ./assets
COPY --from=build --chown=node:node /app/extensions ./extensions
COPY --from=build --chown=node:node /app/skills ./skills
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/denchclaw-container-entrypoint

RUN chmod +x /usr/local/bin/denchclaw-container-entrypoint

USER node

EXPOSE 3100

ENTRYPOINT ["denchclaw-container-entrypoint"]
