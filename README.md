# SafeCircle

> Rede privada de segurança para grupos de confiança, alertas de emergência, contexto do incidente e acompanhamento de segurança.

## Como executar localmente

Pré-requisitos: Node.js 22, `pnpm` (via `corepack enable`) e PostgreSQL.
Em Cloud Agents, o ambiente já provê tudo (ver `.cursor/environment.json`).

```bash
pnpm install                 # instala o monorepo
cp .env.example .env         # variáveis locais (o .env real não é versionado)
pnpm db:start                # sobe um PostgreSQL local self-contained
pnpm --filter @safecircle/api db:migrate   # aplica as migrations
pnpm dev:api                 # API em http://localhost:3000  (GET /health)
pnpm dev:mobile              # app mobile na web em http://localhost:8081
```

Validação e utilitários:

```bash
pnpm validate                # lint + format + typecheck + testes + build
pnpm db:check                # verifica a conexão PostgreSQL (Drizzle)
pnpm --filter @safecircle/api test      # testes de integração (usa PostgreSQL; lê DATABASE_URL do ambiente)
pnpm --filter @safecircle/mobile test   # testes do app mobile (Jest + jest-expo, sem GPS real)
```

**Status:** Phases 0 a 5 concluídas (Fundação, Autenticação, Grupos de
Confiança, Alerta de Emergência, Notificações Push e Atualizações em Tempo
Real). Phase 6 (Localização ao Vivo) implementada em **primeiro plano**: o
criador de um alerta ativo pode ativar, com consentimento explícito, o
compartilhamento da própria posição (`POST /alerts/:id/live-location/start`,
`POST /alerts/:id/live-location`, `.../stop`, `GET .../live-location` e
`.../history`); apenas membros atuais do grupo veem a posição em mapa com
precisão e indicação de desatualização; pontos são validados, limitados em
frequência e idempotentes; a sessão para automaticamente ao resolver/cancelar
o alerta; eventos realtime não carregam coordenadas; retenção de 30 dias via
`pnpm location:cleanup`. **Background location não foi implementado** (ver
ADR 0007). Phase 7 (Check-in de Segurança) concluída: o usuário inicia um
check-in em um grupo com prazo de 5 minutos a 24 horas (`POST /checkins`,
idempotente), confirma com "ESTOU BEM" (`POST /checkins/:id/safe`) ou cancela
(`.../cancel`); o servidor é o relógio autoritativo e um scheduler por polling
no PostgreSQL (a cada 15 s, lotes de 100, atualização condicional) marca
`OVERDUE` os check-ins vencidos, publica `CHECKIN_OVERDUE` por realtime e envia
push aos demais membros do grupo ("Check-in não confirmado"). Check-in vencido
**não** cria alerta SOS nem liga localização ao vivo; apenas membros do grupo
veem os check-ins (`GET /groups/:groupId/checkins`); retenção de 90 dias via
`pnpm checkin:cleanup` (ver ADR 0008). Phase 8 (Trajeto Seguro) concluída: o
usuário inicia um trajeto para um grupo, com destino textual opcional e chegada
prevista de 10 minutos a 24 horas (`POST /journeys`, idempotente), confirma a
chegada com "CHEGUEI EM SEGURANÇA" (`POST /journeys/:id/arrive`) ou cancela
(`.../cancel`); há no máximo um trajeto não-finalizado por usuário. O servidor é
o relógio autoritativo e um scheduler (o mesmo motor da Phase 7) marca `OVERDUE`
os trajetos vencidos, publica `JOURNEY_OVERDUE` por realtime e envia push aos
demais membros ("Trajeto não confirmado"). Trajeto atrasado **não** cria alerta
SOS. Opcionalmente (opt-in explícito, `liveLocationEnabled`), o dono compartilha
a localização ao vivo durante o trajeto, em **primeiro plano** (mesma limitação
da Phase 6), em tabelas próprias; a sessão encerra ao chegar/cancelar. Retenção:
localização em 30 dias e trajeto em 90 dias via `pnpm journey:cleanup` (ver
ADR 0009). Phase 9 (Observabilidade e Confiabilidade) concluída, sem mudança
funcional: toda requisição tem `requestId` (devolvido em `X-Request-Id` e
presente em toda resposta de erro), falhas internas ganham `errorId` que o app
mostra como "Código de suporte", logs são estruturados com redaction
centralizada, `GET /ready` verifica o banco (503 quando não pronta) enquanto
`GET /health` segue sendo liveness puro, `GET /metrics` expõe métricas
Prometheus (desabilitado por padrão, protegível por token) e ações críticas
deixam trilha em `audit_events`, com retenção de 180 dias via
`pnpm audit:cleanup` (ver ADR 0010 e o [runbook](docs/operations/runbook.md)).
Phase 10 (Outbox Transacional, Workers e Entregas Confiáveis) concluída, também
sem mudança funcional: push, realtime e auditoria passaram a ser gravados na
**mesma transação** da mudança de domínio, na tabela `outbox_events`, e
entregues por um worker persistente com claim por `FOR UPDATE SKIP LOCKED`,
lease, retry com backoff exponencial e dead-letter. A janela em que um alerta
era criado e a notificação se perdia no restart deixou de existir. A entrega é
**at-least-once** (ver ADR 0011). Phase 11 (Security & Privacy Hardening)
concluída, sem mudança de contrato nas rotas existentes: threat model e matriz
de autorização versionados e testados, validação de sessão a cada requisição,
sessões listáveis e revogáveis (`/me/sessions`), detecção de reuso de refresh
token, freio de login por conta, senha mínima de 12 caracteres para contas
novas, produção fail-fast, CORS por allow-list, cabeçalhos de segurança,
limite de corpo (413) e só JSON (415), WebSocket com validação de `Origin` e
de sessão, exportação dos próprios dados (`GET /me/privacy/export`),
`pnpm privacy:cleanup` consolidando toda a retenção e CI com menor privilégio,
actions fixadas por SHA, Dependabot, auditoria de dependências e CodeQL (ver
ADR 0012). Phase 12 (E2E / Release Candidate) concluída: o bloqueador de
exclusão de conta foi **resolvido** (`POST /me/delete-account` com senha,
bloqueios explícitos e transferência de propriedade de grupo), existe uma
suíte E2E que sobe o processo real da API (`pnpm e2e:api`, 21 cenários),
smoke (`pnpm smoke:api`), `pnpm release:check`, `eas.json` com três perfis,
flows Maestro, ensaios de migration, backup/restore e queda de banco, e os
documentos de release em `docs/release/`. A v1 permanece **foreground-only**
para localização. Classificação do RC 0.1.0-rc.1: **RC PREPARED — DEVICE
VALIDATION PENDING** (sem aparelho físico nem credenciais EAS neste
ambiente; ver ADR 0013).

