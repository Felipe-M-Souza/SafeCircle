# ADR 0006 — Atualizações em Tempo Real

## Status

Aceito — Phase 5 (Atualizações em Tempo Real).

## Contexto

Com alertas (Phase 3) e push (Phase 4), o app aberto ainda dependia de
pull-to-refresh ou de voltar ao primeiro plano para ver mudanças. A Phase 5
adiciona propagação rápida de mudanças para quem está com o app aberto e o
conceito de **resposta do grupo** (acknowledgement): membros declaram que
viram o alerta, estão indo ajudar ou acionaram serviços de emergência, e
todos veem essas respostas em tempo real.

Restrições: banco e API REST continuam a fonte de verdade; autorização
100% server-side; nenhuma infraestrutura distribuída (Redis, NATS, Kafka);
nada de localização ao vivo, presença ou chat.

## Decisão

### REST/DB como fonte de verdade

```text
Banco = estado autoritativo
REST  = leitura/escrita confiável
WebSocket = notificação de mudança
Push  = aviso fora do app
```

Toda operação segue `validar → persistir → commit → responder → publicar
evento`. A publicação roda em segundo plano (plugin `background-tasks` da
Phase 4) e nunca influencia a resposta nem desfaz a transação. Eventos
carregam apenas IDs; o cliente busca o estado atual via REST. Não há
ordenação global prometida: para um alerta, o estado REST prevalece sempre.

### Transporte e endpoint

`@fastify/websocket` no mesmo servidor Fastify (sem servidor realtime
separado): `GET /realtime` com upgrade. `maxPayload` pequeno (1 KiB) porque o
cliente não envia comandos.

### Autenticação do socket

O handshake usa `Authorization: Bearer <accessToken>` — o WebSocket do React
Native aceita headers customizados, então não há token em query string. O
mesmo `app.authenticate` do REST valida assinatura, expiração, `iss`/`aud`,
`sub` e `sid`; sem token, inválido ou expirado → HTTP 401 e nenhum socket.
Não há verificação adicional de sessão no banco (paridade com o REST, cujo
access token dura 15 min).

### Expiração do token durante a conexão

A conexão recebe um TTL igual ao `exp` do token: ao expirar, o servidor fecha
com o código `4401 TOKEN_EXPIRED`. O cliente renova o access token via REST
(`/auth/refresh`) e reconecta. Se o refresh falhar, a sessão é encerrada pelo
`AuthContext` e o realtime para. Sempre que o access token muda (login,
refresh), o cliente reconecta com o token novo; um socket nunca continua
associado a uma credencial expirada.

### RealtimeHub e RealtimePublisher

- `RealtimeHub` (em memória): registra conexões por usuário (várias por
  usuário), remove ao fechar, envia a conjuntos de usuários, aplica
  heartbeat ping/pong a cada 30 s (conexão sem pong é terminada), limita 5
  conexões por usuário (a mais antiga é fechada com `4429`) e aplica
  backpressure: socket com mais de 256 KiB em buffer é fechado (`4413`) e o
  cliente ressincroniza ao reconectar — nunca acumulamos filas ilimitadas.
- `RealtimePublisher.publishToGroup(groupId, event)`: os destinatários são
  lidos de `group_memberships` **a cada publicação**; quem saiu ou foi
  removido deixa de receber automaticamente. `publishToUser` serve para
  `GROUP_MEMBERSHIP_CHANGED`. Rotas e serviços nunca tocam em sockets.

### Server-push only

Comandos continuam via REST (autorização e idempotência já resolvidas).
Mensagens enviadas pelo cliente no socket são ignoradas.

### Envelope versionado e `eventId`

```json
{
  "version": 1,
  "type": "ALERT_CREATED",
  "eventId": "uuid",
  "occurredAt": "…",
  "data": { "alertId": "…", "groupId": "…" }
}
```

Tipos: `ALERT_CREATED`, `ALERT_RESOLVED`, `ALERT_CANCELLED`,
`ALERT_ACKNOWLEDGEMENT_CHANGED` (`alertId`, `groupId`, `userId`) e
`GROUP_MEMBERSHIP_CHANGED` (`groupId`, `userId`, enviado só ao usuário
afetado ao sair/ser removido/aceitar convite). `eventId` é um UUID gerado na
publicação (não persistido): permite deduplicação no cliente e
observabilidade. O cliente valida versão, tipo, `eventId`, `occurredAt` e
`data`, e ignora com segurança tipos ou versões desconhecidos.

Diferença em relação ao push: o push exclui o criador; o evento realtime o
inclui, para sincronizar seus outros aparelhos. Replays idempotentes de
`POST /alerts` e transições inválidas não publicam evento.

### Acknowledgements

Tabela `alert_acknowledgements` (`alertId` FK cascade, `userId` FK cascade,
`type`, timestamps, `UNIQUE(alert_id, user_id)`, índice por alerta) com o
enum `SEEN`, `ACKNOWLEDGED`, `GOING_TO_HELP`, `EMERGENCY_SERVICES_CONTACTED`
(UI: Viu o alerta / Confirmou o alerta / Está indo ajudar / Acionou serviço de
emergência). É o estado **declarado** pelo membro — não garantia de socorro.

