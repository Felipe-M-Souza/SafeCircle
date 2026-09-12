# ADR 0007 — Localização ao Vivo

## Status

Aceito — Phase 6 (Localização ao Vivo). Entrega limitada a **primeiro plano**
(ver "Limitações reais").

## Contexto

Na Phase 3 o alerta passou a carregar uma localização pontual capturada na
ativação. Durante um alerta ativo, porém, quem vai ajudar precisa saber onde a
pessoa está agora. A Phase 6 permite que o **criador** do alerta compartilhe
sua posição ao vivo, de forma explícita, privada, temporária e restrita aos
membros atuais do grupo, com o banco/API REST como fonte de verdade e o
realtime da Phase 5 como notificação de mudança.

Localização é dado altamente sensível: sem alerta ativo não há
compartilhamento; nada é iniciado silenciosamente; nada continua após o
encerramento do alerta, a parada manual, o logout ou a perda de autorização.

## Decisão

### Finalidade e opt-in explícito

O compartilhamento nunca é ligado automaticamente pelo SOS. Na tela do alerta
ACTIVE, o criador vê "Localização ao vivo — ATIVAR LOCALIZAÇÃO AO VIVO";
antes da permissão do sistema o app explica: "Sua localização será
compartilhada apenas com os membros deste grupo enquanto o alerta estiver
ativo. Você pode interromper o compartilhamento a qualquer momento." Só então
a permissão de localização em primeiro plano é solicitada (se ainda não
concedida). Permissão negada ou serviço de localização desligado mostram uma
mensagem clara e **não afetam o alerta**.

### Quem compartilha e quem vê

- Somente o criador inicia, envia e para (autoria de `request.auth.userId`;
  outro membro → `403 FORBIDDEN`).
- Somente membros atuais do grupo leem estado e histórico; externos,
  ex-membros e quem só conhece o `alertId` recebem `404 ALERT_NOT_FOUND`
  (anti-IDOR, mesma resposta de alerta inexistente).

### Localização inicial × ao vivo

`alert_locations` (Phase 3) permanece a localização pontual da ativação.
`alert_location_sessions` é a sessão ao vivo (uma `ACTIVE` por alerta,
índice único parcial) e `alert_location_updates` são os pontos
(`clientUpdateId` UUID, `UNIQUE(session_id, client_update_id)`, coordenadas,
`accuracy/altitude/heading/speed` opcionais, `capturedAt` do aparelho e
`createdAt` do servidor como referência operacional). Migration
`0005_live_location`; migrations 0000–0004 intocadas.

### Validação e frequência

Backend valida latitude (−90..90), longitude (−180..180), `accuracy`/`speed`
≥ 0, `heading` 0..360, rejeita NaN/Infinity/strings (Zod) e `capturedAt`
mais de 2 min no futuro ou mais de 24 h no passado. Throttling por sessão:
~1 ponto a cada 2 s (`429 LOCATION_UPDATE_TOO_FREQUENT`), sem afetar o SOS
nem outros endpoints. No app, o watcher do `expo-location` usa
`timeInterval: 5000` e `distanceInterval: 10` (precisão alta) e o envio
respeita 4 s entre pontos.

### Idempotência e retry no app

Cada ponto tem `clientUpdateId`; o retry de rede reutiliza o mesmo id e o
backend devolve o ponto já gravado (`200` + `Idempotent-Replayed`). O app
mantém **apenas o ponto mais recente** pendente: pontos novos substituem o
pendente, falhas temporárias (rede, 5xx, 429) tentam de novo, respostas
definitivas (4xx) descartam e encerram o compartilhamento local, e pontos com
mais de 60 s são descartados — nunca despejamos uma fila ao reconectar.

### Endpoints

`POST /alerts/:id/live-location/start` (idempotente; `201` na criação),
`POST /alerts/:id/live-location` (ponto), `POST /alerts/:id/live-location/stop`
(idempotente), `GET /alerts/:id/live-location` (estado + `latest`; `INACTIVE`
sem sessão) e `GET /alerts/:id/live-location/history` (últimos 15 minutos,
máximo 100 pontos, ordem cronológica).