**Localização ao vivo (requisitos):** funciona com o app aberto (primeiro
plano). O mapa usa `react-native-maps`: iOS usa Apple Maps; em builds de
produção Android é necessária uma chave do Google Maps em
`apps/mobile/app.json` (`expo.android.config.googleMaps.apiKey`) — nunca
versione a chave real. Na web o mapa é substituído por um placeholder. A
retenção de dados de localização deve ser executada periodicamente em
produção (ex.: cron diário):

```bash
pnpm location:cleanup        # apaga localização de alertas encerrados há mais de 30 dias
```

**Check-in de segurança (requisitos):** o vencimento é decidido pelo servidor
(scheduler interno da API, instância única — ver ADR 0008); o app mostra apenas
um contador visual e, ao zerar, consulta o backend. A retenção de check-ins
finalizados (90 dias) deve rodar periodicamente em produção (ex.: cron diário):

```bash
pnpm checkin:cleanup         # apaga check-ins finalizados (SAFE/CANCELLED/OVERDUE) há mais de 90 dias
```

**Trajeto seguro (requisitos):** o vencimento é decidido pelo servidor (mesmo
scheduler interno da Phase 7, instância única — ver ADR 0009); o app mostra
apenas um contador visual e, ao zerar, consulta o backend. A localização ao
vivo do trajeto é opt-in e funciona apenas em primeiro plano (mesma limitação
do alerta, ADR 0007). A retenção do trajeto (localização em 30 dias, trajeto em
90 dias) deve rodar periodicamente em produção (ex.: cron diário):

```bash
pnpm journey:cleanup         # apaga localização (30 dias) e trajetos finalizados (90 dias)
```

**Observabilidade e operação (Phase 9):** o guia de plantão é o
[runbook](docs/operations/runbook.md); as decisões estão no ADR 0010.

| Endpoint   | Para quê                                                              |
| ---------- | --------------------------------------------------------------------- |
| `/health`  | Liveness — o processo responde. Não consulta o banco.                  |
| `/ready`   | Readiness — verifica o banco (timeout curto). `503` quando não pronta. |
| `/metrics` | Métricas Prometheus. Desabilitado por padrão (404).                    |

Variáveis novas (ver `.env.example`; nenhuma tem valor real versionado):

| Variável          | Padrão  | Efeito                                                          |
| ----------------- | ------- | --------------------------------------------------------------- |
| `METRICS_ENABLED` | `false` | `true` registra `GET /metrics`; `false` faz a rota não existir.  |
| `METRICS_TOKEN`   | vazio   | Quando definido, `/metrics` exige `Authorization: Bearer`.        |
| `APP_VERSION`     | vazio   | Aparece nos logs de startup e em `/ready`.                        |
| `GIT_SHA`         | vazio   | Aparece nos logs de startup.                                      |

Habilitar `/metrics` **sem** `METRICS_TOKEN` só é aceitável com a porta em rede
privada. A trilha de auditoria precisa de limpeza periódica (cron diário):

```bash
pnpm audit:cleanup           # apaga eventos de auditoria com mais de 180 dias
```

**Outbox transacional (Phase 10):** nenhuma rota mudou de contrato. O que mudou
é que efeito não se perde mais: ou a mudança de domínio e seus efeitos são
gravados no mesmo `COMMIT`, ou nenhum dos dois existe. As decisões estão no
ADR 0011 e a operação na seção 7 do [runbook](docs/operations/runbook.md).

