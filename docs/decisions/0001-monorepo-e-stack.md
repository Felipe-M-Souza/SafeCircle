# ADR 0001 — Monorepo e stack

## Status

Aceito — Phase 0 (Fundação).

## Contexto

O SafeCircle é um aplicativo mobile de segurança que dependerá de um app mobile
(React Native/Expo) e de um backend (Node.js/Fastify) compartilhando conceitos de
domínio (usuários, grupos de confiança, alertas de emergência) e contratos de API.

Precisávamos de uma base limpa, testável e segura antes de implementar qualquer
funcionalidade de negócio, permitindo evoluir mobile e backend de forma coordenada,
com validação automatizada (lint, typecheck, testes) e CI desde o início.

## Decisão

Adotar um **monorepo gerenciado por pnpm workspaces** com a seguinte estrutura:

```text
apps/
  mobile/   # Expo + React Native + TypeScript
  api/      # Node.js + Fastify + TypeScript
packages/   # criado apenas quando houver utilidade real
docs/
  decisions/  # ADRs
.github/workflows/  # CI
```

Stack obrigatória da Phase 0:

- Gerenciador de pacotes: **pnpm** (workspaces).
- Linguagem: **TypeScript** em todo o repositório.
- Mobile: **React Native + Expo**.
- Backend: **Node.js + Fastify**.
- Banco de dados: **PostgreSQL**.
- ORM: **Drizzle ORM** (+ `drizzle-kit` para migrations futuras).
- Qualidade: **ESLint**, **Prettier**, **TypeScript** (typecheck) e **Vitest** (testes).

Comando de validação único na raiz:

```bash
pnpm validate   # lint + format:check + typecheck + test + build
```

Na Phase 0 a API expõe apenas `GET /health -> { "status": "ok" }` e o mobile
apresenta somente a tela inicial. A integração PostgreSQL + Drizzle é configurada
(cliente, `drizzle.config.ts`, validação de ambiente), mas **nenhuma tabela de
domínio** é criada ainda.

## Alternativas consideradas

- **Repositórios separados (polyrepo):** aumentaria o atrito para compartilhar
  tipos/contratos e manter mobile e backend sincronizados nesta fase inicial.
- **npm/yarn workspaces:** viáveis, mas o pnpm oferece instalação eficiente,
  `node_modules` mais estrito (evita dependências fantasma) e bom suporte a
  monorepo, alinhado à stack proposta no README.
- **ORM alternativo (Prisma):** Drizzle foi escolhido conforme o README, por ser
  próximo de SQL, tipado e com migrations explícitas.

## Consequências

Positivas:

- Base única para lint/typecheck/test/build e CI consistente.
- Evolução coordenada de mobile e backend, com espaço para `packages/*`
  compartilhados quando houver necessidade real.
- Contratos e limites de camada explícitos desde o começo.

Negativas / trade-offs:

- Exige disciplina de escopo para não antecipar funcionalidades de fases futuras.
- Pacotes compartilhados só devem ser criados quando trouxerem valor real, para
  evitar complexidade prematura.
