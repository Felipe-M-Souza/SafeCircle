# Inventário de dados pessoais — SafeCircle

O que guardamos, onde, para quê, quem lê, por quanto tempo e quão sensível é
(Phase 11). Para cada campo sensível a regra do projeto exige saber por que
existe, quem lê, quem altera, quanto tempo fica e se aparece em logs,
analytics ou notificações — este documento é essa resposta.

Legenda de sensibilidade: **crítica** (segredo ou localização), **alta** (dado
pessoal identificável), **média** (dado de uso ligado a uma pessoa), **baixa**
(identificador técnico/operacional).

Regra transversal: **nenhuma** categoria abaixo vai para analytics (não há
analytics) nem para identificadores de publicidade (não existem). Logs só
carregam IDs e códigos; a lista de redaction está em
`apps/api/src/observability/request-context.ts`.

## Perfil

| Dado            | Tabela / coluna    | Finalidade                        | Quem acessa                                            | Retenção                 | Cleanup          | Sensibilidade | Compartilhamento externo |
| --------------- | ------------------ | --------------------------------- | ------------------------------------------------------ | ------------------------ | ---------------- | ------------- | ------------------------ |
| Nome            | `users.name`       | Identificar a pessoa para o grupo | Próprio usuário; membros dos mesmos grupos (listagens) | Enquanto a conta existir | — (ver exclusão) | alta          | Não                      |
| E-mail          | `users.email`      | Login; destinatário de convites   | Próprio usuário; **nunca** exibido a outros membros    | Enquanto a conta existir | —                | alta          | Não                      |
| Id do usuário   | `users.id` (UUID)  | Chave técnica                     | Toda a API (autorização); membros veem ids de membros  | Enquanto a conta existir | —                | baixa         | Não                      |
| Data de criação | `users.created_at` | Suporte                           | Próprio usuário                                        | Enquanto a conta existir | —                | baixa         | Não                      |

## Senha

| Dado          | Tabela / coluna       | Finalidade | Quem acessa                                                                         | Retenção                 | Cleanup | Sensibilidade | Compartilhamento externo |
| ------------- | --------------------- | ---------- | ----------------------------------------------------------------------------------- | ------------------------ | ------- | ------------- | ------------------------ |
| Hash Argon2id | `users.password_hash` | Autenticar | Só o serviço de auth (verificação). Nunca em resposta, log, export, outbox ou audit | Enquanto a conta existir | —       | crítica       | Não                      |

A senha em claro existe só em memória durante o request de login/registro e é
redigida do log (`password`, `req.body.password`).

## Sessões e refresh tokens

| Dado                  | Tabela / coluna                                                              | Finalidade                                     | Quem acessa                                         | Retenção                                             | Cleanup           | Sensibilidade | Compartilhamento externo |
| --------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | ----------------- | ------------- | ------------------------ |
| Hash do refresh token | `auth_sessions.refresh_token_hash`                                           | Renovar sessão                                 | Só o serviço de auth. Nunca em resposta/export      | Sessão ativa: até 30 d de validade; encerrada: +30 d | `privacy:cleanup` | crítica       | Não                      |
| Hashes rotacionados   | `auth_refresh_token_history.token_hash`                                      | Detectar reuso de refresh (roubo/replay)       | Só o serviço de auth                                | Até `expires_at` (30 d após a rotação)               | `privacy:cleanup` | crítica       | Não                      |
| Metadados da sessão   | `auth_sessions.created_at/last_used_at/expires_at/revoked_at/revoked_reason` | Listar e revogar sessões; investigar incidente | Próprio usuário (sanitizado) via `GET /me/sessions` | Idem sessão                                          | `privacy:cleanup` | média         | Não                      |
| Access token (JWT)    | **não persistido**                                                           | Autenticar cada chamada                        | Só em memória no app; header redigido no log        | 15 min                                               | —                 | crítica       | Não                      |

Não guardamos IP nem User-Agent das sessões (anti-fingerprinting).

## Grupos, memberships e convites

