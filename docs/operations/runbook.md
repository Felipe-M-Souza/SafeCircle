# Runbook operacional — SafeCircle API

Guia de plantão. Todos os comandos abaixo são seguros de executar e **nenhum
valor real de segredo aparece aqui**. Onde houver `<...>`, substitua pelo valor
do seu ambiente (nunca cole segredos em issues, tickets ou chats).

O SafeCircle é um app de segurança pessoal: uma indisponibilidade pode impedir
alguém de pedir ajuda. Priorize, nesta ordem: **SOS (alertas) > push > realtime

> check-in/trajeto > métricas/auditoria**.

---

## 1. Verificações rápidas

### Liveness — o processo está vivo?

```bash
curl -i http://<host>:<porta>/health
```

- `200 {"status":"ok"}` → o processo responde.
- Sem resposta / conexão recusada → o processo caiu ou não sobe. Ver §9.

`/health` **não** consulta o banco de propósito: uma oscilação do PostgreSQL não
deve fazer o orquestrador matar containers saudáveis.

### Readiness — esta instância pode receber tráfego?

```bash
curl -i http://<host>:<porta>/ready
```

- `200 {"status":"ok","checks":[...]}` → pronta.
- `503 {"status":"degraded","checks":[...]}` → **tirar do balanceador**. O array
  `checks` diz qual verificação falhou (`database` ou `startup`).

A resposta é intencionalmente pobre: não traz connection string, host nem
mensagem do driver. O detalhe está no log da instância.

---

## 2. Investigar um erro relatado por um usuário

O app mostra **Código de suporte** em falhas inesperadas. Esse código é o
`errorId` (ou, na falta dele, o `requestId`).

1. Peça o código ao usuário.
2. Procure no log:

```bash
grep '"errorId":"<codigo>"' /var/log/safecircle/api.log
grep '"requestId":"<codigo>"' /var/log/safecircle/api.log
```

Todo log de uma requisição carrega `requestId`, `method`, `route` (template) e,
quando autenticado, `userId`. O log de conclusão é o evento
`http_request_completed`, com `statusCode` e `durationMs`.

O cliente também pode propagar o seu próprio `X-Request-Id` (apenas UUID
válido; qualquer outro valor é substituído). A resposta sempre devolve
`X-Request-Id`.

**O que você NÃO vai encontrar no log, por decisão de projeto:** senha, hash,
access/refresh token, push token, coordenadas, corpo de requisições sensíveis.
Se algum desses aparecer, é um incidente de privacidade — ver §10.

---

## 3. Métricas

`/metrics` é **desabilitado por padrão**.

```bash
# Desabilitado (padrão): 404
curl -i http://<host>:<porta>/metrics

# Habilitado e protegido:
curl -i -H "Authorization: Bearer <METRICS_TOKEN>" http://<host>:<porta>/metrics
```

Configuração:

| Variável          | Efeito                                                           |
| ----------------- | ---------------------------------------------------------------- |
| `METRICS_ENABLED` | `false` (padrão): a rota não existe. `true`: rota registrada.    |
| `METRICS_TOKEN`   | Quando definido, exige `Authorization: Bearer`. Sem ele: aberto. |

Habilitar **sem** token só é aceitável quando a porta está em rede privada.
O token nunca aparece em log (o header `Authorization` é redigido).

Todas as métricas usam o prefixo `safecircle_`. Séries úteis no plantão:

| Métrica                                    | Para quê                               |
| ------------------------------------------ | -------------------------------------- |
| `safecircle_http_requests_total`           | Volume e taxa de erro (`status_class`) |
| `safecircle_http_request_duration_seconds` | Latência (p95)                         |
| `safecircle_realtime_connections`          | Conexões WebSocket abertas agora       |
| `safecircle_outbox_backlog`                | Efeitos esperando entrega (ver §7)     |
| `safecircle_outbox_backlog{status="dead"}` | Efeitos que desistimos de entregar     |
| `safecircle_background_tasks_pending`      | Fila em memória (residual; ver §6)     |
| `safecircle_push_failures_total`           | Falhas de push                         |
| `safecircle_scheduler_runs_total`          | Schedulers rodando                     |
| `safecircle_audit_failures_total`          | Auditoria falhando                     |
| `safecircle_auth_login_attempts_total`     | Logins por resultado (ver §15.3)       |
| `safecircle_refresh_reuse_detected_total`  | Reuso de refresh token (ver §15.2)     |
| `safecircle_security_rate_limited_total`   | Rate limit por grupo de rota           |

