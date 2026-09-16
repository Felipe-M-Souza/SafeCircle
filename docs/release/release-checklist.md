# Checklist de release — SafeCircle

Percorrer para cada Release Candidate (Phase 12 §48). Complementa o checklist
de segurança (`docs/security/release-security-checklist.md`) — o item de
segurança correspondente está indicado como `RSC-n`. Marque com data e
responsável; item não verificado é item **não garantido**.

Release: 0.1.0-rc.1 · Commit: ver `rc-evidence.md` · Data: ____________ · Responsável: ____________

## Gates automáticos

| #   | Item                                                                                                          | Comando / evidência   | OK  |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------- | --- |
| 1   | `pnpm release:check` verde (lint, format, typecheck, testes, build, audit, db, migrations, blockers, E2E API) | `rc-evidence.md`      |     |
| 2   | CI da branch verde (validate + E2E API + blockers)                                                            | GitHub Actions        |     |
| 3   | CodeQL verde no PR                                                                                            | Aba Security          |     |
| 4   | `pnpm release:blockers`: BLOCKER = 0, HIGH sem decisão = 0                                                    | `release-blockers.md` |     |
| 5   | `pnpm smoke:api` verde contra o ambiente alvo                                                                 | saída do comando      |     |

## Migrations e banco

| #   | Item                                                                                   | OK  |
| --- | -------------------------------------------------------------------------------------- | --- |
| 6   | Migrations `0000`–`0010` aplicadas do zero em ambiente igual ao alvo (`RSC-28`)        |     |
| 7   | Ensaio de migração sobre cópia do banco do alvo (tempo aceitável, sem drop inesperado) |     |
| 8   | Todas as migrations desde a release anterior são aditivas (rollback de API viável)     |     |
| 9   | Backup completo **antes** do deploy; restauração testada (`RSC-26`)                    |     |
| 10  | Encryption at rest do PostgreSQL (`RSC-25`); acesso restrito (`RSC-27`)                |     |
| 11  | Cron de `pnpm privacy:cleanup` agendado (`RSC-29`)                                     |     |

## Segredos e configuração da API

| #   | Item                                                                                              | OK  |
| --- | ------------------------------------------------------------------------------------------------- | --- |
| 12  | `NODE_ENV=production`; startup fail-fast passou (`RSC-13`)                                        |     |
| 13  | `JWT_ACCESS_SECRET` forte e exclusivo (`RSC-4`)                                                   |     |
| 14  | `DATABASE_URL` com usuário de menor privilégio (`RSC-5`)                                          |     |
| 15  | `OUTBOX_ENABLED=true`; `PUSH_PROVIDER=expo` (produção recusa `noop`)                              |     |
| 16  | `EXPO_ACCESS_TOKEN` configurado (`RSC-7`)                                                         |     |
| 17  | `METRICS_ENABLED`/`METRICS_TOKEN` conforme política (`RSC-6`)                                     |     |
| 18  | `CORS_ALLOWED_ORIGINS` só com origens reais (`RSC-9`)                                             |     |
| 19  | `TRUST_PROXY` coerente com a topologia (`RSC-10`)                                                 |     |
| 20  | `HSTS_ENABLED=true` só com TLS garantido (`RSC-11`)                                               |     |
| 21  | `APP_VERSION`, `GIT_SHA`, `BUILD_DATE` preenchidos (aparecem no log de startup)                   |     |
| 22  | `RATE_LIMIT_PROFILE` e `SCHEDULER_POLL_INTERVAL_MS` **não** definidos em produção (padrões reais) |     |

## Rede

| #   | Item                                                            | OK  |
| --- | --------------------------------------------------------------- | --- |
| 23  | TLS no ingress; HTTP → HTTPS (`RSC-21`)                         |     |
| 24  | WSS para `/realtime` atravessa o proxy (`RSC-22`)               |     |
| 25  | Número de réplicas conhecido (limites por instância) (`RSC-24`) |     |

## Outbox, push e realtime

| #   | Item                                                                                                       | OK  |
| --- | ---------------------------------------------------------------------------------------------------------- | --- |
| 26  | `outbox_worker_started` no log; `pnpm outbox:status` sem backlog crescendo                                 |     |
| 27  | Dead-letter revisado (`pnpm outbox:list-dead`)                                                             |     |
| 28  | Push real validado em aparelho (SOS, check-in vencido, trajeto atrasado) — `manual-device-test-plan.md` §6 |     |
| 29  | Realtime: reconexão após restart da API validada (E2E automatizado + aparelho §7.4)                        |     |

## Mobile

| #   | Item                                                                                                                      | OK  |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --- |
| 30  | Build EAS do profile correto gerada; `EXPO_PUBLIC_API_URL` HTTPS de produção; `EXPO_PUBLIC_APP_ENV=production` (`RSC-33`) |     |
| 31  | Inspeção do bundle: sem segredos (`RSC-`, plano §12)                                                                      |     |
| 32  | `app.json`: identidade (`com.safecircle.app`), permissões mínimas, sem background location, cleartext off (`RSC-31`)      |     |
| 33  | Chave do Google Maps fora do repositório e restrita (`RSC-34`)                                                            |     |
| 34  | Provenance registrada: git SHA, versão, versionCode/buildNumber, profile, data (`rc-evidence.md`)                         |     |
| 35  | Android: matriz do plano manual executada (atual, anterior, físico)                                                       |     |
| 36  | iOS: matriz do plano manual executada (atual, iPhone físico)                                                              |     |

## Privacidade

| #   | Item                                                                                   | OK  |
| --- | -------------------------------------------------------------------------------------- | --- |
| 37  | Exclusão de conta validada em aparelho (plano §9); API coberta por testes              |     |
| 38  | Exportação de dados validada (E2E API)                                                 |     |
| 39  | `data-inventory.md`, `retention-policy.md` e disclosures refletem o código             |     |
| 40  | Política de privacidade publicada (Phase 13) e coerente com `privacy-policy-inputs.md` |     |
| 41  | Declarações das lojas preenchidas a partir de `store-disclosure-inputs.md`             |     |

## GitHub e supply chain

| #   | Item                                                                                               | OK  |
| --- | -------------------------------------------------------------------------------------------------- | --- |
| 42  | `docs/security/repository-security.md` percorrido (branch protection, secret scanning, Dependabot) |     |
| 43  | Actions fixadas por SHA; Dependabot sem PR de segurança pendente                                   |     |
| 44  | `pnpm security:audit` sem high/critical; waivers dentro da validade                                |     |

## Rollback

| #   | Item                                                                        | OK  |
| --- | --------------------------------------------------------------------------- | --- |
| 45  | `rollback-plan.md` lido pelo responsável do deploy                          |     |
| 46  | Commit anterior identificado e reimplantável                                |     |
| 47  | Compatibilidade app antigo × API nova confirmada (nenhum contrato removido) |     |

## Decisão

| Classificação                             | Condição                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `RC READY`                                | Todos os itens OK, incluindo aparelhos e credenciais                             |
| `RC PREPARED — DEVICE VALIDATION PENDING` | Gates automáticos OK; itens 28, 30–37 pendentes por falta de aparelho/credencial |
| `NOT RC READY`                            | Qualquer BLOCKER em aberto ou gate automático falhando                           |

Classificação desta entrega: **RC PREPARED — DEVICE VALIDATION PENDING**.
