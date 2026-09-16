# SafeCircle 0.1.0-rc.1 — release notes internas

Primeiro Release Candidate. Não é `1.0.0` e não foi publicado nas lojas.
Classificação: **RC PREPARED — DEVICE VALIDATION PENDING** (ver
`rc-evidence.md` e `release-blockers.md`).

## Funcionalidades (Phases 1–8)

- **Conta e sessões**: cadastro com e-mail e senha, login, restauração de
  sessão, logout; listar e revogar as próprias sessões ("sair dos outros
  aparelhos").
- **Grupos de confiança**: criar, renomear, convidar por e-mail, aceitar ou
  recusar convites, papéis OWNER/ADMIN/MEMBER, remover membros, sair;
  **transferir a propriedade** (novo nesta RC).
- **Alerta de emergência (SOS)**: acionamento por pressionar-e-segurar,
  idempotente; localização inicial opcional; confirmações do grupo ("vi",
  "estou indo"); encerrar ou cancelar (acionamento acidental).
- **Notificações push**: SOS, check-in vencido, trajeto atrasado; conteúdo
  fixo, sem nome ou localização.
- **Tempo real**: WebSocket autenticado com eventos de alerta, grupo,
  check-in, trajeto e localização (só ids).
- **Localização ao vivo**: durante alerta ou trajeto, opt-in, em primeiro
  plano; mapa para o grupo; encerra com o alerta/trajeto.
- **Check-in de segurança**: prazo de 5 min a 24 h; vencimento decidido pelo
  servidor; o grupo é avisado.
- **Trajeto seguro**: previsão de chegada, destino textual, atraso avisado ao
  grupo; localização ao vivo opcional. Atraso não vira SOS.

## Hardening e operação (Phases 9–12)

- Request ID e error ID em toda resposta; logs estruturados com redaction;
  `/health`, `/ready`, `/metrics` (protegido); trilha de auditoria.
- Outbox transacional: push, realtime e auditoria gravados na mesma transação
  do domínio e entregues por worker com retry, backoff e dead-letter. Entrega
  **at-least-once**.
- Segurança: senha mínima 12, Argon2id, freio por conta, rotação de refresh com
  detecção de reuso, validação de sessão por requisição, JWT em allow-list,
  produção fail-fast, CORS por allow-list, cabeçalhos de segurança, limite de
  corpo, WebSocket com validação de Origin e sessão, exportação dos próprios
  dados, retenção consolidada (`pnpm privacy:cleanup`), CI com menor privilégio,
  actions por SHA, auditoria de dependências, Dependabot e CodeQL.
- **Exclusão de conta** (novo nesta RC): fluxo em etapas no app, com senha;
  bloqueia enquanto houver grupo próprio com outros membros ou emergência em
  andamento; apaga o que é da pessoa, preserva o que é de terceiros, anonimiza
  a auditoria.
- E2E da API (21 cenários contra processo real), smoke (`pnpm smoke:api`),
  `pnpm release:check`, flows Maestro escritos, `eas.json` com três perfis.

## Decisão sobre localização em segundo plano

**Opção B — a v1 permanece foreground-only.** Não foi possível validar
background location em aparelhos físicos neste ambiente, e implementar pela
metade seria pior do que não implementar: a UI informa que a localização ao
vivo é atualizada enquanto o SafeCircle está aberto, as permissões de
background estão bloqueadas na configuração nativa e as declarações das lojas
dizem que não há coleta em segundo plano. Detalhes no ADR 0013 §5.

## Limitações

- Localização ao vivo só com o app aberto.
- Rate limiting e freio de login são por instância (réplicas multiplicam o teto).
- Push é at-least-once: pode chegar duplicado raramente.
- Coordenadas vêm do GPS do aparelho e não são verificadas (spoofing possível).
- Sem MFA, sem troca de senha, sem recuperação de conta.
- Exportação de dados só pela API (sem tela).
- Enumeração de contas possível pelo cadastro (409), limitada por rate limit.
- Worker da outbox roda no processo da API.

## Known issues

| ID        | Severidade | Descrição                                                                                                | Estado                |
| --------- | ---------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| KNOWN-001 | MEDIUM     | Rate limit por instância                                                                                 | ACCEPTED              |
| KNOWN-002 | MEDIUM     | Push at-least-once pode duplicar raramente                                                               | ACCEPTED              |
| KNOWN-003 | MEDIUM     | GPS pode ser spoofed                                                                                     | ACCEPTED              |
| KNOWN-004 | MEDIUM     | Localização ao vivo só em primeiro plano                                                                 | ACCEPTED (decisão v1) |
| KNOWN-005 | MEDIUM     | Sem troca/recuperação de senha                                                                           | ACCEPTED (Phase 13)   |
| KNOWN-006 | LOW        | Sem MFA                                                                                                  | ACCEPTED              |
| KNOWN-007 | LOW        | Enumeração via cadastro (409)                                                                            | ACCEPTED              |
| KNOWN-008 | LOW        | Exportação de dados sem tela no app                                                                      | ACCEPTED (Phase 13)   |
| KNOWN-009 | LOW        | Séries de métricas crescem com rotas/status novos (não com usuários) — 442→500 sob carga, estável depois | ACCEPTED              |

## Pendências para declarar `RC READY`

- Executar `manual-device-test-plan.md` em Android e iOS físicos (push,
  permissões, GPS, foreground/background, offline, deep links).
- Gerar builds EAS (`preview`) com credenciais do proprietário e registrar a
  provenance em `rc-evidence.md`.
- Percorrer `docs/security/repository-security.md` e o checklist de release.

## Fora desta RC (Phase 13)

Publicação nas lojas, política de privacidade final, troca/recuperação de
senha, tela de exportação, crash reporting (recomendado avaliar), domínio e
TLS definitivos, backups gerenciados, secrets manager.
