# ADR 0011 — Outbox Transacional, Workers e Entregas Confiáveis

## Status

Aceito — Phase 10 (Outbox Transacional, Workers e Entregas Confiáveis). Segunda
fase do bloco de Production Readiness. **Nenhuma mudança de contrato HTTP nem
de semântica de produto**: o que muda é como os efeitos saem do commit.

## Contexto

Até a Phase 9, um efeito (push, realtime, auditoria) acontecia depois do commit,
em uma tarefa em memória:

```
BEGIN; INSERT alerta; COMMIT;      →      app.background.run(enviar push)
                                   ↑
                          janela de perda
```

Se o processo caísse, fosse reiniciado ou perdesse o deploy nessa janela, o
alerta existia no banco e **a notificação nunca saía**. Ninguém era avisado, e
não sobrava rastro de que algo deixou de acontecer. A Phase 9 documentou isso
como limitação conhecida e apontou a outbox como a correção.

Num app de segurança pessoal essa janela é a pior falha possível: o pedido de
ajuda foi registrado e o grupo não ficou sabendo. A mesma janela também
produzia buracos na trilha de auditoria — justamente o registro que existe para
reconstruir incidentes.

A tensão desta fase:

```
entregar sempre  ≠  entregar exatamente uma vez
```

Escolhemos entregar sempre.

## Decisão

### 1. Outbox transacional

Toda mudança de domínio grava seus efeitos na tabela `outbox_events` **dentro da
mesma transação**:

```
BEGIN;
  INSERT INTO alerts ...;
  INSERT INTO outbox_events ('PUSH_ALERT_CREATED');
  INSERT INTO outbox_events ('REALTIME_ALERT_CREATED');
  INSERT INTO outbox_events ('AUDIT_ALERT_CREATED');
COMMIT;
```

Ou o alerta e seus efeitos existem, ou nenhum dos dois existe. Não há mais
estado intermediário observável.

A invariante é sustentada pelo tipo, não pela disciplina de quem escreve o
código: `enqueueOutboxEvent` **exige** o cliente de transação (`tx`) e não aceita
o handle normal do banco. O padrão errado (commit e depois enfileirar) deixou de
ser expressável.

O conjunto de efeitos de cada transição vive em um arquivo único
(`src/outbox/effects.ts`), para que adicionar uma transição nova e esquecer o
push, o realtime ou a auditoria deixe de ser um erro fácil de cometer.

### 2. Worker persistente

Um worker lê a tabela em ciclo:

1. **Claim** em transação curta, com `FOR UPDATE SKIP LOCKED`.
2. **Handler** executado **fora** da transação — nunca seguramos lock durante
   chamada à Expo ou publicação no hub.
3. **Conclusão** persistida: `PROCESSED`, retry agendado, `DEAD` ou expirado.

`SKIP LOCKED` é o que torna seguro rodar várias instâncias sobre a mesma fila:
quem já está travado por outra transação é pulado, sem espera e sem duplicidade.

O worker roda no processo da API **nesta fase**, mas não conhece Fastify: toda a
durabilidade está no PostgreSQL. Movê-lo para um processo separado é trocar quem
chama `start()`.

### 3. Lease e recuperação

Um evento reivindicado fica `PROCESSING` com `locked_at` e `locked_by`. Se o
worker morrer no meio, ninguém desfaz esse estado — por isso o claim também
considera candidatos os `PROCESSING` cujo `locked_at` é mais antigo que o lease
(padrão 60s). Trabalho de worker morto volta para a fila sozinho, sem
intervenção de plantão.

### 4. Retry com backoff exponencial e jitter

Falha transitória volta para `PENDING` com `available_at` no futuro:

```
espera = min(15min, 5s × 2^(tentativa-1)) ± 20%
```

O jitter não é enfeite: sem ele, mil eventos que falharam juntos (provedor fora
do ar) voltariam exatamente juntos e derrubariam o provedor de novo assim que
ele se recuperasse.

O agendamento é uma coluna no banco, não um `setTimeout`: o retry sobrevive a
restart, deploy e queda.

### 5. Dead letter

Ao atingir `max_attempts`, o evento vira `DEAD`, para de ser reivindicado e fica
visível para o plantão. Falha **permanente** (payload inválido, versão
desconhecida, tipo desconhecido) vai direto para `DEAD` na primeira tentativa:
reprocessar para sempre algo que nunca vai funcionar só entope a fila.

`last_error_code` é um **código curto de conjunto fechado**
(`PUSH_PROVIDER_FAILED`, `PAYLOAD_INVALID`, …). Nunca stack trace, nunca
resposta bruta do provedor.

### 6. Políticas por família

| Família  | Tentativas | Expiração | Razão                                                 |
| -------- | ---------- | --------- | ----------------------------------------------------- |
| push     | 8          | 20 min    | Um SOS entregue uma hora depois assusta sem ajudar    |
| realtime | 3          | 5 min     | Acelerador de UX; o REST é a fonte de verdade         |
| audit    | 12         | nunca     | Perder trilha de auditoria é o pior desfecho possível |

Evento expirado é **encerrado sem executar o efeito**. Isso não é falha: é a
decisão deliberada de não entregar notificação velha depois de um outage.

### 7. Entrega at-least-once

O sistema entrega **pelo menos uma vez**. Não entrega exatamente uma vez, e não
fingimos que entrega.

A janela é real: se o processo cair entre o provedor aceitar a mensagem e o
`UPDATE` que marca `PROCESSED`, o evento é reprocessado e o push pode chegar
duas vezes. Fechar essa janela exigiria commit distribuído entre o PostgreSQL e
a Expo, o que não existe.

