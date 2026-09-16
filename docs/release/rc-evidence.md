# Evidências do RC — SafeCircle 0.1.0-rc.1

Provenance e resultados verificáveis do candidato a release (Phase 12). Tudo
abaixo foi executado; o que não foi está em `test-report.md` como
`NOT EXECUTED` com o motivo. Nenhum número foi preenchido por dedução.

**Classificação: RC PREPARED — DEVICE VALIDATION PENDING.**

## Provenance

| Item                          | Valor                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Versão dos pacotes            | `0.1.0-rc.1` (raiz, `apps/api`, `apps/mobile`)                                                                                       |
| Versão do app (`app.json`)    | `0.1.0`; identidade `com.safecircle.app`                                                                                             |
| `versionCode` / `buildNumber` | Nenhum gerado — nenhuma build EAS foi executada (sem credenciais)                                                                    |
| Branch                        | `feature/e2e-release-candidate` sobre `main` em `9d94b0c`                                                                            |
| Pull request                  | https://github.com/Felipe-M-Souza/SafeCircle/pull/20                                                                                 |
| Último commit de código       | `55dccc8` (fix do shutdown realtime). Commits de código: `17c5cc1`, `816030c`, `2bd1fdb`, `3e11f33`, `f7ae591`, `e8d983b`, `55dccc8` |
| Commits de documentação       | `c5455f8` e o commit que adiciona este arquivo (ver histórico do PR)                                                                 |
| Migrations                    | `0000`–`0010` (11 arquivos); nenhuma nova na Phase 12                                                                                |
| Tag de release                | Nenhuma criada                                                                                                                       |
| Build profiles                | `eas.json`: development, preview, production (URLs de preview/produção são placeholders `.invalid`)                                  |
| Ambiente local                | Windows 10, Node 22.15.1, pnpm 10.33.3, PostgreSQL 17 (cluster descartável, porta 5434)                                              |
| Ambiente CI                   | `ubuntu-latest`, PostgreSQL 16 em container                                                                                          |

## Execuções do CI no PR (todas, inclusive as que falharam)

| Execução                                                                                    | Commit    | Resultado | Observação                                                                                                                           |
| ------------------------------------------------------------------------------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [CI 35041841526](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35041841526)     | `c5455f8` | FALHOU    | Teste de auditoria da exclusão dependia da ordem de `created_at` entre dois eventos do mesmo lote; corrigido em `e8d983b`            |
| [CodeQL 35041841535](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35041841535) | `c5455f8` | PASSOU    |                                                                                                                                      |
| [CI 35055020314](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35055020314)     | `e8d983b` | FALHOU    | E2E de recuperação no Linux recebeu fechamento WS 1005: defeito real no shutdown (plugin fechava sem status); corrigido em `55dccc8` |
| [CodeQL 35055020313](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35055020313) | `e8d983b` | PASSOU    |                                                                                                                                      |
| [CI 35055568625](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35055568625)     | `55dccc8` | PASSOU    | Validação completa, E2E da API e bloqueadores                                                                                        |
| [CodeQL 35055568560](https://github.com/Felipe-M-Souza/SafeCircle/actions/runs/35055568560) | `55dccc8` | PASSOU    |                                                                                                                                      |

## Suítes automatizadas (CI 35055568625, commit `55dccc8`)

| Suíte                          | Resultado                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| API — integração (Vitest)      | 39 arquivos, 503 testes, todos passaram                                                                                       |
| Mobile — Jest/RNTL             | 35 suítes, 195 testes, todos passaram                                                                                         |
| E2E API (`pnpm e2e:api`)       | 8 arquivos, 21 cenários, todos passaram                                                                                       |
| Lint, format, typecheck, build | PASS                                                                                                                          |
| `pnpm release:blockers`        | PASS — 15 itens: BLOCKER/RESOLVED 2, HIGH/RESOLVED 1, HIGH/ACCEPTED 2, MEDIUM/ACCEPTED 6, LOW/ACCEPTED 4; BLOCKER em aberto 0 |
| CodeQL                         | PASS                                                                                                                          |

Duração dos arquivos E2E no CI: auth 332 ms, groups 223 ms, sos 490 ms,
checkin 844 ms, journey 1.332 ms, privacy 574 ms, outbox-recovery 3.211 ms,
observability 141 ms.

## Ensaios executados localmente (dados sintéticos)

| Ensaio                                                     | Resultado                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm release:check` completo                              | exit 0                                                                                                                                                        |
| Smoke (`pnpm smoke:api`) contra API real                   | 9 etapas, 402 ms                                                                                                                                              |
| Migrations do zero / reexecução / sobre dataset restaurado | 3.975 ms / 2.214 ms / 2.404 ms (no-op)                                                                                                                        |
| Backup/restore (`pg_dump -Fc` / `pg_restore`)              | 292 ms / 521 ms; contagens idênticas: users 24, groups 11, alerts 4, outbox 2.025, audit 900, sessions 27                                                     |
| Queda do banco com API viva                                | `/ready` 503, `/health` 200; após religar, `/ready` 200 em 1 s; 3 eventos da outbox PROCESSED                                                                 |
| Carga moderada (30 VUs, 20 s)                              | 10.825 req, 520 req/s, 0 erros; p95 GET /alerts 56,6 ms, GET /groups 78,6 ms, GET /me/sessions 54,6 ms, POST /alerts 198 ms, login 436 ms; RSS 165→307→206 MB |
| Retenção (`pnpm privacy:cleanup`)                          | 6 etapas, exit 0                                                                                                                                              |
| Graceful shutdown (SIGTERM)                                | Não observável no Windows; verificado no CI Linux (E2E: socket 1001/`SERVER_SHUTDOWN`, logs `shutdown_started`/`shutdown_completed`)                          |
| Auditoria de dependências (`pnpm security:audit`)          | 0 high/critical; 2 moderate com waiver documentado                                                                                                            |

## NOT EXECUTED

Validação em aparelho físico/emulador (push real, permissões, GPS,
foreground/background, offline no app, deep links, ciclos, bateria, timezone,
acessibilidade), builds EAS e inspeção do bundle, E2E mobile com Maestro e
carga com k6. Motivos e plano em `test-report.md` e
`manual-device-test-plan.md`. Estes itens são a razão da classificação
**RC PREPARED — DEVICE VALIDATION PENDING** e não têm bloqueador em aberto na
bug bar (`release-blockers.md`: RB-005 HIGH/ACCEPTED, requer ação do
proprietário).
