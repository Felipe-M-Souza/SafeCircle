# E2E mobile — Maestro

Flows black-box do app (Phase 12), executados com [Maestro](https://maestro.mobile.dev)
sobre um **development build** (não Expo Go — push e permissões exigem build
nativa) apontando para uma API E2E local.

## Pré-requisitos

1. PostgreSQL local e API E2E rodando:

```bash
pnpm e2e:reset && pnpm e2e:seed
NODE_ENV=development RATE_LIMIT_PROFILE=relaxed PUSH_PROVIDER=noop \
SCHEDULER_POLL_INTERVAL_MS=1000 OUTBOX_POLL_INTERVAL_MS=100 \
DATABASE_URL=postgres://.../safecircle_e2e pnpm dev:api
```

2. Development build instalado no emulador/aparelho com
   `EXPO_PUBLIC_API_URL` apontando para a API acima (no Android emulator,
   `http://10.0.2.2:3000`; em aparelho físico, o IP da máquina na rede local).
3. Maestro instalado (`curl -Ls https://get.maestro.mobile.dev | bash`).

## Executar

```bash
pnpm e2e:mobile            # todos os flows em apps/mobile/e2e
maestro test e2e/auth.yaml # um flow
```

## Contas do seed

| Pessoa | E-mail                      | Papel no grupo "Família E2E" |
| ------ | --------------------------- | ---------------------------- |
| Ana    | `ana.e2e@safecircle.test`   | OWNER                        |
| Bruno  | `bruno.e2e@safecircle.test` | MEMBER                       |

Senha de ambos: `senha-e2e-segura-123` (dado de teste, domínio reservado).
Flows que criam contas usam e-mails únicos gerados na hora, no mesmo domínio.

## Flows

| Arquivo                 | Cobre                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| `auth.yaml`             | registro, logout, login, logout                                          |
| `groups.yaml`           | Ana cria grupo e convida Bruno; Bruno aceita e aparece como membro       |
| `sos-smoke.yaml`        | Ana aciona o SOS (segurar), vê o alerta, encerra                         |
| `account-deletion.yaml` | conta nova sem bloqueios: consequências → senha → confirmação → login público |

## Estado desta entrega

Os flows foram escritos com base nos textos e `testID`s reais do app, mas
**não foram executados** neste ambiente (sem emulador/aparelho e sem Maestro
instalado). Estão registrados como `NOT EXECUTED` em
`docs/release/test-report.md`. A automação da API (`pnpm e2e:api`) cobre os
mesmos fluxos no nível HTTP/WebSocket e roda no CI.

## Princípios

- Só `testID` onde o texto não é estável (botões com estado de carregamento).
- Nenhum dado real: e-mails `*.e2e@safecircle.test`, sem coordenadas pessoais.
- Cada flow cria ou recebe estado conhecido; a ordem entre flows não importa.
