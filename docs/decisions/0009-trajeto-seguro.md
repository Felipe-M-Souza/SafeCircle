# ADR 0009 — Trajeto Seguro

## Status

Aceito — Phase 8 (Trajeto Seguro). É a última fase funcional do roadmap
original. Scheduler em **instância única** e localização ao vivo apenas em
**primeiro plano** (ver "Limitações reais").

## Contexto

O SafeCircle reage a um pedido explícito de ajuda (SOS, Phase 3) e a um
compromisso de confirmar que se está bem até um horário (check-in, Phase 7).
Falta o caso do deslocamento: a pessoa avisa que está a caminho de um lugar e
quer que o grupo seja avisado se ela não confirmar a chegada no prazo — uma
volta para casa à noite, um encontro com desconhecido, uma viagem curta.

A Phase 8 adiciona o **trajeto seguro**: "iniciei um trajeto para <destino>;
se eu não confirmar a chegada até X, avise meu grupo". Opcionalmente, o
usuário compartilha a localização ao vivo durante o trajeto, reutilizando a
infraestrutura da Phase 6.

Como no check-in, o recurso é honesto: um trajeto atrasado significa apenas
que **o prazo passou sem confirmação**, não que a pessoa está em perigo. O
servidor é o relógio autoritativo, e o vencimento precisa acontecer sem
requisição do usuário — com a mesma arquitetura de scheduler da Phase 7.

## Decisão

### Finalidade e linguagem

- O trajeto é criado pelo próprio usuário, para **um grupo** de que é membro,
  com um destino textual opcional e uma chegada prevista (`expectedArrivalAt`).
- Ao vencer, app e push dizem "Trajeto não confirmado" / "Um membro do seu
  grupo não confirmou a chegada no prazo esperado." Para o dono: "O prazo
  esperado passou sem confirmação. Isso não confirma uma emergência." Para
  membros: "O prazo de chegada de <nome> passou sem confirmação. Isso não
  confirma uma emergência. Tente entrar em contato de forma segura." Nunca "a
  pessoa está em perigo".
- Trajeto atrasado **não** cria `EmergencyAlert`, **não** liga SOS e **não**
  dispara SMS/WhatsApp/e-mail. O membro decide o que fazer.

### Estados e transições

Tabela `safe_journeys` com enum `journey_status`:

| De        | Para        | Quem                      | Endpoint / mecanismo         |
| --------- | ----------- | ------------------------- | ---------------------------- |
| —         | `ACTIVE`    | dono                      | `POST /journeys`             |
| `ACTIVE`  | `ARRIVED`   | dono                      | `POST /journeys/:id/arrive`  |
| `ACTIVE`  | `CANCELLED` | dono                      | `POST /journeys/:id/cancel`  |
| `ACTIVE`  | `OVERDUE`   | servidor                  | `JourneyScheduler.runOnce()` |
| `OVERDUE` | `ARRIVED`   | dono (confirmação tardia) | `POST /journeys/:id/arrive`  |
| `OVERDUE` | `CANCELLED` | dono                      | `POST /journeys/:id/cancel`  |

Qualquer outra transição responde `409 INVALID_JOURNEY_TRANSITION`. Repetir
`arrive` sobre `ARRIVED` ou `cancel` sobre `CANCELLED` é idempotente. Membros
que tentam `arrive`/`cancel` recebem `403 FORBIDDEN`; quem não pertence ao
grupo recebe `404 JOURNEY_NOT_FOUND` (anti-IDOR). Cada transição registra seu
carimbo (`arrived_at`, `cancelled_at`, `overdue_at`).

### Um trajeto não-finalizado por usuário

Índice único parcial `safe_journeys_unfinished_per_user_unique (user_id)
WHERE status in ('ACTIVE','OVERDUE')`. A regra é garantida pelo banco:
criações concorrentes resultam em uma linha e um `409 JOURNEY_ALREADY_ACTIVE`
para a outra. Diferente do check-in (um por usuário/grupo), o trajeto é **um
por usuário** — a pessoa faz um deslocamento de cada vez.

### Destino textual

