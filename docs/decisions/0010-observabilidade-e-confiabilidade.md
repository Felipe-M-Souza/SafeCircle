# ADR 0010 — Observabilidade e Confiabilidade

## Status

Aceito — Phase 9 (Observabilidade e Confiabilidade). Primeira fase do bloco de
Production Readiness: **nenhuma mudança de semântica** nos fluxos de SOS,
check-in, trajeto, push ou realtime.

## Contexto

Até a Phase 8 o SafeCircle ganhou funcionalidade; o que faltava era conseguir
**operar** o sistema: descobrir por que uma requisição falhou, saber se uma
instância pode receber tráfego, perceber que o push parou, investigar um
incidente de segurança e responder a um usuário que diz "deu erro".

Um app de segurança pessoal torna isso mais crítico: uma falha silenciosa pode
significar alguém sem conseguir pedir ajuda. Ao mesmo tempo, é exatamente o
tipo de produto em que instrumentação descuidada vaza o que há de mais sensível
— localização, tokens, credenciais.

A tensão central desta fase:

```
mais contexto operacional  ≠  mais dados pessoais
```

Toda decisão abaixo resolve essa tensão a favor da privacidade.

## Decisão

### Request ID

Toda requisição recebe um `requestId` UUID (`genReqId` do Fastify). O cliente
**pode** propagar o seu via `X-Request-Id`, mas apenas se for **UUID válido**;
qualquer outro valor é descartado e um novo é gerado.

Por que a validação estrita: o header é entrada não confiável. Aceitar string
arbitrária permitiria log injection (quebra de linha forjando entradas falsas),
sequências ANSI em terminais de plantão, valores gigantes inflando o log e
cardinalidade descontrolada em índices. O custo de recusar é zero — geramos um
id melhor.

A resposta **sempre** devolve `X-Request-Id`, inclusive em erro.

### Error ID

Falhas internas inesperadas (500) recebem também um `errorId` UUID, presente no
corpo e no log. O corpo de erro ficou:

```json
{
  "code": "INTERNAL_ERROR",
  "message": "Erro interno.",
  "requestId": "...",
  "errorId": "..."
}
```

Nunca stack trace, nome de arquivo ou mensagem do PostgreSQL. O app mostra o
`errorId` como **"Código de suporte"** — é o que transforma "deu erro" em uma
ocorrência investigável.

Consequência de contrato: **todas** as respostas de erro passaram a incluir
`requestId`. Os testes anti-IDOR que comparavam corpos inteiros foram ajustados
para comparar `code` + `message` (a garantia real: "não é seu" e "não existe"
continuam indistinguíveis).

### Logs estruturados e severidade honesta

Pino com eventos nomeados (`event: "push_dispatch_failed"`), não strings
soltas. Correlação automática em um único lugar: o plugin de observabilidade
injeta `requestId`, `method` e `route` (template) em `request.log`, e o
`app.authenticate` acrescenta `userId` — nenhuma rota repete isso.

O log de conclusão do Fastify foi substituído pelo evento
`http_request_completed` (com `statusCode`, `durationMs`, `userId`), via
`logController` — a API não depreciada do Fastify 5.

Severidade:

| Situação                                         | Nível   |
| ------------------------------------------------ | ------- |
| Erro de domínio esperado (404 anti-IDOR, 409...) | `debug` |
| Validação, 401                                   | `debug` |
| Rate limit                                       | `warn`  |
| Requisição concluída                             | `info`  |
| Envio de localização ao vivo (alta frequência)   | `debug` |
| 5xx e falhas de subsistema                       | `error` |

Registrar todo 4xx como `error` destruiria o sinal: erro precisa significar
"alguém deve olhar". Do mesmo modo, um ponto de GPS a cada poucos segundos não
é evento de `info`.

### Redaction centralizada

Uma lista única (`REDACTED_LOG_PATHS`) aplicada ao logger, cobrindo
`authorization`, `cookie`, `idempotency-key`, senha/hash, access/refresh token,
push token e todos os campos de localização (`latitude`, `longitude`,
`accuracy`, `altitude`, `heading`, `speed`, `location`) — inclusive em
caminhos aninhados. É allow-list de comportamento com deny-list de caminhos,
verificada por testes que ligam o logger real e inspecionam a saída.

### Liveness x readiness

- `GET /health`: liveness. **Não** consulta o banco. Derrubar containers porque
  o PostgreSQL piscou é pior do que esperar a reconexão.
- `GET /ready`: readiness. Verifica inicialização e banco (`select 1` com
  timeout de 1,5 s). Falha → `503` e a instância sai do balanceador.

Dependências externas não-críticas (provedor de push) **não** tornam a API
not-ready: o push é assíncrono e degradado; o resto continua útil — inclusive o
SOS.

