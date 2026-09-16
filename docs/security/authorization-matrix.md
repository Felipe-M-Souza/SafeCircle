# Matriz de autorização — SafeCircle API

Quem pode executar cada ação (Phase 11). A matriz **reflete o código real** e é
verificada pela suíte `apps/api/tests/security/authorization-matrix.test.ts`;
um endpoint novo entra aqui e lá na mesma mudança.

## Convenções

| Símbolo | Significado                                                                           |
| ------- | ------------------------------------------------------------------------------------- |
| ✅      | Permitido                                                                             |
| 403     | Autenticado e a existência do recurso já é legitimamente conhecida, mas sem permissão |
| 404     | **Anti-IDOR**: não-membro/não-dono recebe resposta idêntica à de recurso inexistente  |
| 401     | Sem autenticação válida (token ausente, inválido, expirado, sessão revogada)          |
| —       | Não se aplica (o ator não tem como chegar ali)                                        |

Atores:

- **anon** — sem autenticação
- **owner** — OWNER do grupo (ou criador/dono do recurso, onde indicado)
- **admin** — ADMIN do grupo
- **member** — MEMBER do grupo
- **creator** — criador do recurso (alerta, check-in, trajeto, sessão de localização); é sempre também membro
- **external** — autenticado, sem membership no grupo (inclui ex-membro)
- **system** — worker da outbox / schedulers (sem requisição HTTP)

Regra geral: **deny by default**. Tudo que não está marcado ✅ é negado.

## Autenticação e conta