`destinationLabel` é opcional, com trim, texto simples e limite de 120
caracteres. Sem coordenada obrigatória, sem geocoding, sem armazenar endereço
exato desnecessariamente.

### Chegada prevista e relógio autoritativo

O cliente envia `expectedArrivalAt` em ISO 8601; o servidor valida contra **o
próprio relógio**: mínimo 10 minutos e máximo 24 horas a partir de `now()`
(`400 INVALID_JOURNEY_EXPECTED_ARRIVAL`). O app calcula o horário apenas para
exibir e enviar; não há como adiantar o vencimento pelo relógio do aparelho.

### Idempotência de criação

`POST /journeys` reutiliza a infraestrutura de `Idempotency-Key` (tabela
`idempotency_keys`, escopo `journeys.create`, hash do corpo). Chave e trajeto
são inseridos na mesma transação; repetição da chave devolve o mesmo trajeto
(200, `replayed`) sem republicar `JOURNEY_CREATED`; mesma chave com corpo
diferente → `409 IDEMPOTENCY_KEY_REUSED`; ausente/inválida → `400`.

### Scheduler de atraso

`JourneyScheduler` reutiliza o **mesmo motor** genérico (`OverdueScheduler`)
introduzido na Phase 7 — o mesmo lifecycle Fastify (`onReady`/`onClose`),
polling a cada 15 s, lotes de 100, e o mesmo `UPDATE` condicional:

```sql
UPDATE safe_journeys
   SET status = 'OVERDUE', overdue_at = now(), updated_at = now()
 WHERE id IN (SELECT id FROM safe_journeys
               WHERE status = 'ACTIVE' AND expected_arrival_at <= now() LIMIT 100)
   AND status = 'ACTIVE' AND expected_arrival_at <= now()
RETURNING id, user_id, group_id;
```

A cláusula é reavaliada após o lock de linha, então execuções concorrentes
nunca vencem o mesmo trajeto duas vezes — só quem alterou a linha dispara os
efeitos. Diferente do check-in, o vencimento **não encerra** a localização ao
vivo: enquanto o trajeto não for finalizado (ARRIVED/CANCELLED) o
compartilhamento continua.

### Notificações e realtime

- Eventos realtime (envelope da Phase 5, `version: 1`): `JOURNEY_CREATED`,
  `JOURNEY_ARRIVED`, `JOURNEY_CANCELLED`, `JOURNEY_OVERDUE` e
  `JOURNEY_LOCATION_UPDATED`, todos com `{ journeyId, groupId, userId }` —
  apenas IDs. O evento de localização **nunca** carrega coordenadas; o app
  rebusca via REST.
- Push apenas no vencimento, para os membros do grupo **exceto o dono**
  (`data.type = "SAFE_JOURNEY_OVERDUE"`, `journeyId`, `groupId`; canal
  `emergency`). Reaproveita `dispatchPush` da Phase 4/7. O toque abre o
  detalhe do trajeto e mostra o **estado atual** do servidor.

### Localização ao vivo do trajeto (opt-in)

`liveLocationEnabled` é opt-in explícito na criação (default `false`). Quando
ligado, o dono pode iniciar/enviar/parar pontos:

```http
POST /journeys/:id/live-location/start
POST /journeys/:id/live-location
POST /journeys/:id/live-location/stop
GET  /journeys/:id/live-location
GET  /journeys/:id/live-location/history
```

- **Tabelas próprias** `journey_location_sessions` e
  `journey_location_updates` — nunca as de alerta (Phase 6).
- Mesmas garantias da Phase 6: só o dono envia; membros atuais leem; validação
  de coordenadas; throttling server-side (~1 ponto a cada 2 s); `clientUpdateId`
  para retry idempotente; sem coordenadas em logs; histórico limitado;
  anti-IDOR.
- O compartilhamento vale enquanto o trajeto está **em andamento** (ACTIVE ou
  OVERDUE). Ao confirmar a chegada ou cancelar, a sessão é encerrada **na mesma
  transação** da transição (o watcher local para imediatamente).