A resposta lista apenas `{ name, status }` por verificação. Nunca connection
string, host, credencial ou mensagem do driver.

### Métricas Prometheus

`prom-client` com um **único registry** no processo. Todas as métricas
customizadas usam o prefixo `safecircle_`, inclusive as de processo (CPU,
memória, event loop, GC), habilitadas via `collectDefaultMetrics`.

Cobertura: HTTP (total, duração, in-flight), realtime (conexões, desconexões
por motivo, eventos publicados, falhas), tarefas em segundo plano (iniciadas,
concluídas, falhas, duração, pendentes), push (lotes, mensagens, tokens
inválidos, falhas, duração), schedulers (execuções, duração, itens, falhas),
domínio (transições de alerta/check-in/trajeto, pontos de localização) e
auditoria (eventos, falhas).

### Baixa cardinalidade como invariante

**Nenhum** label carrega `userId`, `groupId`, `alertId`, `checkinId`,
`journeyId`, `requestId`, `errorId`, token ou URL com UUID. Labels vêm de
conjuntos controlados no código; a rota é sempre o **template** do Fastify
(`/journeys/:journeyId`), e requisições sem rota casada viram `unmatched`.

A defesa é de runtime, não só de convenção: `safeLabel()` rejeita UUID,
caracteres fora de um alfabeto restrito e valores longos, caindo em `other`.
Um teste varre **todas** as séries do registry e falha se qualquer label contiver
UUID ou nome proibido — porque cardinalidade explosiva derruba o coletor em
produção, não em revisão de código.

### Proteção do /metrics

| `METRICS_ENABLED` | `METRICS_TOKEN` | Comportamento                     |
| ----------------- | --------------- | --------------------------------- |
| `false` (padrão)  | —               | A rota **não existe** → 404       |
| `true`            | definido        | Exige `Bearer`; errado → 401      |
| `true`            | vazio           | Aberto (só atrás de rede privada) |

Desabilitado por padrão e respondendo 404 (em vez de 401), uma varredura nem
confirma que há métricas ali. A comparação do token é em tempo constante
(`timingSafeEqual`) e o header `Authorization` é redigido do log.

### Auditoria persistente

Tabela `audit_events` (migration `0008_audit_events`): `eventType`,
`actorUserId` (nulo em eventos do sistema), `targetType`, `targetId`, `groupId`,
`outcome`, `requestId`, `metadata` (jsonb), `createdAt`.

Não é event sourcing e não reconstrói estado: é a trilha mínima para segurança,
investigação e suporte. Escopo inicial: autenticação (login ok/falha, logout),
grupos (criação, remoção de membro, mudança de papel), alertas (criação,
resolução, cancelamento), localização ao vivo (início/parada), check-ins e
trajetos (criação, confirmação, cancelamento, vencimento). GETs de rotina não
geram trilha.

Três decisões que merecem registro:

1. **Metadata é allow-list**, não deny-list (`ALLOWED_METADATA_KEYS`). Uma
   deny-list esquece o próximo campo sensível que alguém adicionar. Valores
   passam ainda por `safeLabel` e limite de tamanho. Nunca body completo,
   senha, token, coordenada, endereço ou resposta bruta de provedor. Um trajeto
   audita `hasDestination: true`, jamais o rótulo do destino.
2. **Sem IP nem User-Agent** nesta fase (anti-fingerprinting). Se vierem a ser
   necessários para investigação de abuso, entram com política de retenção
   própria e justificativa explícita.
3. **`ON DELETE SET NULL`** em `actorUserId`/`groupId`: apagar um usuário ou
   grupo não pode apagar a trilha. `targetId` é propositalmente sem FK — o
   recurso citado pode já ter sido removido pela retenção do domínio.

A escrita roda em segundo plano (`app.audit`), então nem o SOS espera pelo
INSERT. **Falha de auditoria não desfaz a operação de negócio**: é logada
(`audit_write_failed`) e contabilizada (`safecircle_audit_failures_total`).
Limitação aceita conscientemente — sem outbox, um evento pode faltar na trilha.

### Retenção

| Dado                   | Retenção | Comando                 |
| ---------------------- | -------- | ----------------------- |
| Localização de alerta  | 30 dias  | `pnpm location:cleanup` |
| Check-in finalizado    | 90 dias  | `pnpm checkin:cleanup`  |
| Localização de trajeto | 30 dias  | `pnpm journey:cleanup`  |
| Trajeto finalizado     | 90 dias  | `pnpm journey:cleanup`  |
| Evento de auditoria    | 180 dias | `pnpm audit:cleanup`    |