A entrega é **at-least-once**, não exactly-once: um push pode chegar duas vezes
se o processo cair entre o envio e a marcação de concluído. Realtime e auditoria
são idempotentes por construção (o `eventId` publicado é estável entre
tentativas e a trilha tem chave única por evento de origem). Preferimos duplicar
a perder um pedido de ajuda.

Variáveis novas (ver `.env.example`; nenhuma é segredo):

| Variável                  | Padrão  | Efeito                                                      |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `OUTBOX_ENABLED`          | `true`  | `false` grava os efeitos mas não entrega nada.              |
| `OUTBOX_POLL_INTERVAL_MS` | `500`   | Intervalo de polling do worker (100–60000).                 |
| `OUTBOX_BATCH_SIZE`       | `50`    | Eventos reivindicados por ciclo (1–500).                    |
| `OUTBOX_CONCURRENCY`      | `5`     | Entregas simultâneas por ciclo (1–50).                      |
| `OUTBOX_LEASE_MS`         | `60000` | `PROCESSING` mais antigo que isso volta para a fila.        |

Comandos de operação e retenção (o de limpeza em cron diário):

```bash
pnpm outbox:status                     # backlog e idade do pendente mais antigo
pnpm outbox:list-dead                  # eventos que exigem decisão humana
pnpm outbox:retry-dead -- --id <uuid>  # reenfileira UM evento em dead-letter
pnpm outbox:cleanup                    # processados (30 d) e dead-letter (90 d)
```

`outbox:cleanup` **nunca** apaga eventos pendentes ou em processamento, e
`retry-dead` só aceita eventos em dead-letter — reenfileirar trabalho que já
está na fila criaria processamento concorrente do mesmo efeito. O payload não é
editável por nenhum comando: a CLI reprocessa, não reescreve histórico.

**Segurança e privacidade (Phase 11):** as decisões estão no ADR 0012; o
modelo de ameaças, a matriz de autorização, o checklist do repositório, a
resposta a incidentes e o checklist de release ficam em `docs/security/`; o
inventário de dados pessoais e a política de retenção, em `docs/privacy/`.

Variáveis novas (ver `.env.example`; nenhuma é segredo):

| Variável               | Padrão  | Efeito                                                                      |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS` | vazio   | Allow-list `https://host[:porta]`, sem wildcard; vale para CORS e WebSocket. |
| `HSTS_ENABLED`         | `false` | Liga HSTS; só onde o TLS externo é garantido pelo ingress.                  |
| `TRUST_PROXY`          | `false` | `true` ou número de saltos; só confie em `X-Forwarded-*` atrás do seu proxy. |

Em `NODE_ENV=production` a API **recusa subir** com `JWT_ACCESS_SECRET` ausente
ou fraco, sem `DATABASE_URL`, com `OUTBOX_ENABLED=false`, com `/metrics`
habilitado sem token ou com origem CORS inválida. Nenhuma mensagem de erro
imprime o valor de um segredo.

Rotas novas, todas do próprio usuário autenticado:

```text
GET    /me/sessions                  sessões ativas (sem hash, IP ou User-Agent)
DELETE /me/sessions/:sessionId       revoga uma sessão própria (inclusive a atual)
POST   /me/sessions/revoke-others    encerra todas menos a atual
GET    /me/privacy/export            exportação JSON dos próprios dados (5/h)
```

Revogar uma sessão tem efeito imediato: o access token dela deixa de valer na
próxima requisição e o WebSocket é fechado. A exportação nunca inclui senha,
hashes, tokens, dados de outros membros nem internos da outbox/auditoria.

Comandos (o de retenção em cron diário; o de auditoria roda no CI):

```bash
pnpm privacy:cleanup   # todas as políticas de retenção em uma execução; nunca apaga ACTIVE
pnpm security:audit    # dependências com advisory high/critical
```

Limitações conhecidas desta fase: rate limit e freio de login são **por
instância**; não há MFA nem troca de senha; GPS spoofing é risco residual; a
entrega de push continua at-least-once; as configurações de segurança do GitHub
são manuais (`docs/security/repository-security.md`); TLS, encryption at rest e
backups dependem da infraestrutura. A exclusão de conta, bloqueador desta
fase, foi resolvida na Phase 12.

**E2E e Release Candidate (Phase 12):** decisões no ADR 0013; artefatos em
`docs/release/` (checklist, bloqueadores, evidências, release notes, test
report, plano de testes em aparelho, rollback, insumos de privacidade e de
lojas).

Exclusão de conta, no app em "Excluir minha conta" ou pela API, sempre com a
senha atual:

```text
GET  /me/account-deletion                bloqueios e impacto
POST /me/delete-account   { password }   exclui; 409 se OWNER de grupo com outros membros ou recurso ativo
POST /groups/:groupId/transfer-ownership { userId }   OWNER passa a propriedade e vira ADMIN
```

Comandos de E2E e release:

```bash
pnpm e2e:api           # API real + PostgreSQL descartável, 21 cenários (roda no CI)
pnpm e2e:reset         # zera o banco E2E     |  pnpm e2e:seed  # contas sintéticas
pnpm e2e:mobile        # flows Maestro (exige development build + Maestro)
pnpm smoke:api         # 9 etapas contra SMOKE_API_URL
pnpm release:check     # todos os gates determinísticos do RC
pnpm release:blockers  # bug bar (docs/release/release-blockers.md)
```

