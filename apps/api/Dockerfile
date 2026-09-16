# SafeCircle API — imagem de produção (contexto de build: raiz do monorepo).
#
#   docker build -f apps/api/Dockerfile -t safecircle-api .
#
# Dois estágios: compila com as devDependencies e roda só com as de produção.
# Nenhum segredo entra na imagem: tudo vem do ambiente do processo (Railway).
# O container aplica as migrations pendentes e sobe a API; `/health` responde
# sem depender do banco e `/ready` verifica a conexão.

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.33.3

# ---------------------------------------------------------------- build ----
FROM node:${NODE_VERSION}-alpine AS build
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @safecircle/api

COPY apps/api apps/api
RUN pnpm --filter @safecircle/api build

# -------------------------------------------------------------- runtime ----
FROM node:${NODE_VERSION}-alpine AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production CI=true
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && apk add --no-cache wget
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --prod --filter @safecircle/api \
  && pnpm store prune

COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle

USER node
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1

# Migrations antes do start: falha rápida se o banco não estiver acessível.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/server.js"]
