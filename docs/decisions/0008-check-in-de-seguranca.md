# ADR 0008 — Check-in de Segurança

## Status

Aceito — Phase 7 (Check-in de Segurança). Scheduler em **instância única**
dentro da API (ver "Limitações reais").

## Contexto

Até a Phase 6 o SafeCircle só reagia a um pedido explícito de ajuda (SOS).
Há situações em que a pessoa não consegue pedir ajuda, mas pode, antes, avisar
que pretende confirmar que está bem até um horário: um trajeto à noite, um
encontro com desconhecido, uma consulta. A Phase 7 adiciona o **check-in de
segurança**: "se eu não confirmar até X, avise meu grupo".

O recurso precisa ser honesto e previsível. Um check-in vencido significa
apenas que **o prazo passou sem confirmação** — não que a pessoa está em
perigo. Relógios de celular são pouco confiáveis (fuso, ajuste manual,
suspensão do app), então o servidor decide o vencimento. E, como o vencimento
acontece sem nenhuma requisição do usuário, é preciso um mecanismo de tempo no
backend que funcione com a infraestrutura já existente (PostgreSQL, Fastify),
sem introduzir filas ou workers distribuídos nesta fase.

## Decisão

### Finalidade e linguagem

- O check-in é criado pelo próprio usuário, para **um grupo** de que ele é
  membro, com um prazo (`dueAt`).
- Ao vencer, o app e o push dizem "Check-in não confirmado" / "Um membro do
  seu grupo não confirmou o check-in no prazo." Para o dono: "Seu check-in
  venceu sem confirmação." Para membros: "O prazo de <nome> venceu sem
  confirmação. Isso não confirma uma emergência. Tente entrar em contato de
  forma segura." Nunca "a pessoa está em perigo".
- Check-in vencido **não** cria `EmergencyAlert`, **não** liga localização ao
  vivo e **não** dispara SMS/WhatsApp/e-mail. O membro decide o que fazer; a
  interface sugere contato seguro e, havendo indícios de risco imediato, os
  serviços oficiais de emergência.

### Estados e transições

Tabela `safety_checkins` com enum `checkin_status`:

| De        | Para        | Quem                      | Endpoint / mecanismo         |
| --------- | ----------- | ------------------------- | ---------------------------- |
| —         | `ACTIVE`    | dono                      | `POST /checkins`             |
| `ACTIVE`  | `SAFE`      | dono                      | `POST /checkins/:id/safe`    |
| `ACTIVE`  | `CANCELLED` | dono                      | `POST /checkins/:id/cancel`  |
| `ACTIVE`  | `OVERDUE`   | servidor                  | `CheckinScheduler.runOnce()` |
| `OVERDUE` | `SAFE`      | dono (confirmação tardia) | `POST /checkins/:id/safe`    |

Qualquer outra transição responde `409 INVALID_CHECKIN_TRANSITION`.
Repetir `safe` sobre `SAFE` ou `cancel` sobre `CANCELLED` é idempotente
(200 com o estado atual). Membros que tentam `safe`/`cancel` recebem
`403 FORBIDDEN`; quem não pertence ao grupo recebe `404 CHECKIN_NOT_FOUND`
(anti-IDOR, mesma resposta de check-in inexistente). Cada transição registra
seu carimbo (`confirmed_at`, `cancelled_at`, `overdue_at`).

### Um check-in ativo por (usuário, grupo)

Índice único parcial `safety_checkins_active_per_user_group_unique
(user_id, group_id) WHERE status = 'ACTIVE'`. A regra é garantida pelo banco,
não pela aplicação: criações concorrentes resultam em uma linha e um
`409 CHECKIN_ALREADY_ACTIVE` para a outra. O mesmo usuário pode ter check-ins
ativos em grupos diferentes.

### Prazo (`dueAt`) e relógio autoritativo