---

## 4. Falha de push

Sintoma: membros não recebem notificação de SOS, check-in vencido ou trajeto
atrasado.

1. Confira `safecircle_push_failures_total` e `safecircle_push_dispatch_total`
   (label `result`: `ok`, `partial`, `failed`).
2. Procure o evento no log:

```bash
grep '"event":"push_dispatch_failed"' /var/log/safecircle/api.log
```

3. Causas comuns:
   - **Provedor indisponível (Expo)**: `result="failed"` em lote. O alerta/
     check-in/trajeto **não** é revertido — o estado no banco está correto e o
     app mostra tudo ao abrir. Desde a Phase 10 o envio **é reagendado** pela
     outbox com backoff, até 8 tentativas ou 20 minutos. Ver §7.
   - **Token inválido**: `safecircle_push_invalid_tokens_total` sobe e o
     dispositivo é desativado automaticamente. Esperado quando alguém desinstala
     o app.
   - **Ninguém registrado**: `recipients: 0` no evento
     `push_dispatch_completed` — não é falha.

Push **nunca** deve tornar a API not-ready: uma falha de push não bloqueia SOS.

Sucesso parcial de um lote **não** gera reenvio: reenviar o lote inteiro por
causa de um token duplicaria a notificação de quem já recebeu.

---

## 5. Scheduler parado

Os schedulers de check-in (Phase 7) e trajeto (Phase 8) fazem polling a cada
15 s e marcam `OVERDUE` o que venceu.

Sintoma: check-ins/trajetos vencidos não mudam de estado e ninguém é avisado.

1. `safecircle_scheduler_runs_total{scheduler="checkins"|"journeys"}` deve subir
   continuamente. Sem incremento por mais de **2 intervalos** (~30 s), investigue.
2. Procure falhas:

```bash
grep '"event":"scheduler_item_effects_failed"' /var/log/safecircle/api.log
```

3. O estado vive no banco: **reiniciar a API recupera** os vencimentos pendentes
   na primeira execução. Nada se perde.
4. Desde a Phase 10 o scheduler apenas executa a transição de domínio; push e
   realtime do vencimento saem pela outbox, na mesma transação. Se o vencimento
   ocorreu e ninguém foi avisado, o problema está na entrega (§7), não aqui.
5. Limitação conhecida: o scheduler roda **dentro da API, em instância única**.
   Com várias réplicas cada uma faz polling, mas o `UPDATE` condicional garante
   que cada item vence uma vez só.

---

## 6. Tarefas em segundo plano acumulando

Desde a Phase 10 push, realtime e auditoria **não passam mais por aqui** — vão
para a outbox (§7). O runner em memória ficou para trabalho acessório, e
`safecircle_background_tasks_pending` deve oscilar perto de zero.

Crescimento contínuo indica tarefa acessória travando.

```bash
grep '"event":"background_task_failed"' /var/log/safecircle/api.log
```

As tarefas vivem **no processo**: se a API cair antes de concluí-las, não há
retry persistente. É exatamente por isso que os efeitos que importam saíram
daqui (ADR 0011). O encerramento limpo aguarda até 10 s pelas pendentes.

---

## 7. Outbox transacional

Desde a Phase 10, push, realtime e auditoria **não saem mais da requisição**:
são gravados na tabela `outbox_events` na mesma transação da mudança de domínio
e entregues depois por um worker. Detalhes e trade-offs no ADR 0011.

Consequência para o plantão: **efeito pendente não é efeito perdido**. Se o push
não saiu, o evento está no banco esperando — e é inspecionável.