Variáveis novas (ver `.env.example`): `PUSH_PROVIDER` (`expo` | `noop`, este
só fora de produção), `RATE_LIMIT_PROFILE` e `SCHEDULER_POLL_INTERVAL_MS`
(ambiente E2E; ignorados em produção), `BUILD_DATE`. No mobile,
`EXPO_PUBLIC_APP_ENV` (development | preview | production) e
`EXPO_PUBLIC_GIT_SHA` são públicos e aparecem no rodapé da home.

### API de preview no Railway

A API roda no Railway (projeto `SafeCircle`, serviços `api` e `Postgres`)
em https://api-production-9e007.up.railway.app, a partir de
`apps/api/Dockerfile` e `railway.json`. O container aplica as migrations e
sobe a API; segredos ficam só nas variáveis do serviço (o `JWT_ACCESS_SECRET`
foi gerado pelo próprio Railway). Deploys são manuais, a partir da raiz:

```bash
railway whoami
railway up --service api --detach
railway logs --service api --deployment
```

É um ambiente de preview com dados sintéticos, sem backup agendado nem SLA.
Detalhes, variáveis e limitações em `docs/release/railway-api-preview.md`.

Limitações conhecidas desta fase: nenhuma validação em aparelho físico foi
executada (push real, permissões, GPS, foreground/background, offline no app,
deep links) e nenhum binário EAS foi gerado — ambos exigem aparelho e
credenciais do proprietário e estão marcados `NOT EXECUTED` em
`docs/release/test-report.md`. A localização ao vivo continua só em primeiro
plano por decisão explícita. Não há tag de release nem publicação nas lojas.

**Push (requisitos):** notificações funcionam apenas em build nativo
(iOS/Android) — na web o recurso fica indisponível. Para obter o Expo Push
Token em builds EAS, configure o `projectId` público em `apps/mobile/app.json`
(`expo.extra.eas.projectId`); credenciais FCM/APNs ficam na conta Expo/EAS,
nunca neste repositório. No backend, `EXPO_ACCESS_TOKEN` (opcional, segredo)
autentica o envio na Expo Push API. Ver ADR 0005.

## 1. Visão geral

O **SafeCircle** é um aplicativo mobile de segurança pessoal criado para permitir que uma pessoa peça ajuda rapidamente a uma rede privada de pessoas de confiança quando se sentir em risco ou precisar de auxílio.

O aplicativo será desenvolvido inicialmente em **Português do Brasil (pt-BR)**.

No futuro, poderá receber suporte a outros idiomas, mas o idioma padrão do produto, da documentação funcional e dos textos apresentados ao usuário será o português.

O SafeCircle é baseado em **grupos privados de confiança**, como:

- Família
- Amigos próximos
- Vizinhos
- Companheiros de viagem

Quando um usuário aciona um alerta de emergência, os membros autorizados do grupo selecionado podem receber uma notificação e acompanhar o incidente pelo aplicativo.

As primeiras versões devem priorizar:

- Segurança
- Privacidade
- Confiabilidade
- Simplicidade
- Experiência clara em situações de emergência
- Coleta mínima de dados

> O SafeCircle não substitui Polícia, SAMU, Corpo de Bombeiros ou outros serviços oficiais de emergência.

---

# 2. Idioma e internacionalização

## Idioma inicial

O idioma oficial da primeira versão do SafeCircle será:

```text
pt-BR
```

Isso inclui:

- Interface do aplicativo
- Mensagens de erro apresentadas ao usuário
- Notificações
- Documentação funcional
- README
- ADRs
- Issues e Pull Requests, salvo necessidade específica
- Comentários de negócio quando realmente necessários

## Preparação para outros idiomas

O código deve evitar espalhar textos de interface diretamente pelos componentes.

Sempre que fizer sentido, textos apresentados ao usuário devem ficar centralizados para permitir internacionalização futura.

A arquitetura deve permitir futuramente:

```text
pt-BR
en-US
es
```

sem exigir reescrita do domínio.

Não é necessário adicionar uma biblioteca completa de internacionalização na Phase 0, a menos que seja simples e não aumente desnecessariamente a complexidade.

## Código-fonte

Nomes técnicos de bibliotecas, comandos, protocolos, APIs e tecnologias permanecem em seu formato original.

Identificadores internos de código podem ser mantidos em inglês quando isso melhorar consistência com o ecossistema TypeScript/React Native/Fastify.

Exemplo:

```ts
createEmergencyAlert()
trustedGroup
alertStatus
```

A interface apresentada ao usuário continuará em português:

```text
Acionar alerta
Grupo de confiança
Alerta ativo
```

---

# 3. Visão do produto

Fluxo principal esperado:

```text
Usuário percebe uma situação de risco
                ↓
        Aciona o botão SOS
                ↓
Backend cria um incidente de emergência
                ↓
Membros do grupo de confiança são notificados
                ↓
       Abrem o incidente
                ↓
      Confirmam o recebimento
                ↓
Visualizam contexto/localização autorizada
                ↓
Usuário encerra o incidente com segurança
```

Funcionalidades futuras podem incluir:

