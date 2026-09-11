# Imagem base do ambiente de desenvolvimento do SafeCircle (Cloud Agents).
#
# Dependências de sistema estáveis (Node, PostgreSQL, git, curl) ficam aqui.
# A instalação de dependências do projeto (pnpm install) e a subida de serviços
# ficam em `install` / `start` no environment.json, pois dependem do checkout.
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    postgresql \
    postgresql-contrib \
  && rm -rf /var/lib/apt/lists/*

# Habilita o corepack (pnpm) globalmente. A versão exata é fixada no install.
RUN corepack enable

USER node
