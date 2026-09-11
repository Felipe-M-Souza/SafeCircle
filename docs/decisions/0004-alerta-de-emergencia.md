# ADR 0004 — Alerta de Emergência

## Status

Aceito — Phase 3 (Alerta de Emergência).

## Contexto

O SafeCircle existe para que uma pessoa peça ajuda rapidamente à sua rede
privada de confiança. A Phase 3 introduz o primeiro fluxo real de segurança:
um usuário autenticado escolhe um grupo de confiança (Phase 2), aciona
intencionalmente um alerta, o backend persiste o incidente (com uma
localização inicial opcional), os membros do grupo consultam o alerta e o
criador o encerra quando está em segurança ou o cancela se foi acidental.

Requisitos que moldaram as decisões:

- o pedido de ajuda é crítico e sujeito a retry de rede — não pode duplicar
  incidentes nem se perder;
- localização precisa é dado sensível — só membros autorizados a recebem;
- o backend é a autoridade sobre membership, visibilidade e transições;
- nesta fase **não existem** push, realtime, confirmações de recebimento,
  mapa, geocoding, tracking contínuo nem integração com serviços oficiais.

## Decisão

### Modelo de dados

- `alert_status` (enum PostgreSQL): `ACTIVE`, `RESOLVED`, `CANCELLED`. O banco
  guarda o código estável; a interface traduz para ATIVO / RESOLVIDO /
  CANCELADO.
- `emergency_alerts`: `id`, `groupId` (FK → trusted_groups, cascade),
  `createdByUserId` (FK → users, cascade), `status` (default `ACTIVE`),
  `activatedAt`, `resolvedAt`, `cancelledAt`, `createdAt`, `updatedAt`.
- `alert_locations`: `id`, `alertId` (FK → emergency_alerts, cascade),
  `latitude`, `longitude` (`double precision`), `accuracy` (opcional),
  `capturedAt`, `createdAt`. Nesta fase existe no máximo um snapshot por
  alerta; a tabela já suporta múltiplas linhas para uma futura localização
  ao vivo (Phase 6) sem antecipá-la.
- `idempotency_keys`: `id`, `userId` (FK → users, cascade), `scope`, `key`,
  `requestHash`, `resourceId`, `createdAt`, com
  `UNIQUE(user_id, scope, key)`.

### Ciclo de vida

Transições permitidas: `ACTIVE → RESOLVED` e `ACTIVE → CANCELLED`. Qualquer
outra tentativa responde `409 INVALID_ALERT_TRANSITION` e **não altera**
estado nem timestamps. A transição é um update condicional
(compare-and-swap): `UPDATE ... WHERE id = ? AND status = 'ACTIVE'`; se
nenhuma linha for afetada, a transição é inválida. Isso é seguro sob
concorrência (duas requisições simultâneas: uma vence, a outra recebe
`INVALID_ALERT_TRANSITION`). `resolve` preenche apenas `resolvedAt`; `cancel`
preenche apenas `cancelledAt`.

### Autorização (server-side)

- Criar: o `groupId` enviado pelo cliente só vale se existir membership do
  usuário no grupo. Não-membro recebe `404 GROUP_NOT_FOUND`.
- Ler (lista e detalhes): apenas membros do grupo do alerta. A listagem faz
  `INNER JOIN` com `group_memberships` do usuário; o detalhe verifica a
  membership após localizar o alerta.
- Resolver/cancelar: **somente o criador**. OWNER/ADMIN não encerram alerta
  de outra pessoa nesta fase. Membro que não é o criador recebe
  `403 FORBIDDEN`.

### Anti-IDOR

Mantém a estratégia da Phase 2: quem não pertence ao grupo do alerta recebe
`404 ALERT_NOT_FOUND` em `GET`, `resolve` e `cancel` — a resposta é idêntica
à de um alerta inexistente, sem revelar a existência do recurso e sem
qualquer campo de localização. IDs inválidos também resultam em 404, nunca em
erro de SQL.

### Idempotência persistente

`POST /alerts` exige o header `Idempotency-Key` (8–128 caracteres de
`[A-Za-z0-9_-]`; ausente ou inválido → `400 INVALID_IDEMPOTENCY_KEY`). O
mobile gera uma chave nova por intenção de ativação e reutiliza a mesma chave
ao repetir a mesma intenção após falha de rede.

No backend a chave é escopada por `(usuário, operação "alerts.create", chave)`
na tabela `idempotency_keys`, portanto sobrevive a reinício da API e a mesma
chave usada por usuários diferentes não interfere. Fluxo:

1. autenticar → validar payload → validar chave → validar membership;
2. se a chave já existe para o usuário: comparar o hash SHA-256 do payload
   canônico; igual → devolver o alerta original (`201`, header
   `Idempotent-Replayed: true`); diferente → `409 IDEMPOTENCY_KEY_REUSED`;