- Botão SOS
- Grupos de confiança
- Notificações push
- Localização durante incidentes
- Confirmação de recebimento
- Check-in de segurança
- Trajeto seguro
- Contatos de emergência
- Histórico de alertas
- Atalhos por wearable

Essas funcionalidades **não devem ser antecipadas** sem que façam parte da fase atual.

---

# 4. Princípios do produto

## 4.1 Privado por padrão

Informações de emergência só podem ser acessadas por usuários autorizados.

Não deve existir feed público de ocorrências.

## 4.2 Segurança antes de conveniência

Fluxos críticos devem favorecer comportamento previsível e seguro.

Exemplos:

- Evitar acionamento acidental do SOS.
- Nunca informar que um alerta foi entregue sem confirmação real.
- Nunca expor localização a usuários não autorizados.
- Não esconder falhas em fluxos de emergência.

## 4.3 Minimização de dados

Coletar somente o necessário.

Não coletar:

- Localização contínua por padrão.
- Dados pessoais sem necessidade.
- Histórico excessivo.
- Dados apenas porque "podem ser úteis futuramente".

## 4.4 Backend como autoridade

O aplicativo mobile nunca deve ser tratado como autoridade de segurança.

O backend deve validar:

- Identidade
- Participação no grupo
- Permissões
- Propriedade de recursos
- Visibilidade de alertas
- Transições de estado

## 4.5 Sem funcionalidade de vigilância ou confronto

O SafeCircle não deve se transformar em ferramenta para:

- Identificar publicamente pessoas consideradas suspeitas.
- Publicar acusações.
- Rastrear terceiros.
- Coordenar confrontos.
- Criar vigilância pública.

O princípio é:

> "Posso estar em perigo e quero que minha rede de confiança saiba."

---

# 5. Escopo do MVP

## 5.1 Autenticação

Usuários poderão:

- Criar conta
- Entrar
- Sair
- Manter sessão autenticada com segurança

## 5.2 Grupos de confiança

Usuários poderão:

- Criar grupo
- Visualizar grupos
- Convidar membros
- Visualizar membros
- Sair do grupo quando permitido

Papéis iniciais possíveis:

```text
OWNER
ADMIN
MEMBER
```

Não criar complexidade de permissões antes de existir necessidade real.

## 5.3 Alerta de emergência

O alerta deve possuir inicialmente:

- Criador
- Grupo
- Data/hora
- Status
- Localização inicial quando disponível e autorizada
- Ciclo de vida
- Confirmações dos destinatários

Estados iniciais:

```text
ACTIVE
RESOLVED
CANCELLED
```

A interface poderá apresentar:

```text
ATIVO
RESOLVIDO
CANCELADO
```

## 5.4 Confirmação do alerta

Tipos conceituais:

```text
SEEN
ACKNOWLEDGED
GOING_TO_HELP
EMERGENCY_SERVICES_CONTACTED
```

Apresentação ao usuário:

```text
Viu o alerta
Confirmou o alerta
Está indo ajudar
Acionou serviço de emergência
```

## 5.5 Localização

Localização é um dado sensível.

Regras:

- Solicitar permissão explicitamente.
- Não rastrear continuamente fora de uma funcionalidade ativa.
- Não expor localização fora do grupo autorizado.
- Não registrar coordenadas precisas em logs comuns.
- Encerrar coleta quando o incidente terminar.
- Usar coordenadas fictícias em testes.

## 5.6 Notificações push

Exemplo inicial:

```text
🚨 Alerta SafeCircle

Felipe acionou um alerta de emergência em um dos seus grupos de confiança.

Abra o SafeCircle para visualizar o incidente.
```

Não incluir coordenadas exatas ou informações excessivamente sensíveis na tela bloqueada.

---

# 6. Telas previstas

```text
1. Splash / Restauração de sessão

2. Entrar

3. Criar conta

4. Início
   - Estado de segurança
   - Botão SOS
   - Grupo de confiança atual

5. Grupos de confiança
   - Lista de grupos

6. Detalhes do grupo
   - Membros
   - Convites

7. Alerta ativo
   - Quem acionou
   - Status
   - Horário
   - Localização autorizada
   - Confirmações

8. Histórico de alertas

9. Perfil / Configurações
```

Nem todas essas telas pertencem à Phase 0.

---

# 7. Stack proposta

## Mobile

- React Native
- Expo
- TypeScript

## Backend

- Node.js
- Fastify
- TypeScript

## Banco de dados

- PostgreSQL

## ORM

- Drizzle ORM

## Monorepo

- pnpm workspaces

## Autenticação

Direção inicial:

- Access Token
- Refresh Token
- Hash seguro de senha

## Push

Planejado:

- Expo Notifications
- FCM / APNs

## Tempo real

Planejado:

- WebSocket

Tempo real não será a fonte de verdade.

## Mapas

Fornecedor será definido posteriormente.

Possibilidades:

- Google Maps
- Mapbox

---

# 8. Estrutura do repositório