A entrega é **at-least-once**. Um push pode chegar duas vezes; realtime e
auditoria são idempotentes por construção. Não existe exactly-once aqui.

### 7.1 Estado da fila

```bash
pnpm outbox:status
```

Saída: pendentes, em processamento, em dead-letter e a idade do pendente mais
antigo. As mesmas leituras em métricas:

| Métrica                                          | Leitura                               |
| ------------------------------------------------ | ------------------------------------- |
| `safecircle_outbox_backlog{status="pending"}`    | Efeitos esperando entrega             |
| `safecircle_outbox_backlog{status="processing"}` | Reivindicados agora por algum worker  |
| `safecircle_outbox_backlog{status="dead"}`       | Desistimos de entregar; exige decisão |
| `safecircle_outbox_oldest_pending_age_seconds`   | Há quanto tempo o mais antigo espera  |
| `safecircle_outbox_enqueued_total`               | Efeitos gravados, por tipo            |
| `safecircle_outbox_processed_total`              | Efeitos concluídos, por tipo          |
| `safecircle_outbox_retries_total`                | Reprocessamentos agendados            |
| `safecircle_outbox_dead_total`                   | Eventos que viraram dead-letter       |
| `safecircle_outbox_expired_total`                | Descartados por expiração (ver §7.6)  |

Em operação normal o backlog oscila perto de zero e a idade do pendente mais
antigo fica abaixo de poucos segundos.

### 7.2 Backlog crescendo

Sintoma: `safecircle_outbox_backlog{status="pending"}` sobe continuamente, ou a
idade do pendente mais antigo passa de ~60 s.

1. **O worker está ligado?** Procure no log de startup:

```bash
grep '"event":"outbox_worker_disabled"' /var/log/safecircle/api.log
grep '"event":"outbox_worker_started"' /var/log/safecircle/api.log
```

`outbox_worker_disabled` significa `OUTBOX_ENABLED=false`: os efeitos estão
sendo gravados e **ninguém está entregando**. Religue a variável e reinicie.

2. **O worker está falhando em ciclo?**

```bash
grep '"event":"outbox_worker_cycle_failed"' /var/log/safecircle/api.log
```

Normalmente é o banco: confira `/ready` e a conectividade.

3. **O destino está fora do ar?** Um pico de
   `safecircle_outbox_retries_total{event_type="PUSH_..."}` com backlog subindo
   indica provedor indisponível, não problema do worker. Ver §4.

4. **Vazão insuficiente**: se os retries não sobem e o backlog cresce mesmo
   assim, aumente `OUTBOX_BATCH_SIZE` ou `OUTBOX_CONCURRENCY`, ou suba mais uma
   instância — o claim usa `FOR UPDATE SKIP LOCKED` e vários workers sobre a
   mesma fila são seguros.

### 7.3 Dead-letter

Um evento vira `DEAD` quando esgota as tentativas da família (push 8, realtime
3, auditoria 12) ou quando falha de forma permanente (payload inválido, versão
desconhecida). Ele **para de ser tentado** e espera decisão humana.

```bash
pnpm outbox:list-dead
```

A saída traz id, tipo, número de tentativas e `last_error_code` — um código
curto de conjunto fechado, nunca stack trace nem resposta do provedor:

| `last_error_code`           | Significado                                   |
| --------------------------- | --------------------------------------------- |
| `PUSH_PROVIDER_FAILED`      | Expo recusou o lote inteiro, repetidamente    |
| `REALTIME_PUBLISH_FAILED`   | Hub indisponível na hora da publicação        |
| `AUDIT_INSERT_FAILED`       | Escrita da trilha falhando (investigar banco) |
| `PAYLOAD_INVALID`           | Bug: o evento nunca vai processar             |
| `UNSUPPORTED_EVENT_VERSION` | Evento antigo após mudança de contrato        |
| `UNKNOWN_EVENT_TYPE`        | Bug ou linha adulterada                       |
| `HANDLER_UNEXPECTED_ERROR`  | Exceção não prevista no handler               |

### 7.4 Reprocessar manualmente