3. senão, em **uma transação**: reservar a chave, inserir o alerta `ACTIVE`,
   inserir a localização (se houver) e vincular o `resourceId` à chave.

Reservar a chave primeiro torna a concorrência determinística: duas
requisições simultâneas com a mesma chave disputam o índice único; a segunda
aguarda a primeira e, ao falhar por unicidade, cai no caminho de replay. Se a
criação falhar por qualquer motivo, a chave é desfeita junto (rollback).

### Um alerta ativo por usuário/grupo

Garantido no PostgreSQL por índice único parcial:
`UNIQUE (created_by_user_id, group_id) WHERE status = 'ACTIVE'`. A violação é
traduzida para `409 ALERT_ALREADY_ACTIVE`. Não dependemos de checagem prévia
em memória; requisições concorrentes com chaves diferentes resultam em
exatamente um alerta.

### Localização opcional e "nunca bloquear o SOS por falha de GPS"

A localização é um snapshot explícito capturado **apenas** durante a
ativação, em primeiro plano, com timeout curto (6 s). Permissão negada, GPS
desligado, erro da biblioteca ou tempo excedido resultam em `location: null`
e **o alerta é criado mesmo assim**. Não há tracking contínuo, background
location, polling de GPS nem mapa. O texto de permissão (pt-BR) fica no
`app.json` via plugin do `expo-location`, com background location
explicitamente desabilitado.

### Privacidade da localização

- Apenas membros do grupo recebem `location`; externos recebem 404 sem campos.
- Latitude/longitude não aparecem em logs: o logger redige `req.body.location`
  e `req.headers.idempotency-key`; erros de validação não ecoam coordenadas.
- A interface mostra apenas "Disponível" / "Não disponível" (e a precisão
  aproximada), nunca coordenadas cruas nem mapa.
- O mobile não persiste localização nem histórico de alertas em storage.
- Testes usam apenas coordenadas sintéticas.

### UX do acionamento

O botão SOS usa **pressionar e segurar por ~2 s** com barra de progresso;
soltar antes cancela; a mesma interação nunca dispara mais de uma requisição;
enquanto a ativação está em andamento o botão fica ocupado. O hold é a própria
confirmação — não há etapas extras. Após sucesso real da API a tela informa
"Alerta ativado — Os membros do grupo poderão visualizar este alerta no
SafeCircle", sem afirmar entrega ou notificação. O cancelamento exige
confirmação; a resolução ("Estou em segurança") é direta.

### Sem push e sem realtime

Nenhuma dependência de notificação (Expo Notifications, FCM, APNs) ou de
tempo real (WebSocket, SSE, Redis) foi adicionada. Outros membros consultam
alertas ativos ao abrir a tela, via pull-to-refresh ou ao voltar ao primeiro
plano — sem polling. Push pertence à Phase 4; realtime, à Phase 5.

## Alternativas consideradas

- **Idempotência em memória/cache**: rejeitada — não sobrevive a reinício nem
  a múltiplas instâncias; a tabela é simples e suficiente.
- **Armazenar a resposta serializada na chave**: rejeitada — guardar o
  `resourceId` e reler o alerta devolve sempre o estado persistido real.
- **Não detectar reuso da chave com payload diferente**: rejeitada — a mesma
  chave com outro grupo devolveria um alerta do grupo errado; preferimos
  `IDEMPOTENCY_KEY_REUSED`.
- **Permitir que OWNER/ADMIN encerrem alertas**: adiada — nesta fase só o
  criador conhece a própria situação; revisitar com confirmações (Phase 5+).
- **`403` para externos em vez de `404`**: rejeitada — revelaria a existência
  do alerta (mesma decisão da Phase 2).
- **Rate limit em `POST /alerts`**: rejeitada nesta fase — limitar um pedido
  de ajuda é perigoso; o índice de alerta ativo único já contém spam por
  (usuário, grupo).
- **Trigger/CHECK para um alerta ativo**: o índice único parcial é mais
  simples e já é o padrão do projeto.

## Consequências

Positivas:

- Retry de rede nunca duplica incidente; garantias vivem no banco.
- Isolamento entre grupos e privacidade de localização por padrão.
- Contratos de erro estáveis (`ALERT_NOT_FOUND`, `ALERT_ALREADY_ACTIVE`,
  `INVALID_ALERT_TRANSITION`, `INVALID_IDEMPOTENCY_KEY`,
  `IDEMPOTENCY_KEY_REUSED`, `FORBIDDEN`) traduzidos em pt-BR no app.
- Base pronta para push (Phase 4) e realtime (Phase 5): o alerta já é
  persistido antes de qualquer notificação.

Negativas / trade-offs:

- Sem push/realtime, outros membros só veem o alerta ao abrir o app.
- Chaves de idempotência não expiram nesta fase (tabela cresce com o uso);
  uma política de retenção será definida quando houver volume real.
- Localização é um único snapshot inicial; ajuda a encontrar a pessoa apenas
  onde o alerta foi acionado.
