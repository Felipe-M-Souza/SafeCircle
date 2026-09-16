# Relatório de testes — SafeCircle 0.1.0-rc.1

O que foi executado, onde, com que resultado e qual evidência (Phase 12 §100).
Itens não executados estão marcados `NOT EXECUTED` com o motivo. Nenhum
resultado abaixo foi preenchido por dedução.

Ambiente de execução: Windows 10 (desenvolvimento), Node 22, PostgreSQL 17
local (cluster descartável, porta 5434), pnpm 10. CI: `ubuntu-latest`,
PostgreSQL 16 em container. Data: 2026-09-16.

## Suítes automatizadas

| Suíte                                                                 | Ambiente                          | Resultado                                                            | Evidência                      |
| --------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| API — integração (`pnpm --filter api test`)                           | local + CI                        | PASS — 39 arquivos, 503 testes                                       | saída do Vitest; CI da branch  |
| API — segurança (`tests/security/`, Phase 11)                         | local + CI                        | PASS — 151 testes (parte dos 503)                                    | idem                           |
| API — exclusão de conta (`tests/account-deletion.test.ts`)            | local + CI                        | PASS — 17 testes                                                     | idem                           |
| API — transferência de propriedade (`tests/groups-ownership.test.ts`) | local + CI                        | PASS — 5 testes                                                      | idem                           |
| API — shutdown realtime (`tests/realtime-shutdown.test.ts`)           | local + CI                        | PASS — 1 teste: `app.close()` fecha sockets com 1001/SERVER_SHUTDOWN | idem                           |
| Mobile — Jest/RNTL (`pnpm --filter mobile test`)                      | local + CI                        | PASS — 35 suítes, 195 testes                                         | idem                           |
| E2E API (`pnpm e2e:api`, processo real + banco descartável)           | local + CI                        | PASS — 8 arquivos, 21 cenários                                       | saída do Vitest E2E; CI        |
| Smoke API (`pnpm smoke:api`)                                          | local, API real em 127.0.0.1:3460 | PASS — 9 etapas em 402 ms                                            | saída do comando (rc-evidence) |
| Lint, format, typecheck, build                                        | local + CI                        | PASS                                                                 | `pnpm release:check`; CI       |
| `pnpm security:audit`                                                 | local + CI                        | PASS — 0 high/critical, 2 moderate com waiver                        | `vulnerability-waivers.md`     |
| CodeQL                                                                | CI (PR)                           | ver `rc-evidence.md`                                                 | Aba Security                   |
| `pnpm release:blockers`                                               | local + CI                        | PASS — BLOCKER 0, HIGH sem decisão 0                                 | `release-blockers.md`          |

## Cenários E2E da API (21)