O cliente envia `dueAt` em ISO 8601; o servidor valida contra **o próprio
relógio**: mínimo 5 minutos e máximo 24 horas a partir de `now()` do servidor
(`400 INVALID_CHECKIN_DUE_AT`). O app calcula `dueAt` apenas para exibir e
enviar; não há como "adiantar" ou "atrasar" o vencimento pelo relógio do
aparelho. A resposta devolve o `dueAt` aceito, e o app usa esse valor no
contador.

### Idempotência de criação

`POST /checkins` reutiliza a infraestrutura de `Idempotency-Key` da Phase 3
(tabela `idempotency_keys`, escopo `checkins.create`, hash do corpo). A chave
e o check-in são inseridos na **mesma transação**; repetição da chave devolve
o mesmo check-in (200, `replayed`) sem publicar `CHECKIN_CREATED` de novo;
mesma chave com corpo diferente → `409 IDEMPOTENCY_KEY_REUSED`; chave ausente
ou inválida → `400 INVALID_IDEMPOTENCY_KEY`. O app gera uma chave por
tentativa e só a troca após um erro definitivo da API.

### Scheduler de vencimento (polling no PostgreSQL)

`CheckinScheduler` roda dentro do processo da API (plugin
`safecircle-checkin-scheduler`), iniciado em `onReady` e parado em `onClose`.
A cada 15 s (`setInterval` com `unref`) executa `runOnce()`:

```sql
UPDATE safety_checkins
   SET status = 'OVERDUE', overdue_at = now(), updated_at = now()
 WHERE id IN (SELECT id FROM safety_checkins
               WHERE status = 'ACTIVE' AND due_at <= now() LIMIT 100)
   AND status = 'ACTIVE' AND due_at <= now()
RETURNING id, user_id, group_id;
```

- **Atualização condicional**: a linha só muda se ainda estiver `ACTIVE`. Se o
  dono confirmar `SAFE` um instante antes, o `UPDATE` não a alcança; se
  confirmar um instante depois, a transição `OVERDUE → SAFE` continua válida.
- **Lotes de 100** por execução; o restante fica para o próximo ciclo.
- **Sem sobreposição**: uma execução em andamento é compartilhada por chamadas
  concorrentes de `runOnce()`; `start()` é idempotente.
- **Efeitos após o commit**: para cada linha retornada, o plugin agenda no
  runner de segundo plano a publicação realtime `CHECKIN_OVERDUE` e o push aos
  membros. Falhas de push/realtime são registradas (sem tokens, sem dados
  pessoais) e **nunca revertem** a transição — e, como a linha já não é
  `ACTIVE`, não há reenvio duplicado no ciclo seguinte.
- Nos testes o scheduler não inicia automaticamente
  (`checkinSchedulerAutoStart: false`); os testes chamam `runOnce()` com o
  relógio real e prazos já vencidos.

Por que polling e não `setTimeout` por check-in: timers em memória se perdem
em restart/deploy e não sobrevivem a mais de um processo; o estado no banco é
a fonte de verdade e o polling recupera qualquer vencimento perdido na
primeira execução após subir.

### Notificações e realtime

- Eventos realtime (envelope da Phase 5, `version: 1`): `CHECKIN_CREATED`,
  `CHECKIN_SAFE`, `CHECKIN_CANCELLED`, `CHECKIN_OVERDUE`, todos com
  `{ checkinId, groupId, userId }` — apenas IDs; o app rebusca via REST.
- Push apenas no vencimento, para os membros do grupo **exceto o dono**
  (`data.type = "SAFETY_CHECKIN_OVERDUE"`, `checkinId`, `groupId`; canal
  `emergency`). Reaproveita o envio da Phase 4 (`dispatchPush`, desativação
  de tokens inválidos, logs só com contagens). O toque na notificação abre o
  detalhe do check-in e mostra o **estado atual** do servidor (pode já ser
  `SAFE`).

### Mobile: contador visual, não decisão

- A Home mostra a seção "Check-in de segurança" com o check-in ativo/vencido,
  contador ("Faltam 23 min"), "ESTOU BEM", "CANCELAR CHECK-IN" (com
  confirmação) e "INICIAR CHECK-IN".