Preferimos duplicar a perder um pedido de ajuda. As consequências práticas:

- **Auditoria**: `audit_events.source_outbox_event_id` é UNIQUE e a inserção usa
  `ON CONFLICT DO NOTHING`. Reprocessar não cria segunda linha.
- **Realtime**: o `eventId` publicado é o id do evento da outbox, **estável entre
  tentativas**. Gerar um id novo a cada retry tornaria a duplicata invisível
  para o app; assim o cliente consegue deduplicar.
- **Push**: pode duplicar. A expiração de 20 minutos limita o estrago, e uma
  notificação repetida de emergência é um incômodo aceitável.

Sucesso parcial de um lote de push **conclui** o evento: reenviar o lote inteiro
por causa de um token que falhou duplicaria a notificação de todo mundo que já
recebeu. Só falha total (`sent == 0 && failed > 0`) vira retry.

### 8. Destinatários resolvidos na entrega

O payload guarda apenas IDs; os tokens de push são carregados no momento do
envio. Quem saiu do grupo entre o commit e a entrega não recebe, e quem entrou
recebe. É também o que mantém push token fora de uma tabela durável.

### 9. Privacidade do que fica gravado

A outbox é durável: o que entra nela fica. O payload carrega **apenas IDs,
flags e metadata allow-listed**. Nunca coordenada, push token, senha, token de
acesso ou refresh, header `Authorization`, endereço, corpo de requisição ou
resposta bruta de provedor.

### 10. Schedulers

Os schedulers de check-in e trajeto deixaram de disparar push e realtime
diretamente. Eles executam a transição de domínio, que enfileira seus efeitos na
mesma transação — o vencimento passou a ter a mesma garantia de entrega do resto
do sistema.

### 11. Operação por CLI, não por HTTP

Reprocessar efeito é ação de plantão, com acesso ao servidor. Não existe
endpoint HTTP de replay: seria uma superfície de abuso desproporcional ao ganho.

```
pnpm outbox:status
pnpm outbox:list-dead
pnpm outbox:retry-dead -- --id <uuid>
pnpm outbox:cleanup
```

`retry-dead` só aceita evento `DEAD` — reenfileirar algo `PENDING` ou
`PROCESSING` criaria processamento concorrente do mesmo efeito. O payload **não
é editável**: a CLI reprocessa o que foi gravado, não reescreve histórico.

### 12. Retenção

`PROCESSED` é apagado após 30 dias, `DEAD` após 90. `PENDING` e `PROCESSING`
**nunca** são apagados — apagar trabalho pendente é perder exatamente o que esta
tabela existe para proteger.

## Alternativas consideradas

- **Redis / Kafka / RabbitMQ / SQS / NATS / Temporal / BullMQ**: rejeitado. Toda
  fila externa reintroduz a janela que a fase existe para fechar (o commit no
  PostgreSQL e o envio para o broker não são atômicos) e adiciona um
  componente com disponibilidade própria. O PostgreSQL que já guarda o domínio
  resolve o problema com `SKIP LOCKED`.
- **Event sourcing / CQRS / saga**: rejeitado. Reescreveria o modelo de domínio
  inteiro para resolver um problema de entrega de efeitos.
- **Confirmar a entrega antes de responder ao cliente**: rejeitado. Somaria a
  latência da Expo ao SOS e faria uma indisponibilidade do provedor derrubar o
  pedido de ajuda.
- **Exactly-once com deduplicação no provedor**: rejeitado porque não existe. O
  honesto é documentar at-least-once e tornar os efeitos idempotentes onde dá.
- **Endpoint HTTP de replay**: rejeitado (superfície de abuso).
- **Apagar evento da outbox ao processar**: rejeitado. Manter o histórico por um
  tempo é o que permite investigar "esse push saiu?" depois do incidente.
- **`SELECT ... FOR UPDATE` sem `SKIP LOCKED`**: rejeitado; workers ficariam em
  fila esperando uns aos outros, e a vazão cairia para a de um worker só.
- **Retry em memória (`setTimeout`)**: rejeitado; é a própria janela de perda,
  com outro nome.

## Consequências

Positivas: a janela de perda pós-commit deixou de existir; a trilha de auditoria
não tem mais buracos; retry e dead-letter são estado no banco, inspecionável e
operável; vários workers podem rodar sobre a mesma fila; o caminho de resposta
HTTP ficou mais curto, porque nenhuma rota espera provedor externo.

Negativas: uma tabela nova com escrita em toda transição (custo de I/O por ação
de domínio); latência de entrega passou a depender do intervalo de polling
(padrão 500 ms) em vez de ser imediata; duplicação de push virou um cenário
esperado, não um bug; mais superfície de configuração (`OUTBOX_*`) e mais um
comando de retenção; e o worker no processo da API ainda acopla capacidade de
entrega à capacidade de servir requisições.

## Limitações conhecidas

- **At-least-once**, não exactly-once. Push pode chegar duas vezes.
- **Worker no mesmo processo da API** nesta fase: um pico de tráfego concorre
  com a entrega de efeitos.
- **Ordem não garantida** entre eventos: o claim ordena por `available_at`, mas
  concorrência e retry podem inverter a ordem de entrega. Nenhum efeito atual
  depende de ordem.
- **Sem alerting automático** sobre backlog ou dead-letter: os sinais existem em
  `/metrics`, a regra de alerta é externa.
- **Expiração descarta silenciosamente** (com métrica e log, sem notificar
  ninguém): é o comportamento desejado, mas exige olhar a métrica para perceber
  um outage longo.