### Encerramento automático

`resolve`/`cancel` executam a transição do alerta e a parada da sessão ACTIVE
**na mesma transação**; o app, ao resolver/cancelar, para o watcher local
imediatamente e o backend rejeita novos pontos (`ALERT_NOT_ACTIVE` /
`LIVE_LOCATION_NOT_ACTIVE`). Ao voltar ao primeiro plano, o app confirma no
backend se a sessão continua ACTIVE e para localmente se não.

### Realtime sem coordenadas

Eventos `ALERT_LIVE_LOCATION_STARTED`, `ALERT_LIVE_LOCATION_UPDATED` e
`ALERT_LIVE_LOCATION_STOPPED` levam só `alertId`, `groupId` e `sessionId`;
ao recebê-los o app busca o estado via REST. Publicação em segundo plano após
o commit; falha do publisher nunca desfaz a persistência. Não há push por
atualização de localização.

### Mapa e staleness

`react-native-maps` (arquivo `.native.tsx`; placeholder na web) mostra a
posição mais recente, o círculo da precisão ("Precisão aproximada: 12 m") e a
trilha recente limitada. Centraliza no primeiro ponto e depois só quando o
usuário toca em CENTRALIZAR. Sem geocoding reverso, POIs ou dados externos.
Posição sem update há mais de 30 s é marcada como "Sem atualização recente",
sempre com "Última atualização há X s" — nunca um ponto antigo como atual.
O criador vê "Seu grupo pode ver sua localização enquanto o compartilhamento
estiver ativo." e PARAR LOCALIZAÇÃO AO VIVO com confirmação.

### Retenção e cleanup

Política: **30 dias após o encerramento do alerta**. `deleteExpiredLocationData`
apaga pontos ao vivo, sessões e a localização inicial (Phase 3) de alertas
RESOLVED/CANCELLED há mais de 30 dias — nunca alertas, grupos, usuários ou
respostas. Comando `pnpm location:cleanup` (sem scheduler distribuído); em
produção deve rodar periodicamente (ex.: cron diário).

### Privacidade e logs

Logger redige `req.body.latitude/longitude/accuracy/altitude/heading/speed`;
respostas de erro não ecoam coordenadas; testes usam apenas coordenadas
sintéticas; eventos realtime e respostas nunca trazem e-mail, tokens ou
localização de outro alerta/grupo.

## Limitações reais

- **Apenas primeiro plano.** Background location (expo-task-manager,
  foreground service Android, background modes iOS) **não foi implementado**:
  exige build nativo, consentimento e indicadores do sistema que não podem ser
  validados neste ambiente. Em background o SO pode suspender o watcher; ao
  voltar ao primeiro plano o app ressincroniza e retoma. A UI informa: "O
  compartilhamento funciona com o SafeCircle aberto."
- `react-native-maps` no Android em builds de produção exige uma chave do
  Google Maps (`expo.android.config.googleMaps.apiKey`) — não versionada nem
  inventada; iOS usa Apple Maps. Web mostra placeholder.
- Retenção depende de execução periódica do comando de cleanup.

## Alternativas consideradas

- **Ativar automaticamente com o SOS**: rejeitado — viola opt-in explícito.
- **Coordenadas no evento realtime**: rejeitado — o socket propagaria dado
  sensível a qualquer conexão do grupo sem passar pela leitura autorizada REST.
- **Fila completa de pontos offline**: rejeitado — despejar histórico antigo
  ao reconectar é inútil e enganoso; só o ponto mais recente importa.
- **Background com expo-task-manager nesta fase**: adiado — sem validação em
  dispositivo real seria fingir suporte.
- **Apagar dados na hora do encerramento**: rejeitado — 30 dias permitem
  revisão do incidente; depois, apagamos.

## Consequências

Positivas: quem ajuda vê a posição atual do criador com precisão honesta;
todo o controle (ligar/parar) é do criador; dados sensíveis são restritos,
validados, limitados em frequência e apagados por política.

Negativas: sem background, o compartilhamento depende do app aberto; a
instância única do realtime (ADR 0006) também se aplica a estes eventos.