| Dado               | Tabela / coluna                        | Finalidade                               | Quem acessa                                         | Retenção                                                  | Cleanup | Sensibilidade | Compartilhamento externo |
| ------------------ | -------------------------------------- | ---------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- | ------- | ------------- | ------------------------ |
| Nome do grupo      | `trusted_groups.name`                  | Identificar o círculo                    | Membros                                             | Enquanto o grupo existir                                  | —       | média         | Não                      |
| Membership e papel | `group_memberships`                    | Autorização (a fronteira de privacidade) | Membros veem quem está no grupo e o papel           | Enquanto durar                                            | —       | alta          | Não                      |
| E-mail convidado   | `group_invitations.invited_email`      | Entregar o convite à conta certa         | OWNER/ADMIN do grupo (listagem) e o convidado       | Sem prazo definido — **pendência** (ver retention-policy) | —       | alta          | Não                      |
| Quem convidou      | `group_invitations.invited_by_user_id` | Contexto do convite                      | OWNER/ADMIN; **não** exposto ao convidado no export | Idem                                                      | —       | média         | Não                      |

## Alertas (SOS)

| Dado                            | Tabela / coluna                       | Finalidade                 | Quem acessa                        | Retenção                           | Cleanup                                | Sensibilidade | Compartilhamento externo                                                    |
| ------------------------------- | ------------------------------------- | -------------------------- | ---------------------------------- | ---------------------------------- | -------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| Alerta (status, tempos)         | `emergency_alerts`                    | O pedido de ajuda          | Membros do grupo                   | Sem prazo definido — **pendência** | —                                      | alta          | **Push**: só `type`, `alertId`, `groupId` (texto fixo; sem nome, sem local) |
| Localização inicial             | `alert_locations` (lat/long/accuracy) | Onde o alerta foi acionado | Membros do grupo; criador (export) | 30 d após o alerta encerrar        | `location:cleanup` / `privacy:cleanup` | crítica       | **Nunca** (nem push, nem realtime, nem outbox)                              |
| Confirmações (acknowledgements) | `alert_acknowledgements`              | "Vi", "estou indo"         | Membros do grupo                   | Junto com o alerta                 | —                                      | média         | Realtime: só tipo e ids                                                     |

## Localização ao vivo (alerta e trajeto)

| Dado                                     | Tabela / coluna                                        | Finalidade                              | Quem acessa                                                      | Retenção           | Cleanup                               | Sensibilidade | Compartilhamento externo |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------- | ------------- | ------------------------ |
| Sessão de compartilhamento               | `alert_location_sessions`, `journey_location_sessions` | Quando a pessoa compartilhou            | Membros; dono (export, sem pontos)                               | 30 d após encerrar | `location:cleanup`, `journey:cleanup` | alta          | Não                      |
| Pontos (lat/long/accuracy/heading/speed) | `alert_location_updates`, `journey_location_updates`   | Trajetória durante a emergência/trajeto | Membros do grupo, **só durante e até 30 d**; **nunca** no export | 30 d após encerrar | idem                                  | crítica       | **Nunca**                |

Coleta só com sessão de compartilhamento explícita e sinal visível do sistema
(notificação fixa no Android, indicador azul no iOS; ADR 0015), com throttling; a
coleta para quando a sessão termina.

## Check-ins e trajetos

| Dado                       | Tabela / coluna                   | Finalidade                          | Quem acessa                     | Retenção            | Cleanup           | Sensibilidade                        | Compartilhamento externo                          |
| -------------------------- | --------------------------------- | ----------------------------------- | ------------------------------- | ------------------- | ----------------- | ------------------------------------ | ------------------------------------------------- |
| Check-in (prazo, status)   | `safety_checkins`                 | Rotina de segurança                 | Membros do grupo                | 90 d após finalizar | `checkin:cleanup` | média                                | Push de vencimento: texto fixo + ids              |
| Trajeto (previsão, status) | `safe_journeys`                   | Deslocamento monitorado             | Membros do grupo                | 90 d após finalizar | `journey:cleanup` | média                                | Push de atraso: texto fixo + ids                  |
| Destino textual            | `safe_journeys.destination_label` | Contexto do trajeto ("casa da mãe") | Membros do grupo; dono (export) | Junto com o trajeto | idem              | **alta** (é endereço em texto livre) | **Nunca** em push, realtime, outbox, audit ou log |