A auditoria dura mais que o domínio de propósito: uma investigação costuma
começar depois que o incidente já saiu da tela. `audit:cleanup` toca **apenas**
`audit_events`.

### Encerramento e inicialização observáveis

Eventos `application_starting`, `application_ready`, `shutdown_started`,
`shutdown_completed`, `shutdown_timeout`, com dados seguros (`environment`,
`APP_VERSION`, `GIT_SHA`, porta). Ordem do shutdown, garantida pelos hooks
`onClose`: schedulers param → WebSockets fecham → tarefas em segundo plano são
aguardadas (10 s) → pool do banco fecha. Limite total de 15 s; estourado, o
processo sai com código 1 após registrar `shutdown_timeout`.

### Mobile

- `ApiError` passou a carregar `requestId` e `errorId` (aceitos só como strings
  curtas — o corpo é entrada externa), com `supportCode` preferindo o `errorId`.
- `translateApiError()` centraliza a tradução: erros **esperados** mostram só a
  mensagem; falhas **inesperadas** (5xx) acrescentam "Código de suporte: ...".
  Substituiu 30 repetições do mesmo ternário espalhadas pelas telas.
- **Error Boundary global**: falha de render vira mensagem sóbria com
  "TENTAR NOVAMENTE" e o código de suporte, nunca tela branca nem stack.
- Detalhes técnicos só no console em `__DEV__`. Sem analytics, sem telemetria
  automática.

## Limitações reais

- **Sem durabilidade forte** para efeitos assíncronos: push, realtime e
  auditoria vivem no processo. Se a API morrer antes de concluí-los, não há
  retry (mesma limitação dos ADRs 0005/0008).
- **Instância única** para scheduler e hub realtime (ADRs 0006, 0008, 0009).
- **Sem tracing distribuído**, APM, dashboards hospedados ou alerting externo.
  A correlação é por `requestId` no log; as métricas são expostas para coleta.
- **Métricas em memória**: reiniciar zera contadores (comportamento normal de
  Prometheus, mas vale lembrar ao ler um gráfico).
- **Sem leitura administrativa da auditoria**: não há `GET /audit` nem
  `POST /audit`. Consulta é via banco, por quem tem acesso — expor isso exige
  uma arquitetura de admin com autorização própria.
- Métricas de processo dependem do runtime suportar (Node: sim).

## Alternativas consideradas

- **Confiar no `X-Request-Id` do cliente como veio**: rejeitado (log injection,
  cardinalidade, valores gigantes).
- **Logar todo 4xx como `error`**: rejeitado; destrói o sinal de erro real.
- **`/metrics` aberto por padrão**: rejeitado; expõe topologia e volume a quem
  achar a porta. Padrão é não existir.
- **Labels com IDs "só para debugar"**: rejeitado; é o caminho clássico para
  derrubar o coletor. Investigação por ID é trabalho de log, não de métrica.
- **Auditoria síncrona na transação de negócio**: rejeitado nesta fase; somaria
  latência ao SOS e faria uma falha de auditoria derrubar um pedido de ajuda.
  A alternativa correta (outbox transacional) fica para a Phase 10.
- **Sentry/Datadog/OpenTelemetry**: adiado. A Phase 9 precisa funcionar no CI
  sem nenhuma dependência externa; a instrumentação atual é o pré-requisito
  para plugar qualquer um deles depois.
- **Persistir IP/User-Agent na auditoria**: rejeitado por padrão
  (fingerprinting) — entra só com necessidade demonstrada.

## Consequências

Positivas: um erro relatado vira uma linha de log localizável em segundos; a
instância diz honestamente se pode receber tráfego; push, scheduler, realtime e
tarefas em segundo plano têm sinal numérico; ações críticas deixam trilha; o
encerramento não perde trabalho silenciosamente; e nada disso custou um campo
sensível a mais em log, métrica ou banco.

Negativas: mais superfície de configuração (`METRICS_ENABLED`, `METRICS_TOKEN`,
`APP_VERSION`, `GIT_SHA`); mais um cron (`audit:cleanup`); o corpo de erro
cresceu com `requestId` (contrato aditivo, mas contrato); e a trilha de
auditoria pode ter buracos enquanto não houver outbox.

## Evolução para a Phase 10

1. **Outbox transacional** para push, realtime e auditoria — elimina a perda de
   efeitos e fecha o buraco da trilha.
2. **Worker externo** consumindo o outbox; o scheduler sai do processo da API e
   a limitação de instância única cai.
3. **Tracing distribuído** (OpenTelemetry) reaproveitando o `requestId` já
   propagado como correlação.
4. **Leitura administrativa da auditoria** com autorização própria e trilha do
   próprio acesso.
5. **Alerting** externo a partir dos sinais já documentados no runbook.
