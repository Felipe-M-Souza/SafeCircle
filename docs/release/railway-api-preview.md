# API de preview no Railway

Como a API do SafeCircle está hospedada no Railway para o APK de preview, o
que foi configurado, o que foi verificado e o que continua fora do escopo. Sem
segredos: valores sensíveis vivem apenas nas variáveis do serviço no Railway.

## Decisão: Railway para API e PostgreSQL

A API usa PostgreSQL puro (postgres.js + Drizzle) e nada específico de outro
provedor. Manter API e banco no mesmo projeto do Railway dá rede privada
(`DATABASE_URL` interna, sem SSL nem pooler para configurar), domínio `https`
automático — exigido pela build de release do app, que bloqueia cleartext — e
um único lugar para variáveis e logs. Supabase foi considerado e descartado
para este caso: o pooler em modo transação quebra prepared statements do
postgres.js, o plano gratuito pausa o projeto após inatividade e nenhum recurso
além do PostgreSQL seria usado.

## Recursos criados (2026-09-16)

| Item           | Valor                                                                         |
| -------------- | ----------------------------------------------------------------------------- |
| Conta Railway  | workspace "My Projects" (mesma conta do NoCodeAnyApp), Hobby                  |
| Projeto        | `SafeCircle` — criado, não existia; ID `08a4e356-9c80-4852-9152-26f574e6fb64` |
| Ambiente       | `production` (único ambiente do projeto; usado como preview)                  |
| Serviços       | `Postgres` (template oficial, volume persistente) e `api`                     |
| Domínio da API | https://api-production-9e007.up.railway.app                                   |
| Painel         | https://railway.com/project/08a4e356-9c80-4852-9152-26f574e6fb64              |

O nome "production" é o ambiente padrão do Railway. Para o produto, este
deploy é **preview**: sem SLA, sem backup agendado, dados sintéticos apenas.

## Build e execução

- `apps/api/Dockerfile`: dois estágios (Node 22 alpine, pnpm 10.33.3), só
  dependências de produção no runtime, usuário `node`, `HEALTHCHECK` em
  `/health`. O container roda `node dist/scripts/migrate.js` e depois
  `node dist/server.js`: migrations pendentes são aplicadas a cada deploy e o
  start falha rápido se o banco estiver inacessível.
- `railway.json`: builder Dockerfile, `healthcheckPath: /health`, restart
  `ON_FAILURE` com 5 tentativas, 1 réplica. A variável
  `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile` no serviço garante o
  Dockerfile mesmo quando o Railpack seria escolhido.
- `.dockerignore` exclui git, `node_modules`, mobile, docs, `.env` e
  credenciais.
- Deploy feito com `railway up --service api` a partir da raiz do repositório
  (upload do diretório). Não há integração GitHub configurada: um novo deploy
  exige rodar `railway up` de novo, deliberadamente.

## Variáveis do serviço `api`

| Variável                  | Valor / origem                                                           |
| ------------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                | `production` (fail-fast: segredo forte, outbox ligada, push `expo`)      |
| `DATABASE_URL`            | referência `${{Postgres.DATABASE_URL}}` (host `*.railway.internal`)      |
| `JWT_ACCESS_SECRET`       | gerado pelo Railway com `${{secret(64)}}`; nunca passou por chat ou repo |
| `TRUST_PROXY`             | `1` (um proxy do Railway na frente)                                      |
| `HSTS_ENABLED`            | `true`                                                                   |
| `METRICS_ENABLED`         | `false` (sem `METRICS_TOKEN`, `/metrics` não é exposto)                  |
| `PUSH_PROVIDER`           | `expo`                                                                   |
| `OUTBOX_ENABLED`          | `true`                                                                   |
| `APP_VERSION`             | `0.1.0-rc.1`                                                             |
| `RAILWAY_DOCKERFILE_PATH` | `apps/api/Dockerfile`                                                    |
| `PORT`                    | injetado pelo Railway (a API escuta em `0.0.0.0:$PORT`)                  |

Não definidos, de propósito: `EXPO_ACCESS_TOKEN` (push funciona sem ele, sem
autenticação na Expo Push API), `CORS_ALLOWED_ORIGINS` (o app nativo não envia
`Origin`; em produção qualquer `Origin` presente é recusado), `METRICS_TOKEN`.

Para ver nomes sem expor valores: `railway variables --service api --json` e
inspecione apenas as chaves.

## Verificado após o deploy

| Verificação                               | Resultado                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Build da imagem                           | SUCCESS (deployment `6f4a0c96`) após duas falhas corrigidas, ver abaixo                                                       |
| Logs de start                             | `Migrations aplicadas com sucesso`, `outbox_worker_started`, `application_ready` (environment production, version 0.1.0-rc.1) |
| `GET /health`                             | 200 `{"status":"ok"}`                                                                                                         |
| `GET /ready`                              | 200, checks `startup` e `database` ok                                                                                         |
| `pnpm smoke:api` contra o domínio público | 9/9 PASS em 3.426 ms: health, ready, cadastro, login, grupo, alerta, resolução, logout, login + exclusão da conta sintética   |

Falhas de build registradas e corrigidas na mesma sessão:

1. `80c9b377`: o Railway escolheu o Railpack e falhou no `prepare`. Corrigido
   com `RAILWAY_DOCKERFILE_PATH`.
2. `0f5db34d`: `tsc` falhou nos `.d.ts` do drizzle-orm porque o
   `tsconfig.base.json` da raiz não estava na imagem (o tsconfig da API o
   estende). Corrigido copiando o arquivo no estágio de build.

## Operação

```bash
railway whoami                                  # sessão do CLI (login pelo navegador ou código)
railway status                                  # projeto/ambiente/serviço vinculados
railway up --service api --detach               # novo deploy a partir do diretório atual
railway logs --service api --deployment         # logs de execução
railway logs --service api --build              # logs de build
railway variables --service api --json          # ver só as chaves; nunca cole valores em chat
```

Rotinas de retenção (`privacy:cleanup`, `outbox:cleanup` etc.) **não** estão
agendadas neste deploy. Para um preview de curta duração isso é aceitável e
está registrado como pendência.

## Contas de teste

Nenhuma conta foi pré-cadastrada e o seed de E2E **não** foi executado neste
banco: as contas do seed têm senha conhecida e este banco está exposto na
internet. Crie a sua conta pelo próprio app. Se o seed for necessário para
testes, rode `pnpm e2e:seed` com a `DATABASE_URL` pública do Railway e troque
as senhas em seguida.

## Limitações

- Um único container: a outbox e os schedulers rodam dentro da API (ADR 0011).
  Sem réplicas.
- Plano Hobby: sem backup agendado do PostgreSQL; use `pg_dump` manual
  (`rollback-plan.md`) antes de qualquer migration destrutiva.
- Sem integração GitHub: deploys são manuais via CLI.
- Sem alertas de monitoramento configurados; `/metrics` desligado.
- Domínio `*.up.railway.app` gerado; nenhum domínio próprio.
- Isto não altera a classificação do RC (`RC PREPARED — DEVICE VALIDATION
PENDING`): validação em aparelho continua pendente.