## Push devices

| Dado             | Tabela / coluna          | Finalidade                    | Quem acessa                                                                           | Retenção                                                        | Cleanup | Sensibilidade             | Compartilhamento externo                          |
| ---------------- | ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- | ------------------------- | ------------------------------------------------- |
| Expo push token  | `push_devices.token`     | Entregar notificação          | Só o handler de push, **no momento do envio**. Nunca em resposta, log, outbox, export | Enquanto o registro existir (inativo permanece) — **pendência** | —       | **crítica (operacional)** | **Sim**: enviado à Expo Push API (é a finalidade) |
| Plataforma       | `push_devices.platform`  | Formato da notificação        | Próprio usuário (export)                                                              | Idem                                                            | —       | baixa                     | Expo                                              |
| Id de instalação | `push_devices.device_id` | Rotacionar token do mesmo app | Próprio usuário                                                                       | Idem                                                            | —       | baixa                     | Não                                               |

O id de instalação é um UUID aleatório gerado pelo app — não é IMEI, Android
ID, MAC nem identificador de publicidade. Requisito de produção: banco com
**encryption at rest** (o token é a chave de um aparelho).

## Trilha de auditoria

| Dado                                                                          | Tabela / coluna | Finalidade                       | Quem acessa                                       | Retenção | Cleanup                             | Sensibilidade | Compartilhamento externo |
| ----------------------------------------------------------------------------- | --------------- | -------------------------------- | ------------------------------------------------- | -------- | ----------------------------------- | ------------- | ------------------------ |
| Evento (tipo, ator, alvo, grupo, resultado, requestId, metadata allow-listed) | `audit_events`  | Segurança, investigação, suporte | Só operador com acesso ao banco (não há endpoint) | 180 d    | `audit:cleanup` / `privacy:cleanup` | média         | Não                      |

Sem IP, sem User-Agent, sem coordenada, sem token, sem e-mail. `actor_user_id`
é `SET NULL` se o usuário for apagado.

## Outbox

| Dado                                                            | Tabela / coluna | Finalidade                   | Quem acessa                    | Retenção                                         | Cleanup                              | Sensibilidade | Compartilhamento externo |
| --------------------------------------------------------------- | --------------- | ---------------------------- | ------------------------------ | ------------------------------------------------ | ------------------------------------ | ------------- | ------------------------ |
| Evento pendente (tipo, ids, payload só de ids/flags, requestId) | `outbox_events` | Entrega confiável de efeitos | Só o worker e a CLI (operador) | PROCESSED 30 d; DEAD 90 d; PENDING até processar | `outbox:cleanup` / `privacy:cleanup` | baixa         | Não                      |

## Dados que **não** coletamos

- IP e User-Agent persistidos (só aparecem no log da requisição, com o requestId, por 30 dias de log — política de logs é da infraestrutura).
- Contatos do aparelho, agenda, fotos.
- Identificadores de publicidade ou de hardware.
- Localização em segundo plano.
- Analytics de uso.

## Pendências registradas

- **Exclusão de conta**: implementada na Phase 12 (`POST /me/delete-account`,
  com senha). Apaga perfil, sessões, histórico de refresh, push devices,
  alertas/check-ins/trajetos próprios (com localização, sessões ao vivo e
  confirmações sobre eles), confirmações próprias, convites enviados e para o
  e-mail, memberships e grupos em que a pessoa era a única. Auditoria fica
  anonimizada (`actor_user_id` nulo). Bloqueada enquanto houver grupo próprio
  com outros membros (transferir a propriedade) ou alerta/check-in/trajeto em
  andamento. Decisão por entidade no ADR 0013 §3.
- Prazos ainda não definidos estão marcados como **pendência** acima e
  consolidados em `retention-policy.md`.
