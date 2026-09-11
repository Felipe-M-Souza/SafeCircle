# ADR 0005 — Notificações Push

## Status

Aceito — Phase 4 (Notificações Push).

## Contexto

Na Phase 3 o alerta de emergência passou a existir no backend, mas os membros
do grupo só o descobrem ao abrir o SafeCircle. A Phase 4 adiciona push
nativo (iOS/Android via Expo) para avisar os membros autorizados quando um
alerta é criado — sem tornar a criação do alerta dependente do provedor de
push, sem introduzir infraestrutura distribuída e sem expor dados sensíveis
em uma notificação que pode aparecer na tela bloqueada.

## Decisão

### Desacoplamento: o alerta nunca depende do push

`POST /alerts` continua exatamente como na Phase 3: valida, persiste em uma
transação e responde com o estado persistido. Só depois do commit — e apenas
para criações reais, não para replays idempotentes — a rota agenda a
notificação em segundo plano via um plugin de tarefas (`app.background.run`).
A resposta não espera o provedor. Falha, timeout ou erro do provedor são
capturados e logados; **nunca há rollback do alerta**.

O plugin de tarefas em segundo plano não é fire-and-forget irresponsável:
cada tarefa tem erro capturado, as pendências são rastreadas e o shutdown do
Fastify aguarda sua conclusão (com limite de tempo). Os testes usam `flush()`
para aguardar deterministicamente.

**Limitação documentada**: as tarefas vivem no processo da API. Se a API cair
entre o commit e o envio, o push daquele alerta não é reenviado; não há
retry persistente. Aceitável nesta fase.

### Evolução futura (não implementada)

```text
Alert created → Outbox (mesma transação) → Worker → Push provider → Retries
```

Uma fase futura poderá gravar a intenção de notificação em uma tabela outbox
dentro da transação do alerta e delegar o envio a um worker com retries
persistentes, sem alterar o contrato da API nem o `PushProvider`.

### Modelo: `push_devices`

Um registro por instalação do app e usuário:

- `id`, `userId` (FK → users, cascade), `token` (Expo Push Token), `platform`
  (`push_platform`: IOS/ANDROID), `deviceId` (UUID de instalação),
  `isActive`, `lastSeenAt`, `createdAt`, `updatedAt`.
- `UNIQUE(token)`: um token pertence a um único usuário por vez.
- `UNIQUE(user_id, device_id)`: uma instalação tem um único registro por
  usuário. Índice por `user_id`.
- Não armazenamos localização, nome do aparelho, IP nem fingerprint.

### `deviceId` (identificador de instalação)

UUID v4 gerado pelo próprio app na primeira execução e persistido no
armazenamento seguro (`expo-secure-store`). Não usa IMEI, MAC address,
advertising ID nem qualquer identificador de hardware. Não é apagado no
logout: representa a instalação, não o usuário — permite rotacionar o token
e desassociar limpo.

### Registro, rotação e reassociação (`POST /me/push-devices`)

Validação campo a campo com códigos estáveis: `INVALID_PUSH_TOKEN` (formato
`Expo(nent)PushToken[...]` com conteúdo alfanumérico de 8–200 caracteres —
não apenas o prefixo), `INVALID_PUSH_PLATFORM`, `INVALID_DEVICE_ID`.

Upsert em transação, com as constraints do banco como garantia final e uma
repetição em caso de corrida:

- registro existente para o mesmo `(usuário, deviceId)` com token novo → o
  token é **substituído** (rotação), sem duplicar;
- mesmo token registrado de novo → apenas `lastSeenAt`/`isActive` atualizados;
- token já associado a **outro usuário** (troca de conta no mesmo aparelho)
  → o registro passa a pertencer ao usuário autenticado atual, e o registro
  antigo daquela instalação é removido. Política: **o dono do token é sempre
  quem está autenticado no aparelho agora**; nunca duas contas apontando
  para o mesmo token, nunca vazamento entre contas;
- registro inativo (logout ou token inválido) volta a ficar ativo.

A resposta nunca contém o token (`id`, `platform`, `deviceId`, `isActive`,
`updatedAt`).

### Logout (`DELETE /me/push-devices/:deviceId`)

Desativa (`isActive = false`) o registro do usuário para aquela instalação,
mantendo o histórico; `PUSH_DEVICE_NOT_FOUND` quando não existe. No app, o
logout chama o desregistro antes de revogar a sessão, mas **qualquer falha
é ignorada**: o usuário nunca fica preso na sessão por causa de push.

### `PushProvider`

Interface mínima (`send(messages) → results`) com resultado por token:
`sent`, `failed` ou `invalidToken`. O domínio não importa nada da Expo.

- `ExpoPushProvider`: HTTP direto à Expo Push API (`exp.host/--/api/v2/push/send`)
  usando `fetch` nativo do Node, lotes de 100, timeout por lote (8 s),
  `Authorization: Bearer` opcional via `EXPO_ACCESS_TOKEN`. Escolhido em vez
  do SDK para evitar dependência e manter o cliente pequeno e testável (o
  `fetch` é injetável).