```bash
pnpm outbox:retry-dead -- --id <uuid>
```

O evento volta para `PENDING` com as tentativas zeradas. O payload **não é
editável** por aqui — a CLI reprocessa o que foi gravado, não reescreve
histórico.

**Quando reprocessar:** a causa foi transitória e já passou (provedor voltou,
banco normalizou), e o efeito ainda faz sentido agora.

**Quando NÃO reprocessar:**

- `PAYLOAD_INVALID`, `UNKNOWN_EVENT_TYPE` ou `UNSUPPORTED_EVENT_VERSION`: é bug
  ou contrato quebrado. Reprocessar vai falhar de novo; corrija o código.
- Push de um alerta antigo: entregar um SOS de horas atrás assusta sem ajudar.
  Prefira deixar em `DEAD`.
- Realtime vencido: o app já ressincronizou via REST. Não há o que recuperar.
- Eventos `PENDING` ou `PROCESSING`: a CLI recusa de propósito. Reenfileirar
  trabalho que já está na fila cria processamento concorrente do mesmo efeito.

Reprocessar um push pode **duplicar** a notificação para quem já recebeu — o
lote inteiro é reenviado. Considere isso antes de reprocessar em massa.

### 7.5 Lease e worker morto

Um evento reivindicado fica `PROCESSING` com `locked_at`/`locked_by`. Se o
processo morre no meio, a linha fica nesse estado — e **isso se resolve
sozinho**: passado o lease (`OUTBOX_LEASE_MS`, padrão 60 s), o evento volta a
ser candidato no próximo claim.

Portanto: um punhado de `PROCESSING` logo após um restart é **normal**. Só
investigue se `safecircle_outbox_backlog{status="processing"}` ficar alto e
parado por vários minutos, o que sugere handlers travados em I/O externo.

Nunca "conserte" isso com `UPDATE` manual enquanto o worker estiver rodando.

### 7.6 Expiração

Push expira em 20 minutos e realtime em 5; auditoria **nunca** expira. Evento
expirado é encerrado sem executar o efeito e contabilizado em
`safecircle_outbox_expired_total`.

Isso é comportamento desejado, não falha: depois de um outage longo, entregar
notificações velhas em massa faz mais mal que bem. Um pico nessa métrica é o
sinal de que houve um outage — investigue a causa, não a expiração.

### 7.7 Quando reiniciar

Reiniciar a API é seguro do ponto de vista da outbox: nada se perde. O que
estava `PENDING` continua `PENDING`; o que estava `PROCESSING` volta pelo lease.

Reinicie quando o worker não estiver reivindicando (sem `outbox_event_claimed`
no log, backlog subindo) e o banco estiver saudável. O encerramento limpo para
de reivindicar eventos novos e aguarda até 10 s pelos handlers em andamento.

---

## 8. WebSocket (realtime)

| Métrica                                      | Leitura                  |
| -------------------------------------------- | ------------------------ |
| `safecircle_realtime_connections`            | Conexões abertas agora   |
| `safecircle_realtime_disconnects_total`      | Desconexões por `reason` |
| `safecircle_realtime_publish_failures_total` | Falhas ao publicar       |

Motivos de desconexão esperados: `closed`, `heartbeat_timeout`, `TOKEN_EXPIRED`
(o app renova e reconecta), `BACKPRESSURE`, `TOO_MANY_CONNECTIONS`.

O realtime é **notificação de mudança**, não fonte de verdade: mesmo com o
WebSocket fora do ar, o app funciona via REST (ao abrir, ao voltar ao primeiro
plano e ao puxar para atualizar). Não é incidente de severidade máxima.

---

## 9. Reinício e encerramento

O encerramento é gracioso e observável. Ao receber `SIGTERM`/`SIGINT`:

1. `shutdown_started`
2. schedulers param; WebSockets são fechados (código 1001)
3. tarefas em segundo plano são aguardadas (até 10 s)
4. o pool do PostgreSQL é fechado
5. `shutdown_completed` (ou `shutdown_timeout` se passar de 15 s — o processo
   sai com código 1)