| Arquivo                  | Cenários                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.e2e.ts`            | registro→login→restauração→logout→login; revogar sessão derruba API e WS da outra sessão; reuso de refresh revoga sessão e fecha socket                                                                                 |
| `groups.e2e.ts`          | criar→convidar→aceitar→MEMBER→promover ADMIN→transferir propriedade; anti-IDOR de grupo                                                                                                                                 |
| `sos.e2e.ts`             | SOS ponta a ponta com dois "aparelhos", outbox (push noop + realtime + audit), ack, resolve; retry idempotente; externo 404                                                                                             |
| `checkin.e2e.ts`         | criar→ver→SAFE; vencimento acelerado pelo scheduler real (1 s) com realtime e push; retry idempotente                                                                                                                   |
| `journey.e2e.ts`         | criar→localização ao vivo (ponto sintético)→ARRIVED; atraso acelerado; atraso não vira SOS                                                                                                                              |
| `privacy.e2e.ts`         | exportação (sem segredos/terceiros); exclusão bloqueada por propriedade e desbloqueada por transferência; exclusão completa (reauth, socket 4403, login falha, dados removidos, auditoria anonimizada, outbox sem DEAD) |
| `outbox-recovery.e2e.ts` | worker desligado → backlog → restart da API com worker → entrega; WS reconecta e REST ressincroniza; dead-letter sintética (PAYLOAD_INVALID) com métricas                                                               |
| `observability.e2e.ts`   | /health, /ready sem topologia, X-Request-Id preservado/forjado, 404 uniforme, /metrics com famílias e sem ids; schedulers reais rodando                                                                                 |

## Ensaios operacionais executados (local, dados sintéticos)

| Ensaio                                                   | Resultado               | Números medidos                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations do zero (`0000`–`0010`)                       | PASS                    | 3.975 ms incluindo startup do tsx; 11 registros; 19 tabelas                                                                                                                                                                                                                                     |
| Reexecução idempotente das migrations                    | PASS                    | 2.214 ms, sem alterações                                                                                                                                                                                                                                                                        |
| Migration sobre dataset sintético restaurado             | PASS                    | 2.404 ms (no-op)                                                                                                                                                                                                                                                                                |
| Backup/restore (`pg_dump -Fc` / `pg_restore`)            | PASS                    | dump 320 KB em 292 ms; restore em 521 ms; contagens idênticas (users 24, groups 11, alerts 4, outbox 2.025, audit 900, sessions 27)                                                                                                                                                             |
| Queda do banco com API viva                              | PASS                    | `/ready` → 503 `database: fail`; `/health` → 200; após religar, `/ready` 200 em 1 s; alerta novo teve os 3 eventos da outbox PROCESSED                                                                                                                                                          |
| Restart da API com backlog na outbox                     | PASS (E2E)              | ver `outbox-recovery.e2e.ts`                                                                                                                                                                                                                                                                    |
| Retenção (`pnpm privacy:cleanup`)                        | PASS                    | 6 etapas, exit 0; teste de integração prova que ACTIVE é preservado                                                                                                                                                                                                                             |
| Carga moderada (`tests/load/api-load.mjs`, 30 VUs, 20 s) | PASS                    | 10.825 req em 20,8 s (520 req/s), 0 erros; p95: GET /alerts 56,6 ms, GET /groups 78,6 ms, GET /me/sessions 54,6 ms, POST /alerts 198 ms, login 436 ms (Argon2); séries de métricas 442→500 (rotas/status novos, não usuários); RSS 165→307 MB sob carga, 206 MB em repouso depois; `/ready` 200 |
| Graceful shutdown (SIGTERM)                              | PASS (E2E no CI, Linux) | socket 1001/`SERVER_SHUTDOWN`; logs `shutdown_started`/`shutdown_completed`; execução CI 35055568625                                                                                                                                                                                            |
| Exclusão de conta concorrente                            | PASS (integração)       | uma 204, outra 401; um único evento COMPLETED                                                                                                                                                                                                                                                   |

Graceful shutdown: no Windows o `kill` do processo não entrega SIGTERM (o
processo morre abrupto, socket 1006), então o caminho limpo não é observável
localmente. **No CI (Linux) o E2E de recuperação da outbox exige o caminho
limpo**: SIGTERM → socket fechado com 1001/`SERVER_SHUTDOWN` e logs
`shutdown_started`/`shutdown_completed` — verificado na execução CI
35055568625 (commit 55dccc8). Essa exigência encontrou um defeito real: o
`preClose` padrão do `@fastify/websocket` fechava os clientes sem status (1005)
antes do hub; corrigido com um hook `preClose` próprio registrado antes do
plugin (teste de integração `tests/realtime-shutdown.test.ts`).

## NOT EXECUTED — e por quê

| Item                                                          | Motivo                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| E2E mobile (Maestro, `apps/mobile/e2e/*.yaml`)                | Sem emulador/aparelho e sem Maestro no ambiente. Flows escritos com textos e `testID`s reais; não executados |
| Push real (Android/iOS)                                       | Sem aparelho físico e sem `EXPO_ACCESS_TOKEN`/credenciais                                                    |
| Permissões (notificações, localização) em aparelho            | Sem aparelho                                                                                                 |
| GPS (disponível/desligado/precisão/stale/stop)                | Sem aparelho                                                                                                 |
| Foreground/background, tela bloqueada, ciclos repetidos       | Sem aparelho                                                                                                 |
| Offline/reconexão no app                                      | Sem aparelho (a parte de API — retry idempotente, reconexão de WS após restart — está no E2E)                |
| Deep links em aparelho                                        | Sem aparelho                                                                                                 |
| Builds EAS (Android APK/AAB, iOS)                             | Sem credenciais EAS/Apple/Google — requer ação do proprietário                                               |
| Inspeção de bundle gerado                                     | Depende da build EAS; a inspeção estática do código mostra que o app lê apenas `EXPO_PUBLIC_*`               |
| Acessibilidade, font scaling, timezone/clock skew em aparelho | Sem aparelho                                                                                                 |
| Bateria/memória em sessão prolongada no aparelho              | Sem aparelho                                                                                                 |
| Carga com k6                                                  | k6 não instalado; script em `tests/load/k6-api-load.js`; a carga foi medida com `api-load.mjs`               |

## Conclusão

Automação e ensaios de servidor: **verdes e executados**. Validação de
plataforma: **pendente por ausência de aparelho e credenciais**. Classificação:
**RC PREPARED — DEVICE VALIDATION PENDING**.