```text
SafeCircle/
│
├── apps/
│   ├── mobile/
│   │   ├── src/
│   │   ├── assets/
│   │   ├── app.json
│   │   └── package.json
│   │
│   └── api/
│       ├── src/
│       ├── tests/
│       └── package.json
│
├── packages/
│   ├── shared/
│   ├── types/
│   └── config/
│
├── docs/
│   ├── architecture/
│   └── decisions/
│
├── .cursor/
│   └── rules/
│
├── .github/
│   └── workflows/
│
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

Pacotes compartilhados só devem ser criados quando houver utilidade real.

---

# 9. Direção do backend

Estrutura sugerida:

```text
apps/api/src/
│
├── app/
│
├── modules/
│   ├── auth/
│   ├── users/
│   ├── groups/
│   └── alerts/
│
├── infrastructure/
│   ├── database/
│   ├── push/
│   └── logging/
│
├── plugins/
├── config/
├── app.ts
└── server.ts
```

Fluxo preferido:

```text
Rota HTTP
    ↓
Validação
    ↓
Autenticação / Autorização
    ↓
Serviço de aplicação
    ↓
Domínio / Persistência
    ↓
Resposta
```

Rotas devem permanecer enxutas.

---

# 10. Modelo de domínio inicial

## User

```text
User
├── id
├── name
├── email
├── passwordHash
├── createdAt
└── updatedAt
```

## TrustedGroup

```text
TrustedGroup
├── id
├── name
├── ownerUserId
├── createdAt
└── updatedAt
```

## GroupMembership

```text
GroupMembership
├── id
├── groupId
├── userId
├── role
├── status
├── createdAt
└── updatedAt
```

## EmergencyAlert

```text
EmergencyAlert
├── id
├── createdByUserId
├── groupId
├── status
├── createdAt
├── activatedAt
├── resolvedAt
└── cancelledAt
```

## AlertLocation

```text
AlertLocation
├── id
├── alertId
├── latitude
├── longitude
├── accuracy
└── capturedAt
```

## AlertAcknowledgement

```text
AlertAcknowledgement
├── id
├── alertId
├── userId
├── type
└── createdAt
```

Os identificadores internos podem permanecer em inglês para consistência técnica.

---

# 11. Ciclo de vida do alerta

```text
          ┌───────────┐
          │  ACTIVE   │
          └─────┬─────┘
                │
        ┌───────┴────────┐
        ▼                ▼
  ┌──────────┐     ┌───────────┐
  │ RESOLVED │     │ CANCELLED │
  └──────────┘     └───────────┘
```

Regras:

- Somente atores autorizados podem encerrar/cancelar.
- Alertas encerrados não podem sofrer transições arbitrárias.
- O cliente não pode impor estados inválidos.
- As regras de transição pertencem ao servidor.

---

# 12. Direção da API

## Saúde

```http
GET /health
```

## Autenticação

```http
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout
```

## Usuário

```http
GET /me
```

## Grupos

```http
GET    /groups
POST   /groups
GET    /groups/:groupId
POST   /groups/:groupId/invitations
GET    /groups/:groupId/members
```

## Alertas

```http
POST   /alerts
GET    /alerts/:alertId
POST   /alerts/:alertId/acknowledgements
POST   /alerts/:alertId/resolve
POST   /alerts/:alertId/cancel
```

Esses endpoints são conceituais e não devem ser todos implementados na Phase 0.

---

# 13. Segurança

Este é um repositório público.

Nunca versionar:

```text
DATABASE_URL real
JWT_SECRET
REFRESH_TOKEN_SECRET
AWS_SECRET_ACCESS_KEY
Firebase service-account.json
Credenciais privadas do FCM
Certificados privados
Chaves de assinatura Android
Certificados Apple
Telefones reais usados como fixture
Endereços residenciais reais
Histórico real de localização
```

---

# 14. Variáveis de ambiente

Arquivo local:

```text
.env
```

Nunca versionado.

Arquivo público:

```text
.env.example
```

Exemplo:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=

JWT_SECRET=
REFRESH_TOKEN_SECRET=

EXPO_PUBLIC_API_URL=http://localhost:3000
```

Nunca colocar segredo de servidor em variáveis `EXPO_PUBLIC_*`.

Tudo que chega ao cliente mobile deve ser considerado público.

---

# 15. Logs

Nunca registrar:

- Senhas
- Access Tokens
- Refresh Tokens
- Authorization headers
- Secrets JWT
- Chaves privadas
- Credenciais de banco
- Trilhas completas de localização precisa

Usar logs estruturados.

---

# 16. Erros

A API deve usar códigos estáveis e legíveis por máquina.

Exemplos:

```text
VALIDATION_ERROR
UNAUTHORIZED
FORBIDDEN
USER_NOT_FOUND
GROUP_NOT_FOUND
ALERT_NOT_FOUND
ALERT_ALREADY_CLOSED
INVALID_ALERT_TRANSITION
```

A interface mobile é responsável por traduzir isso em mensagens em português.

Exemplo:

```text
ALERT_ALREADY_CLOSED
→
Este alerta já foi encerrado.
```

---

# 17. Idempotência

A arquitetura deve prever idempotência para operações críticas.

Exemplos:

- Criar alerta
- Confirmar alerta
- Encerrar alerta
- Registrar push token

Uma tentativa repetida por falha de rede não deve criar vários incidentes.

A implementação completa virá na fase adequada.

---

# 18. Tempo real

Princípio:

```text
Banco de dados = estado autoritativo

WebSocket = propagação rápida

Push = aviso fora do aplicativo
```