```bash
grep -E '"event":"(application_starting|application_ready|shutdown_started|shutdown_completed|shutdown_timeout)"' \
  /var/log/safecircle/api.log
```

`application_ready` traz `environment`, `version` (`APP_VERSION`), `gitSha`
(`GIT_SHA`) e `metricsEnabled` — útil para confirmar **qual build** está no ar.

---

## 10. Suspeita de vazamento de dado sensível em log

Trate como incidente de privacidade.

1. Confirme com uma busca dirigida (em ambiente controlado):

```bash
grep -E '(latitude|longitude|passwordHash|ExponentPushToken|Bearer )' /var/log/safecircle/api.log
```

2. Se houver ocorrência real: rotacione o que vazou (token/segredo), restrinja o
   acesso ao log e abra a correção da redaction em
   `apps/api/src/observability/request-context.ts` (`REDACTED_LOG_PATHS`).
3. Adicione um teste em `apps/api/tests/log-redaction.test.ts` cobrindo o caso.

---

## 11. Comandos de manutenção

Todos leem `DATABASE_URL` do ambiente. Devem rodar periodicamente (cron diário).
Desde a Phase 11 basta agendar `pnpm privacy:cleanup`: ele encadeia as demais
políticas e nomeia a etapa que falhar (ver §15.8).

```bash
pnpm location:cleanup   # localização de alertas encerrados há mais de 30 dias
pnpm checkin:cleanup    # check-ins finalizados há mais de 90 dias
pnpm journey:cleanup    # localização de trajetos (30 d) e trajetos finalizados (90 d)
pnpm audit:cleanup      # eventos de auditoria com mais de 180 dias
pnpm outbox:cleanup     # outbox processada (30 d) e dead-letter (90 d)
pnpm privacy:cleanup    # TODAS as políticas acima + sessões/refresh (30 d), em uma execução
pnpm security:audit     # dependências com advisory high/critical (falha o CI)
```

Outros:

```bash
pnpm db:check           # conectividade com o PostgreSQL
pnpm --filter @safecircle/api db:migrate   # aplica migrations pendentes
```

Nenhum comando de retenção apaga entidades de domínio fora da sua política:
`audit:cleanup` toca **apenas** `audit_events`. `outbox:cleanup` **nunca**
apaga eventos `PENDING` ou `PROCESSING` — apagar trabalho pendente é perder
exatamente o que a tabela existe para proteger.

Operação da outbox (§7):

```bash
pnpm outbox:status                     # backlog e idade do pendente mais antigo
pnpm outbox:list-dead                  # eventos que exigem decisão humana
pnpm outbox:retry-dead -- --id <uuid>  # reenfileira UM evento DEAD
```

---

## 12. Sinais operacionais sugeridos

Rascunho inicial — não há alerting externo configurado nesta fase.

| Sinal                                                                 | Ação                            |
| --------------------------------------------------------------------- | ------------------------------- |
| 5xx acima de 2% por 5 min                                             | Investigar `errorId` recentes   |
| `/ready` falhando                                                     | Tirar do balanceador; ver banco |
| Scheduler sem execução por mais de 2 intervalos (~30 s)               | Ver §5                          |
| `safecircle_push_failures_total` muito acima do normal                | Ver §4                          |
| `safecircle_background_tasks_pending` crescendo continuamente         | Ver §6                          |
| `safecircle_audit_failures_total` > 0                                 | Auditoria degradada; ver log    |
| `safecircle_outbox_oldest_pending_age_seconds` > 60 s                 | Ver §7.2                        |
| `safecircle_outbox_backlog{status="dead"}` > 0                        | Ver §7.3                        |
| `safecircle_outbox_expired_total` subindo                             | Houve outage; ver §7.6          |
| `safecircle_refresh_reuse_detected_total` > 0                         | Ver §15.2                       |
| `safecircle_auth_login_attempts_total{result="rate_limited"}` em pico | Ver §15.3                       |
| `pnpm security:audit` falhando no CI                                  | Ver §15.6                       |