- `FakePushProvider`: em memória, para testes; permite inspecionar mensagens,
  destinatários e payload, e simular falha total, token inválido e erro
  transitório. Nenhum teste chama a API real da Expo.

### Token inválido vs. erro transitório

Somente `DeviceNotRegistered` (ticket da Expo) é tratado como token inválido:
o registro é desativado (`isActive = false`) e deixa de receber envios. Não
apagamos usuário, membership nem registro. Qualquer outro erro (HTTP não-2xx,
`MessageRateExceeded`, timeout, rede) é transitório: fica logado como falha
operacional e o token continua ativo. Não há retry persistente nesta fase.

Os resultados nunca carregam a mensagem bruta da Expo (que pode conter o
token) — apenas um código curto alfanumérico.

### Destinatários

Uma única consulta (sem N+1): tokens ativos de `push_devices` juntados a
`group_memberships` do grupo do alerta, excluindo o criador. Deduplicação por
token; um usuário com dois aparelhos recebe em ambos. Externos ao grupo,
criador e tokens inativos nunca recebem. Membro sem token é ignorado sem erro.
Push é enviado **apenas na criação** do alerta — não em resolve, cancel,
leitura ou mudanças de grupo.

### Conteúdo mínimo e payload

Título `🚨 Alerta SafeCircle`, corpo `Um novo alerta de emergência foi
acionado em um dos seus grupos.` — **sem o nome do criador**: a notificação
pode aparecer na tela bloqueada de terceiros; quem está no grupo vê o nome ao
abrir o app. Sem coordenadas, e-mail, telefone, token ou detalhes do
incidente. `data` contém apenas `{ type: "EMERGENCY_ALERT", alertId, groupId }`.
Prioridade alta e canal Android `emergency` (importância máxima).

O app trata os IDs como referência: ao tocar, busca o alerta na API, que
revalida a autorização (não-membro recebe `ALERT_NOT_FOUND`) e devolve o
estado atual — uma notificação antiga pode apontar para um alerta já
resolvido ou cancelado.

### Mobile (`expo-notifications`)

- Permissão pedida **com contexto**, nunca no primeiro frame: um card na Home
  explica o motivo e oferece "Ativar notificações" / "Agora não". Negada →
  estado informativo com "Tentar novamente"; bloqueada → "Abrir
  configurações". Sem loop de solicitação e sem bloquear o app.
- Após login/restauração de sessão com permissão concedida, o app obtém o
  Expo Push Token e registra `(token, platform, deviceId)`; evita chamadas
  repetidas para o mesmo token e reenvia quando o token muda.
- Listener de toque configurado uma única vez no `NotificationsProvider`
  (com cleanup); a notificação que abriu o app (cold start) e o toque com o
  app aberto publicam a intenção `alertId`, consumida pela área autenticada
  (imediatamente ou após o login).
- `projectId` EAS (valor público) é lido de `app.json` → `extra.eas.projectId`
  quando configurado; nunca hardcodado. Credenciais FCM/APNs ficam na conta
  Expo/EAS, fora do repositório.
- Web: push é "indisponível"; nenhum web push falso é registrado.

### Privacidade e logs

O logger redige `req.body.token`. Resultados e logs do envio contêm apenas
contagens (`recipients`, `sent`, `failed`, `invalidToken`) e códigos de erro
curtos — nunca tokens. Se for preciso correlacionar um token, usa-se
`fingerprintToken` (hash truncado). O app não loga nem exibe o token.

## Alternativas consideradas

- **Enviar push dentro da requisição, antes de responder**: rejeitado —
  acoplaria o SOS à latência/disponibilidade da Expo.
- **Outbox + worker já nesta fase**: adiado — infraestrutura prematura; o
  desenho atual permite a migração sem mudar contratos.
- **SDK `expo-server-sdk`**: viável, mas o cliente HTTP direto é menor,
  sem dependência extra e com `fetch` injetável nos testes.
- **Incluir o primeiro nome do criador na notificação**: rejeitado por
  exposição na tela bloqueada; reavaliar com preferências do usuário.
- **Rejeitar token pertencente a outro usuário**: rejeitado — no fluxo
  logout/login no mesmo aparelho, o token legítimo deve seguir a conta
  autenticada; a reassociação com remoção do registro antigo é mais segura.
- **Apagar o registro no logout**: rejeitado — desativar mantém histórico e
  permite reativar sem recriar.

## Consequências

Positivas:

- Criação do alerta permanece rápida e independente do push.
- Provedor substituível e totalmente testável sem rede.
- Tokens inválidos são higienizados automaticamente; nenhum dado sensível em
  notificações, respostas ou logs.

Negativas / trade-offs:

- Sem outbox: queda da API entre commit e envio perde o push daquele alerta.
- Sem retry para erros transitórios nesta fase.
- Push exige build nativo (Expo Go/EAS) e `projectId` configurado; na web e
  em simuladores sem token o app segue funcionando sem notificações.
