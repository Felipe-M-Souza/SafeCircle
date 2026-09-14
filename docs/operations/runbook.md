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
- Sem resposta / conexão recusada → o processo caiu ou não sobe. Ver §8.

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
Se algum desses aparecer, é um incidente de privacidade — ver §9.

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

| Métrica                                    | Para quê                                |
| ------------------------------------------ | --------------------------------------- |
| `safecircle_http_requests_total`           | Volume e taxa de erro (`status_class`)  |
| `safecircle_http_request_duration_seconds` | Latência (p95)                          |
| `safecircle_realtime_connections`          | Conexões WebSocket abertas agora        |
| `safecircle_background_tasks_pending`      | Fila em memória de efeitos pós-resposta |
| `safecircle_push_failures_total`           | Falhas de push                          |
| `safecircle_scheduler_runs_total`          | Schedulers rodando                      |
| `safecircle_audit_failures_total`          | Auditoria falhando                      |

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
     app mostra tudo ao abrir. Não há retry persistente nesta fase.
   - **Token inválido**: `safecircle_push_invalid_tokens_total` sobe e o
     dispositivo é desativado automaticamente. Esperado quando alguém desinstala
     o app.
   - **Ninguém registrado**: `recipients: 0` no evento
     `push_dispatch_completed` — não é falha.

Push **nunca** deve tornar a API not-ready: uma falha de push não bloqueia SOS.

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
4. Limitação conhecida: o scheduler roda **dentro da API, em instância única**.
   Com várias réplicas cada uma faz polling, mas o `UPDATE` condicional garante
   que cada item vence uma vez só.

---

## 6. Tarefas em segundo plano acumulando

`safecircle_background_tasks_pending` deve oscilar perto de zero.

Crescimento contínuo indica efeitos (push/realtime/auditoria) travando.

```bash
grep '"event":"background_task_failed"' /var/log/safecircle/api.log
```

As tarefas vivem **no processo**: se a API cair antes de concluí-las, não há
retry persistente (limitação documentada nos ADRs 0005 e 0010). O encerramento
limpo aguarda até 10 s pelas tarefas pendentes.

---

## 7. WebSocket (realtime)

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

## 8. Reinício e encerramento

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

## 9. Suspeita de vazamento de dado sensível em log

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

## 10. Comandos de manutenção

Todos leem `DATABASE_URL` do ambiente. Devem rodar periodicamente (cron diário).

```bash
pnpm location:cleanup   # localização de alertas encerrados há mais de 30 dias
pnpm checkin:cleanup    # check-ins finalizados há mais de 90 dias
pnpm journey:cleanup    # localização de trajetos (30 d) e trajetos finalizados (90 d)
pnpm audit:cleanup      # eventos de auditoria com mais de 180 dias
```

Outros:

```bash
pnpm db:check           # conectividade com o PostgreSQL
pnpm --filter @safecircle/api db:migrate   # aplica migrations pendentes
```

Nenhum comando de retenção apaga entidades de domínio fora da sua política:
`audit:cleanup` toca **apenas** `audit_events`.

---

## 11. Sinais operacionais sugeridos

Rascunho inicial — não há alerting externo configurado nesta fase.

| Sinal                                                         | Ação                            |
| ------------------------------------------------------------- | ------------------------------- |
| 5xx acima de 2% por 5 min                                     | Investigar `errorId` recentes   |
| `/ready` falhando                                             | Tirar do balanceador; ver banco |
| Scheduler sem execução por mais de 2 intervalos (~30 s)       | Ver §5                          |
| `safecircle_push_failures_total` muito acima do normal        | Ver §4                          |
| `safecircle_background_tasks_pending` crescendo continuamente | Ver §6                          |
| `safecircle_audit_failures_total` > 0                         | Auditoria degradada; ver log    |

## 12. SLOs iniciais (rascunho)

Metas internas de trabalho, **não** garantia contratual:

- Disponibilidade da API: 99,5%
- p95 HTTP: < 500 ms nos endpoints comuns
- Atraso do scheduler: < 30 s em operação normal

---

## 13. Limitações conhecidas

- **Scheduler e realtime em instância única** (ADRs 0006, 0008, 0009).
- **Sem retry persistente** para push/realtime/auditoria: efeitos em memória,
  perdidos se o processo morrer antes de concluí-los (ADR 0010; a evolução é
  outbox + worker).
- **Falha de auditoria não desfaz a operação** de negócio — é registrada e
  contabilizada, mas o evento pode não existir na trilha.
- **Localização ao vivo só em primeiro plano** (ADRs 0007, 0009).
- **Sem tracing distribuído, APM ou dashboards hospedados**: a correlação é por
  `requestId` no log e as métricas são expostas para coleta externa.