| Ação                              | anon | próprio usuário        | outro usuário | Observação                                                                                                |
| --------------------------------- | ---- | ---------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`             | ✅   | —                      | —             | Rate limit 10/min/IP; senha 12–128                                                                        |
| `POST /auth/login`                | ✅   | —                      | —             | Rate limit por IP + freio por conta; resposta genérica                                                    |
| `POST /auth/refresh`              | ✅*  | —                      | —             | *Autentica pelo refresh token; rotação; reuso revoga a sessão                                             |
| `POST /auth/logout`               | ✅*  | —                      | —             | *Idempotente; revoga a sessão do refresh apresentado                                                      |
| `GET /me`                         | 401  | ✅                     | —             |                                                                                                           |
| `GET /me/sessions`                | 401  | ✅ (só as suas)        | —             | Nunca hash, IP ou User-Agent                                                                              |
| `DELETE /me/sessions/:sessionId`  | 401  | ✅ (inclusive a atual) | 404           | Sessão alheia ou inexistente: mesma resposta                                                              |
| `POST /me/sessions/revoke-others` | 401  | ✅                     | —             | Mantém a atual                                                                                            |
| `GET /me/privacy/export`          | 401  | ✅                     | —             | Só dados próprios; rate limit 5/h/IP; audita `PRIVACY_EXPORT_REQUESTED`                                   |
| `GET /me/account-deletion`        | 401  | ✅                     | —             | Phase 12: bloqueios e impacto da exclusão da própria conta                                                |
| `POST /me/delete-account`         | 401  | ✅ (com a senha atual) | —             | Phase 12: 409 se OWNER de grupo com outros membros ou recurso ativo; rate limit do login; freio por conta |

## Grupos

| Ação                                                  | anon | owner | admin | member | external                          |
| ----------------------------------------------------- | ---- | ----- | ----- | ------ | --------------------------------- |
| `POST /groups`                                        | 401  | ✅    | ✅    | ✅     | ✅ (vira OWNER do novo)           |
| `GET /groups` (meus grupos)                           | 401  | ✅    | ✅    | ✅     | ✅ (lista vazia do que não é seu) |
| `GET /groups/:groupId`                                | 401  | ✅    | ✅    | ✅     | 404                               |
| `PATCH /groups/:groupId` (renomear)                   | 401  | ✅    | ✅    | 403    | 404                               |
| `GET /groups/:groupId/members`                        | 401  | ✅    | ✅    | ✅     | 404                               |
| `DELETE /groups/:groupId/members/me` (sair)           | 401  | 403¹  | ✅    | ✅     | 404                               |
| `DELETE /groups/:groupId/members/:userId`             | 401  | ✅²   | ✅³   | 403    | 404                               |
| `PATCH /groups/:groupId/members/:userId/role`         | 401  | ✅⁴   | 403   | 403    | 404                               |
| `POST /groups/:groupId/transfer-ownership` (Phase 12) | 401  | ✅⁵   | 403   | 403    | 404                               |

¹ `OWNER_CANNOT_LEAVE_GROUP` — não há transferência de ownership.
² OWNER não pode remover a si mesmo (`CANNOT_REMOVE_OWNER`).
³ ADMIN remove apenas MEMBER; ADMIN/OWNER → 403.
⁴ Só entre ADMIN e MEMBER; o papel do OWNER não muda.
⁵ Só o OWNER, para outro membro do grupo (não para si mesmo). O alvo vira
OWNER e o antigo dono vira ADMIN — é o caminho para excluir a própria conta sem
desfazer o grupo (Phase 12).

## Convites

| Ação                                                | anon | owner | admin | member | external | convidado (destinatário) |
| --------------------------------------------------- | ---- | ----- | ----- | ------ | -------- | ------------------------ |
| `POST /groups/:groupId/invitations`                 | 401  | ✅    | ✅    | 403    | 404      | —                        |
| `GET /groups/:groupId/invitations`                  | 401  | ✅    | ✅    | 403    | 404      | —                        |
| `DELETE /groups/:groupId/invitations/:invitationId` | 401  | ✅    | ✅    | 403    | 404      | —                        |
| `GET /me/group-invitations`                         | 401  | —     | —     | —      | —        | ✅ (só os seus)          |
| `POST /me/group-invitations/:invitationId/accept`   | 401  | —     | —     | —      | 403/404⁵ | ✅                       |
| `POST /me/group-invitations/:invitationId/reject`   | 401  | —     | —     | —      | 403/404⁵ | ✅                       |

⁵ Convite cujo e-mail não é o do usuário autenticado: `INVITATION_NOT_FOR_USER`
(403) quando o id existe, `INVITATION_NOT_FOUND` (404) quando não. A suíte
aceita ambos; a invariante é: o status permanece `PENDING`.

## Alertas (SOS)

| Ação                                    | anon | creator | admin | member | external            |
| --------------------------------------- | ---- | ------- | ----- | ------ | ------------------- |
| `POST /alerts`                          | 401  | ✅      | ✅    | ✅     | 404 (grupo)         |
| `GET /alerts` (meus grupos)             | 401  | ✅      | ✅    | ✅     | ✅ (só o que é seu) |
| `GET /alerts/:alertId`                  | 401  | ✅      | ✅    | ✅     | 404                 |
| `POST /alerts/:alertId/resolve`         | 401  | ✅      | 403   | 403    | 404                 |
| `POST /alerts/:alertId/cancel`          | 401  | ✅      | 403   | 403    | 404                 |
| `GET /alerts/:alertId/acknowledgements` | 401  | ✅      | ✅    | ✅     | 404                 |
| `PUT /alerts/:alertId/acknowledgement`  | 401  | ✅      | ✅    | ✅     | 404                 |

Só quem criou o alerta o encerra. Papel no grupo **não** dá poder sobre o SOS
de outra pessoa: um ADMIN não cancela o pedido de ajuda de um membro.

## Localização ao vivo do alerta

| Ação                                          | anon | creator | admin | member | external |
| --------------------------------------------- | ---- | ------- | ----- | ------ | -------- |
| `POST /alerts/:alertId/live-location/start`   | 401  | ✅      | 403   | 403    | 404      |
| `POST /alerts/:alertId/live-location` (ponto) | 401  | ✅      | 403   | 403    | 404      |
| `POST /alerts/:alertId/live-location/stop`    | 401  | ✅      | 403   | 403    | 404      |
| `GET /alerts/:alertId/live-location`          | 401  | ✅      | ✅    | ✅     | 404      |
| `GET /alerts/:alertId/live-location/history`  | 401  | ✅      | ✅    | ✅     | 404      |

**Creator-only write, member-only read.** Coordenadas nunca saem por push,
realtime, outbox, auditoria, log ou métrica — só por estes GETs, para membros.

## Check-ins

| Ação                               | anon | creator | admin | member | external        |
| ---------------------------------- | ---- | ------- | ----- | ------ | --------------- |
| `POST /checkins`                   | 401  | ✅      | ✅    | ✅     | 404 (grupo)     |
| `GET /checkins` (meus)             | 401  | ✅      | ✅    | ✅     | ✅ (só os seus) |
| `GET /checkins/:checkinId`         | 401  | ✅      | ✅    | ✅     | 404             |
| `POST /checkins/:checkinId/safe`   | 401  | ✅      | 403   | 403    | 404             |
| `POST /checkins/:checkinId/cancel` | 401  | ✅      | 403   | 403    | 404             |
| `GET /groups/:groupId/checkins`    | 401  | ✅      | ✅    | ✅     | 404             |

Vencimento (`OVERDUE`) é do **system** (scheduler), nunca de um usuário.

## Trajetos

| Ação                                              | anon | creator | admin | member | external        |
| ------------------------------------------------- | ---- | ------- | ----- | ------ | --------------- |
| `POST /journeys`                                  | 401  | ✅      | ✅    | ✅     | 404 (grupo)     |
| `GET /journeys` (meus)                            | 401  | ✅      | ✅    | ✅     | ✅ (só os seus) |
| `GET /journeys/:journeyId`                        | 401  | ✅      | ✅    | ✅     | 404             |
| `POST /journeys/:journeyId/arrive`                | 401  | ✅      | 403   | 403    | 404             |
| `POST /journeys/:journeyId/cancel`                | 401  | ✅      | 403   | 403    | 404             |
| `GET /groups/:groupId/journeys`                   | 401  | ✅      | ✅    | ✅     | 404             |
| `POST /journeys/:journeyId/live-location/start`   | 401  | ✅⁶     | 403   | 403    | 404             |
| `POST /journeys/:journeyId/live-location` (ponto) | 401  | ✅⁶     | 403   | 403    | 404             |
| `POST /journeys/:journeyId/live-location/stop`    | 401  | ✅      | 403   | 403    | 404             |
| `GET /journeys/:journeyId/live-location`          | 401  | ✅      | ✅    | ✅     | 404             |
| `GET /journeys/:journeyId/live-location/history`  | 401  | ✅      | ✅    | ✅     | 404             |

⁶ Exige `liveLocationEnabled` (opt-in) e trajeto ACTIVE/OVERDUE; caso
contrário 409 — a existência já é conhecida pelo dono.

## Push devices

| Ação                                | anon | próprio usuário | outro usuário |
| ----------------------------------- | ---- | --------------- | ------------- |
| `POST /me/push-devices`             | 401  | ✅              | —             |
| `DELETE /me/push-devices/:deviceId` | 401  | ✅              | 404           |

O token nunca aparece em resposta. Token já registrado por outra conta passa a
pertencer a quem está autenticado agora (troca de conta no mesmo aparelho).

## Realtime

| Ação                        | anon | usuário autenticado | Observação                                                                       |
| --------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------- |
| `GET /realtime` (upgrade)   | 401  | ✅                  | `Origin` fora da allow-list → 403 antes da autenticação; rate limit de handshake |
| Receber eventos de um grupo | —    | ✅ só membros       | Destinatários resolvidos na entrega; ex-membro deixa de receber                  |
| Enviar comando pelo socket  | —    | ignorado            | Server-push only; frame > 1 KiB fecha a conexão                                  |

## Operação

| Ação                   | anon                               | usuário autenticado | operador (acesso ao servidor)  |
| ---------------------- | ---------------------------------- | ------------------- | ------------------------------ |
| `GET /health`          | ✅                                 | ✅                  | ✅                             |
| `GET /ready`           | ✅                                 | ✅                  | ✅                             |
| `GET /metrics`         | 404 (desligado) / 401 (sem Bearer) | idem                | ✅ com `METRICS_TOKEN`         |
| `pnpm outbox:*`        | —                                  | —                   | ✅ (CLI, sem equivalente HTTP) |
| `pnpm privacy:cleanup` | —                                  | —                   | ✅ (CLI)                       |
| `pnpm *:cleanup`       | —                                  | —                   | ✅ (CLI)                       |

Nenhuma dessas operações existe via HTTP: reprocessar outbox ou apagar dados é
ação de plantão com acesso ao servidor.

## O que o **system** faz sozinho

| Ação                                                        | Gatilho                               |
| ----------------------------------------------------------- | ------------------------------------- |
| Marcar check-in/trajeto `OVERDUE`                           | Scheduler (15 s)                      |
| Enviar push, publicar realtime, gravar audit                | Worker da outbox                      |
| Encerrar sessão de localização ao encerrar o alerta/trajeto | Transição do domínio                  |
| Revogar sessão excedente (limite de 10)                     | Login/registro do próprio usuário     |
| Revogar sessão por reuso de refresh                         | `POST /auth/refresh` com token antigo |

## Como manter

1. Endpoint novo → linha nesta matriz **e** entrada em `ENDPOINTS` na suíte.
2. Regra nova de papel → coluna/nota aqui e caso na suíte BFLA.
3. A suíte roda em todo PR; a matriz é revisada em cada fase.