Falha em WebSocket não pode invalidar o alerta.

---

# 19. Estratégia de testes

## Unitários

- Regras de domínio
- Transições de estado
- Funções puras

## Integração

- API
- Autenticação
- Autorização
- Banco
- Isolamento entre grupos

## Mobile

- Fluxos críticos
- Estados de permissão
- Falhas
- Interação do SOS

## E2E futuro

- Login
- Criação de grupo
- Acionamento do alerta
- Recebimento
- Encerramento

---

# 20. Testes críticos de autorização

Quando essas funcionalidades existirem:

```text
Usuário A pertence ao Grupo A.
Usuário B pertence ao Grupo B.

Usuário B NÃO pode:

- Ler dados do Grupo A.
- Ler alerta do Grupo A.
- Ler localização do Grupo A.
- Confirmar alerta do Grupo A.
- Encerrar alerta do Grupo A.
```

Ocultar um botão na interface não é autorização.

---

# 21. CI

GitHub Actions deve executar, quando disponíveis:

```text
Instalação
Lint
Typecheck
Testes
Build / validação
```

Não esconder falhas com `|| true`.

---

# 22. Estratégia Git

```text
main
 ↑
feature/*
fix/*
chore/*
docs/*
test/*
```

Exemplos:

```text
feature/project-foundation
feature/authentication
feature/trusted-groups
feature/emergency-alert
feature/live-location
```

---

# 23. Pull Requests

Fluxo preferido:

```text
main
 ↓
branch
 ↓
implementação
 ↓
testes
 ↓
revisão do diff
 ↓
commit
 ↓
push
 ↓
Pull Request
 ↓
CI
 ↓
merge manual
```

O Cursor não deve fazer merge sem instrução explícita.

---

# 24. Regras do Cursor

As regras ficam em:

```text
.cursor/rules/
```

O Cursor deve ler e respeitar todos os arquivos antes de iniciar uma fase.

Regras centrais:

```text
00-project-core.mdc
05-security-privacy.mdc
09-milestone-definition-of-done.mdc
10-language-localization.mdc
```

---

# 25. ADRs

Decisões arquiteturais importantes devem ser registradas em:

```text
docs/decisions/
```

Exemplos:

```text
0001-monorepo-e-stack.md
0002-estrategia-autenticacao.md
0003-ciclo-alerta.md
0004-arquitetura-notificacoes.md
0005-tempo-real.md
0006-retencao-localizacao.md
```

---

# 26. Roadmap

## Phase 0 — Fundação

Objetivo:

Criar uma base limpa, testável e segura antes das funcionalidades de negócio.

### Escopo

- Monorepo pnpm
- TypeScript
- `apps/mobile`
- `apps/api`
- Expo
- Fastify
- PostgreSQL
- Drizzle
- `.env.example`
- `.gitignore`
- Endpoint `/health`
- Testes
- Lint
- Typecheck
- CI
- ADR inicial
- Documentação

### Mobile

Exibir apenas uma tela inicial simples:

```text
SafeCircle

Sua rede de confiança para situações de emergência.

Ambiente de desenvolvimento configurado.
```

Não implementar autenticação ou SOS ainda.

### API

Criar:

```http
GET /health
```

Resposta:

```json
{
  "status": "ok"
}
```

### Banco

Preparar integração PostgreSQL + Drizzle.

Não criar ainda todo o modelo de domínio.

### Definition of Done

Phase 0 só está concluída quando:

- Monorepo instala corretamente.
- Mobile inicia/valida.
- API inicia.
- `/health` funciona.
- Banco está configurado.
- `.env.example` existe.
- Nenhum segredo foi commitado.
- Lint passa.
- Typecheck passa.
- Testes passam.
- Build/validação passa.
- CI está configurado.
- Documentação corresponde ao código real.

---

## Phase 1 — Autenticação

Planejado:

- User
- Cadastro
- Login
- Hash de senha
- Sessão
- Refresh
- `/me`
- Logout
- Telas mobile
- Secure storage
- Testes

Não iniciar antes da conclusão da Phase 0.

---

## Phase 2 — Grupos de confiança

Planejado:

- Grupos
- Memberships
- Convites
- Papéis básicos
- Autorização
- Telas mobile

---

## Phase 3 — Alerta de emergência

Planejado:

- EmergencyAlert
- UX intencional do SOS
- Criação do alerta
- Estado ativo
- Localização inicial
- Autorização
- Resolução/cancelamento

---

## Phase 4 — Notificações push

Planejado:

- Registro do dispositivo
- Push tokens
- Abstração de notificações
- Alertas
- Conteúdo mínimo na tela bloqueada

---

## Phase 5 — Atualizações em tempo real

Planejado:

- WebSocket
- Atualizações do incidente
- Confirmações
- Reconexão
- Ressincronização

---

## Phase 6 — Localização ao vivo

Planejado:

- Atualização durante incidente
- Permissões
- Frequência
- Política de retenção
- Mapa

---

## Phase 7 — Check-in de segurança

Planejado:

- Timer
- Confirmação esperada
- Check-in perdido
- Notificação ao grupo

---

## Phase 8 — Trajeto seguro