- "Novo check-in": escolha do grupo, prazos de 15/30/60/120 min ou
  personalizado (5–1440), e o texto "Se você não confirmar até HH:MM, os
  membros do grupo X serão avisados."
- Quando o contador zera, o app exibe "Prazo encerrado. Aguardando confirmação
  do servidor..." e **consulta o backend** — nunca marca `OVERDUE`
  localmente. O estado só muda com a resposta REST, um evento realtime ou a
  ressincronização (reconexão / volta ao primeiro plano).
- Sem dependência de fuso: horários vêm em ISO/UTC e são formatados no
  aparelho apenas para exibição.

### Privacidade e segurança

- Todos os endpoints exigem JWT; leitura restrita ao dono e aos membros
  atuais do grupo; ex-membros e externos recebem 404.
- Payloads de push e realtime não carregam nome, localização ou mensagens;
  o app busca o detalhe autenticado.
- Nenhum log registra tokens ou dados pessoais; apenas IDs internos e
  contagens.
- `POST /checkins` tem limite de 20 requisições/minuto por usuário
  (anti-abuso); as demais rotas usam o limite padrão.
- Check-in não coleta localização.

### Retenção

Check-ins finalizados (`SAFE`, `CANCELLED`, `OVERDUE`) são apagados 90 dias
após o encerramento (`coalesce(confirmed_at, cancelled_at, overdue_at,
updated_at)`) por `pnpm checkin:cleanup` (`deleteExpiredCheckins`). Check-ins
`ACTIVE` nunca são apagados pela retenção. Deve rodar periodicamente em
produção (cron diário).

## Limitações reais

- **Instância única do scheduler.** Com várias réplicas da API cada uma
  rodaria seu polling. A atualização condicional garante que cada check-in
  vira `OVERDUE` uma única vez (só uma réplica recebe a linha no
  `RETURNING`), então não há push duplicado — mas o desenho, o log e a
  observabilidade assumem um processo, como o hub realtime (ADR 0006).
- Precisão do vencimento de até ~15 s (intervalo de polling), aceitável para
  prazos de minutos a horas.
- O push chega aos membros somente se tiverem dispositivo registrado com
  permissão (Phase 4); sem push, o estado aparece no app ao abrir.
- Não há lembrete antes do prazo, extensão do prazo, check-in recorrente nem
  escalonamento automático.
- Não há SMS/WhatsApp/e-mail, criação automática de SOS, localização
  automática, geofence ou trajeto/ETA — escopo da Phase 8 ou posterior.

## Alternativas consideradas

- **Vencimento calculado no app** (marcar `OVERDUE` ao zerar o contador):
  rejeitado; o relógio do aparelho não é confiável e o app pode estar
  fechado — o grupo não seria avisado.
- **`setTimeout`/`node-cron` por check-in**: rejeitado; estado só em memória,
  perdido em restart e incompatível com mais de um processo.
- **Fila/worker distribuído (Redis, BullMQ, SQS, `pg_cron`)**: adiado. O
  polling condicional no PostgreSQL resolve a fase com a infraestrutura atual;
  a evolução natural é extrair `runOnce()` para um worker dedicado com
  `SELECT ... FOR UPDATE SKIP LOCKED` ou uma job queue quando houver múltiplas
  réplicas.
- **Trigger no banco para notificar**: rejeitado; efeitos externos (push,
  websocket) devem ficar na aplicação, com retentativa e logs controlados.
- **Escalar automaticamente para SOS ao vencer**: rejeitado; falso positivo
  frequente (esqueceu de confirmar) e contrário à linguagem honesta do
  produto.

## Consequências

Positivas: o grupo é avisado mesmo com o app fechado; o estado é único e
consistente (banco como fonte de verdade); a regra "um ativo por grupo" e as
transições são garantidas pelo banco; a linguagem evita alarme falso; nenhum
dado sensível novo é coletado.

Negativas: mais um processo periódico dentro da API (instância única);
latência de até 15 s no vencimento; a retenção depende de um cron externo,
como a de localização (ADR 0007).