- `PUT /alerts/:alertId/acknowledgement` `{ type }`: membro atual do grupo;
  externo → `404 ALERT_NOT_FOUND`; **criador → `403 FORBIDDEN`** (a resposta
  é dos membros que receberam o alerta); alerta encerrado →
  `409 ALERT_NOT_ACTIVE`; autoria sempre de `request.auth.userId`.
- Upsert atômico por `(alertId, userId)` com `SELECT … FOR UPDATE` e
  repetição em corrida de inserção; o banco garante uma linha.
- Progressão: qualquer estado explícito substitui outro (o usuário decide);
  apenas `SEEN` nunca rebaixa um estado existente — é o "auto-SEEN" que o app
  envia uma única vez ao abrir a tela como membro. Push entregue ≠ visto.
- Sem mudança persistida (auto-SEEN sobre estado mais forte, ou mesmo tipo)
  não há evento; mudanças publicam `ALERT_ACKNOWLEDGEMENT_CHANGED`.
- `GET /alerts/:alertId/acknowledgements` (membros; externo → 404) devolve
  `{ user: { id, name }, type, updatedAt }` — sem e-mail nem dados de
  autenticação. Leitura permitida após o encerramento. Não há endpoint de
  remoção (preferimos alterar para outro estado).

### Mobile: RealtimeClient e RealtimeProvider

- `src/realtime/RealtimeClient`: conecta com o access token, valida e
  deduplica eventos (`eventId`, janela de 200), expõe estado
  (`DISCONNECTED`/`CONNECTING`/`CONNECTED`/`RECONNECTING`), reconecta com
  exponential backoff (1 s, 2 s, 4 s… até 30 s) + jitter, zera o backoff após
  conexão estável, trata `4401` renovando o token e `stop()` fecha, limpa
  timers e cache sem reconectar.
- `RealtimeProvider`: inicia após login/restauração, para no logout,
  reconecta quando o access token muda, fecha em background e reconecta em
  foreground (AppState). Uma única instância de cliente/socket.
- Ressincronização: a cada (re)conexão `resyncVersion` incrementa e as telas
  recarregam pela API (`GET /alerts?status=ACTIVE`; detalhe do alerta e
  acknowledgements quando abertos). Eventos perdidos nunca são assumidos.
- Eventos: `ALERT_*` recarregam a lista/Home; na tela do alerta, eventos com
  o mesmo `alertId` recarregam detalhe e respostas. Nenhuma navegação
  automática — o push cobre o awareness fora do app.
- UI: membros veem VI O ALERTA / ESTOU INDO AJUDAR / ACIONEI EMERGÊNCIA (com
  o aviso "Evite confronto direto…"), desabilitados quando o alerta encerra;
  o criador vê apenas as respostas do grupo. Indicador discreto de
  reconexão na lista de alertas.

### Falha do realtime não afeta persistência

Erro no hub/publisher é capturado e logado pelo runner em segundo plano; a
operação REST já foi confirmada. Testado com o hub lançando erro.

### Logs

Apenas `eventType`, `eventId`, `connectionId`, `userId` interno e contagens.
Nunca tokens, coordenadas ou payloads sensíveis.

## Alternativas consideradas

- **Token na query string**: rejeitado — URLs vazam em logs/proxies; RN
  suporta headers no handshake.
- **Reautenticação por mensagem no socket**: rejeitado — fechar em `4401` e
  reconectar é mais simples e mantém o socket server-push only.
- **Broadcast por grupo com assinaturas em memória**: rejeitado — uma
  conexão antiga poderia continuar recebendo após sair do grupo; calcular
  destinatários no banco a cada publicação é mais seguro.
- **Persistir eventos para replay**: adiado — a ressincronização REST cobre
  eventos perdidos nesta fase.
- **Criador com acknowledgement automático**: rejeitado — a resposta é dos
  membros; o criador tem resolver/cancelar.
- **Progressão estrita de acknowledgement**: rejeitado — "indo ajudar" e
  "acionei emergência" não são uma escada; só o auto-SEEN é protegido.

## Consequências

Positivas:

- App aberto reflete criação/encerramento/respostas em segundos, sem
  polling; falhas de realtime nunca corrompem estado.
- Autorização e privacidade continuam integralmente no servidor.

Negativas / limitações:

- **Instância única**: o `RealtimeHub` vive em memória; com várias instâncias
  da API, um evento publicado em uma instância não chega aos sockets das
  outras. Evolução futura: barramento compartilhado (Redis Pub/Sub, NATS ou
  broker equivalente) por trás do mesmo `RealtimePublisher`, sem mudar rotas
  nem o contrato de eventos. Não implementado agora.
- Sem replay de eventos: quem ficou desconectado depende da ressincronização
  REST ao reconectar (por desenho).
- Socket fechado em background: o push continua sendo o mecanismo de
  awareness fora do app.
