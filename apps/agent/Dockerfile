# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/txline/package.json packages/txline/package.json
RUN pnpm install --filter @lagshield/agent... --frozen-lockfile

COPY apps/agent apps/agent
COPY packages packages
RUN pnpm --filter @lagshield/agent... build

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app
RUN chmod 755 /app/apps/agent/container-entrypoint.sh

USER node
EXPOSE 4000
CMD ["/app/apps/agent/container-entrypoint.sh"]