Concluída (ver ADR 0009):

- Iniciar trajeto para um grupo, com destino textual opcional e chegada prevista
- Confirmar chegada, cancelar e vencimento (`OVERDUE`) pelo scheduler do servidor
- Push e realtime de atraso; um trajeto não-finalizado por usuário
- Localização ao vivo opcional (opt-in, primeiro plano, tabelas próprias)
- Retenção via `pnpm journey:cleanup`

Escopo original (referência):

- Iniciar trajeto
- Destino
- ETA
- Compartilhamento
- Confirmação de chegada
- Escalonamento

---

# 27. Instrução para o Cursor — Phase 0

Implemente a **Phase 0 — Fundação** do SafeCircle.

Antes de alterar qualquer arquivo:

1. Leia este `README.md` por completo.
2. Leia todos os arquivos em `.cursor/rules/`.
3. Inspecione a estrutura atual do repositório.
4. Verifique o estado atual do Git.
5. Preserve alterações existentes do usuário.
6. Não implemente funcionalidades da Phase 1 ou posteriores.

## Stack obrigatória da Phase 0

```text
pnpm
TypeScript

Mobile:
React Native
Expo

API:
Node.js
Fastify

Banco:
PostgreSQL
Drizzle ORM
```

## Estrutura mínima

```text
apps/mobile
apps/api
packages
docs/decisions
.github/workflows
```

Não criar pacotes vazios sem necessidade.

## Root

Configurar:

- pnpm workspace
- TypeScript
- Lint
- Formatação
- Scripts de validação

Criar um comando raiz equivalente a:

```bash
pnpm validate
```

Ele deve executar os checks realmente existentes.

## API

Criar Fastify com:

```http
GET /health
```

Resposta semântica:

```json
{
  "status": "ok"
}
```

Adicionar teste automatizado.

## Mobile

Criar aplicação Expo + React Native + TypeScript.

Tela inicial em português:

```text
SafeCircle

Sua rede de confiança para situações de emergência.

Ambiente de desenvolvimento configurado.
```

Não implementar:

- Login
- Grupos
- SOS
- Push
- Mapas

## Banco

Configurar:

- PostgreSQL
- Drizzle
- Configuração Drizzle
- Cliente de banco
- Configuração por ambiente

Não criar ainda todas as tabelas futuras.

## Ambiente

Criar:

```text
.env.example
```

Ignorar arquivos `.env` reais.

Nunca colocar secrets em `EXPO_PUBLIC_*`.

## Testes

No mínimo:

- Teste do endpoint `/health`

Adicionar outros testes somente quando trouxerem valor real.

## CI

Criar GitHub Actions para:

- Instalar dependências
- Lint
- Typecheck
- Testes
- Build/validação aplicável

Não suprimir falhas.

## ADR

Criar:

```text
docs/decisions/0001-monorepo-e-stack.md
```

O ADR deve estar em português e explicar:

- Contexto
- Decisão
- Stack
- Motivo do monorepo
- Consequências

## Idioma

Todo texto apresentado ao usuário deve estar em português do Brasil.

Documentação e ADRs devem ser escritos em português.

Não traduzir nomes de tecnologias, comandos ou contratos técnicos que dependam de nomes estáveis.

Estruturar textos de interface de forma a facilitar internacionalização futura.

## Segurança

Antes de concluir:

- Verificar que nenhum segredo foi versionado.
- Verificar que `.env` está ignorado.
- Verificar que não existem endereços reais.
- Verificar que não existem telefones reais.
- Verificar que não existem coordenadas pessoais reais.
- Revisar o diff.

## Validação

Executar os comandos reais do projeto.

Não afirmar que algo passou sem executar.

## Git

Se houver acesso:

1. Criar branch:

```text
feature/project-foundation
```

2. Implementar.
3. Validar.
4. Revisar diff.
5. Commitar.
6. Fazer push.
7. Abrir Pull Request.
8. Verificar CI quando possível.
9. Não fazer merge.

## Resposta final esperada do Cursor

```text
## Concluído

## Arquitetura

## Validação

## Arquivos / ADRs

## Git / Pull Request

## Observações
```

Relatar somente ações realmente executadas.

---

# 28. Fora do escopo da Phase 0

Não implementar:

- Cadastro
- Login
- JWT completo
- Grupos
- Convites
- Alertas
- SOS funcional
- Push
- Mapas
- WebSocket
- Localização ao vivo
- Rastreamento em background
- Check-in
- Trajeto seguro
- Redis
- Kafka
- RabbitMQ
- Kubernetes
- Microserviços

Evitar infraestrutura prematura.

---

# 29. Filosofia de desenvolvimento

Preferir:

```text
simples
seguro
testado
documentado
incremental
```

em vez de:

```text
grande
prematuro
frágil
superdimensionado
```

Cada fase deve deixar o repositório saudável para a próxima.

---

# 30. Estado atual

```text
Projeto: SafeCircle
Idioma inicial: Português do Brasil (pt-BR)
Fase: Phase 0 — Fundação
Visibilidade: Público
Licença: Ainda não definida
Produção: Não está pronto para produção
```

Próximo objetivo:

> Concluir a Phase 0 — Fundação sem antecipar funcionalidades das próximas fases.