## 13. SLOs iniciais (rascunho)

Metas internas de trabalho, **não** garantia contratual:

- Disponibilidade da API: 99,5%
- p95 HTTP: < 500 ms nos endpoints comuns
- Atraso do scheduler: < 30 s em operação normal

---

## 14. Limitações conhecidas

- **Scheduler e realtime em instância única** (ADRs 0006, 0008, 0009).
- **Entrega at-least-once** (ADR 0011): um push pode chegar duas vezes.
  Realtime e auditoria são idempotentes; push não é.
- **Worker da outbox no mesmo processo da API** nesta fase: um pico de tráfego
  concorre com a entrega de efeitos.
- **Rate limit e freio de login por instância** (ADR 0012): com N réplicas o
  teto efetivo é N vezes maior.
- **Sem exclusão de conta** — RELEASE BLOCKER antes das lojas (§15.9, ADR 0012).
- **Sem troca de senha nem MFA**; enumeração possível via registro (409),
  limitada por rate limit.
- **TLS, encryption at rest e backups** são da infraestrutura, não desta API
  (`docs/security/release-security-checklist.md`).
- **Ordem de entrega não garantida** entre eventos da outbox. Nenhum efeito
  atual depende de ordem.
- **Falha de auditoria não desfaz a operação** de negócio, mas desde a Phase 10
  o evento é reprocessado até entrar na trilha (12 tentativas, sem expiração).
- **Localização ao vivo só em primeiro plano** (ADRs 0007, 0009).
- **Sem tracing distribuído, APM ou dashboards hospedados**: a correlação é por
  `requestId` no log e as métricas são expostas para coleta externa.

---

## 15. Segurança e privacidade

Roteiro completo em [`docs/security/incident-response.md`](../security/incident-response.md);
aqui, os atalhos de plantão. Prioridade: **SOS > push > realtime > check-in/trajeto

> métricas/auditoria** — conter nunca pode deixar alguém sem pedir ajuda.

### 15.1 Suspeita de takeover de conta

Sinais: usuário relata sessão que não reconhece; `AUTH_REFRESH_REUSE_DETECTED`
para o usuário; pico de `AUTH_LOGIN_FAILED` seguido de `AUTH_LOGIN_SUCCEEDED`.

1. Peça ao usuário para usar **"Sair dos outros aparelhos"** (o app chama
   `POST /me/sessions/revoke-others`). Se ele não conseguir, revogue pelo banco:

```sql
UPDATE auth_sessions
   SET revoked_at = now(), revoked_reason = 'USER_REVOKED_OTHERS', updated_at = now()
 WHERE user_id = '<uuid>' AND revoked_at IS NULL;
```

Efeito imediato: access tokens param de valer na próxima requisição e o
WebSocket cai (4403). 2. Confira a trilha do usuário: `SELECT event_type, created_at FROM audit_events
   WHERE actor_user_id = '<uuid>' ORDER BY created_at DESC LIMIT 50`. 3. Não há troca de senha ainda: oriente a não reutilizar a senha em outros
serviços e registre o caso.

### 15.2 Reuso de refresh token detectado

`safecircle_refresh_reuse_detected_total` subiu, ou o log tem
`auth_refresh_reuse_detected` com `sessionId`/`userId`.

- A API **já revogou** a sessão (`revoked_reason = 'REFRESH_REUSE'`) e
  auditou. Não é preciso agir para conter aquela sessão.
- Verifique se o usuário tem **outras** sessões ativas suspeitas
  (`GET /me/sessions` pelo próprio usuário, ou consulta ao banco) e, em
  dúvida, revogue todas (§15.1).
- Vários usuários ao mesmo tempo indica roubo em massa (aparelhos, proxy
  malicioso, vazamento de logs). Abra o roteiro de incidente.
- Um único evento logo após instabilidade de rede pode ser corrida fora da
  janela de 10 s — o usuário só precisa entrar de novo.

### 15.3 Credential stuffing / força bruta