- No mobile, um único sistema de GPS: o `LiveLocationController` da Phase 6 foi
  generalizado para um `LiveLocationTransport` (alerta ou trajeto), reutilizando
  permissão, watcher e uploader sem duplicar código nem quebrar o alerta.

### Mobile: contador visual, não decisão

- A Home mostra a seção "Trajeto seguro" com o trajeto ativo/vencido, destino,
  chegada prevista, contador ("Faltam 34 min"), CHEGUEI EM SEGURANÇA, CANCELAR
  TRAJETO (com confirmação) e INICIAR TRAJETO.
- "Novo trajeto": grupo, destino opcional, prazo (30/60/120 min ou
  personalizado 10–1440), checkbox de compartilhamento e uma confirmação
  honesta antes de criar ("Seu grupo será avisado se você não confirmar a
  chegada até HH:MM").
- Quando o contador zera, o app exibe "Prazo encerrado. Aguardando confirmação
  do servidor..." e **consulta o backend** — nunca marca OVERDUE localmente.
- Mapa (`react-native-maps`) com a posição mais recente, precisão e indicação
  de desatualização (stale após ~30 s); sem localização, "Localização não
  compartilhada neste trajeto.".

### Privacidade e segurança

- Todos os endpoints exigem JWT; leitura restrita ao dono e membros atuais;
  ex-membros e externos recebem 404.
- Payloads de push e realtime não carregam nome, coordenadas ou mensagens.
- Nenhum log registra coordenadas ou tokens; apenas IDs internos e contagens.
- `POST /journeys` tem limite de 20 requisições/minuto por usuário.

### Retenção

- Localização do trajeto: apagada 30 dias após o encerramento (ARRIVED/
  CANCELLED), reutilizando a política da Phase 6.
- Trajeto finalizado: apagado 90 dias após o encerramento (`coalesce(arrived_at,
cancelled_at, overdue_at, updated_at)`). Nunca apaga ACTIVE nem OVERDUE em
  aberto. Comando `pnpm journey:cleanup`; deve rodar periodicamente em produção.

## Limitações reais

- **Instância única do scheduler** (mesma limitação da Phase 7): com várias
  réplicas cada uma faz polling, mas o `UPDATE` condicional garante efeito
  único por trajeto.
- **Localização ao vivo apenas em primeiro plano** (mesma limitação da Phase 6,
  ADR 0007): em segundo plano o SO pode suspender o watcher; a posição é
  retomada ao voltar ao app. Não há background location.
- Precisão do vencimento de até ~15 s (intervalo de polling).
- Sem navegação turn-by-turn, rota calculada, ETA dinâmico, geofence, detecção
  automática de chegada, criação automática de SOS, SMS/WhatsApp/e-mail, links
  públicos ou compartilhamento externo — fora do escopo.

## Alternativas consideradas

- **Reusar as tabelas de localização do alerta** (`alert_location_*`):
  rejeitado; acoplaria trajeto e alerta por `alertId` e confundiria retenção e
  acesso. Tabelas próprias mantêm os domínios separados.
- **Um segundo controller de GPS no mobile**: rejeitado; o sistema de GPS é o
  mesmo. Generalizou-se o controller via transporte, sem duplicar.
- **Um segundo scheduler independente**: evitado; o `OverdueScheduler` genérico
  serve check-ins e trajetos com o mesmo lifecycle e as mesmas garantias.
- **Escalar automaticamente para SOS ao vencer**: rejeitado; falso positivo
  frequente e contrário à linguagem honesta do produto.
- **Fila/worker distribuído (Redis, BullMQ, SQS, `pg_cron`)**: adiado, como na
  Phase 7. Evolução natural quando houver múltiplas réplicas.

## Consequências

Positivas: o grupo é avisado mesmo com o app fechado; o estado é único e
consistente (banco como fonte de verdade); a regra "um em andamento por
usuário" e as transições são garantidas pelo banco; a linguagem evita alarme
falso; a localização reaproveita a infraestrutura segura da Phase 6 sem
duplicação.

Negativas: mais um processo periódico dentro da API (instância única);
latência de até 15 s no vencimento; a retenção depende de um cron externo,
como as das Phases 6 e 7; a localização segue limitada a primeiro plano.