Sinais: `safecircle_auth_login_attempts_total{result="invalid_credentials"}`
e `{result="rate_limited"}` em pico; `safecircle_security_rate_limited_total{route_group="auth"}`
subindo; muitos `AUTH_LOGIN_FAILED`.

- Os freios já atuam: por IP (10/min com backoff) e por conta (5 falhas → 15
  min). **Não** bloqueie contas manualmente: lockout permanente é uma arma
  contra a vítima.
- Os limites são **por instância**: com N réplicas o teto efetivo é N vezes
  maior. Se insuficiente, reduza `max` em `rate-limit.ts` e faça deploy.
- Ataque volumétrico é problema de infraestrutura (WAF/L4), não da API.

### 15.4 `/metrics` exposto indevidamente

- Produção não sobe com `METRICS_ENABLED=true` sem `METRICS_TOKEN`; se está
  exposto, ou o token vazou ou a porta está pública.
- Rotacione `METRICS_TOKEN` (no coletor e no ambiente) e feche a porta na
  rede. Se precisar, `METRICS_ENABLED=false` e redeploy.
- As métricas não contêm dado pessoal (labels de conjunto fechado), mas
  revelam volume e horários.

### 15.5 Segredo vazado

| Segredo             | Ação                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `JWT_ACCESS_SECRET` | Rotacionar e redeploy. Todo access token morre; o app renova pelo refresh sem o usuário perceber |
| Credencial do banco | Rotacionar no PostgreSQL e no ambiente; revisar `pg_stat_activity`                               |
| `METRICS_TOKEN`     | Rotacionar (§15.4)                                                                               |
| `EXPO_ACCESS_TOKEN` | Revogar na Expo e gerar novo; push fica degradado até o deploy; a outbox reprocessa              |

Segredo que apareceu em commit, issue, chat ou log está **comprometido**,
mesmo que apagado depois. Produção recusa segredo fraco/placeholder, então um
valor ruim falha no startup, não em silêncio.

### 15.6 Dependência vulnerável

- `pnpm security:audit` falhando no CI (high/critical) bloqueia o merge — é o
  comportamento esperado.
- Atualize a dependência. Só se não for possível, registre um waiver em
  [`docs/security/vulnerability-waivers.md`](../security/vulnerability-waivers.md)
  com impacto, mitigação e **data de expiração**. Sem waiver permanente.
- Alertas do Dependabot e do CodeQL ficam na aba Security do repositório.

### 15.7 Exportação de dados (`GET /me/privacy/export`)

- É do próprio usuário, autenticada, com rate limit de 5 por hora por IP.
- O conteúdo **não é logado**; só o evento `PRIVACY_EXPORT_REQUESTED` vai para
  a auditoria. Muitos eventos desses para um usuário em pouco tempo, junto
  com login estranho, é sinal de takeover (§15.1).
- Não existe exportação "por outro usuário" nem por operador via HTTP.

### 15.8 Retenção (`pnpm privacy:cleanup`)

```bash
pnpm privacy:cleanup      # encadeia localização, check-ins, trajetos, auditoria, outbox e autenticação
```

- Cron diário. Nunca apaga ACTIVE, PENDING ou PROCESSING.
- Saída por categoria e quantidade; exit code ≠ 0 nomeia a etapa que falhou
  e as demais rodam mesmo assim.
- **Durante um incidente, não rode**: apaga evidência. Espere o dump do §2 do
  roteiro de incidentes.
- Prazos em [`docs/privacy/retention-policy.md`](../privacy/retention-policy.md).

### 15.9 RELEASE BLOCKER — exclusão de conta

> RELEASE BLOCKER — implementar fluxo completo de exclusão de conta antes da
> publicação nas lojas.

Não existe `DELETE /me`. Um pedido de exclusão hoje **não pode** ser atendido
com um `DELETE FROM users`: grupos onde a pessoa é OWNER ficariam sem dono,
alertas ativos sumiriam sem aviso e a outbox pendente falharia. Registre o
pedido e escale; a decisão de produto (transferência de ownership, carência,
bloqueio com SOS ativo) está mapeada no ADR 0012 §21.
