# Threat Model — SafeCircle

Modelo de ameaças da API e do app (Phase 11). É um documento vivo: cada fase
que mexer em autenticação, autorização, localização ou infraestrutura deve
revisá-lo. Nenhuma linha abaixo afirma risco zero — a coluna **Risco residual**
existe justamente para o que fica.

Princípios que orientam toda mitigação (ADR 0012):

```
backend é autoridade · deny by default · least privilege
data minimization · defense in depth · fail secure
```

Nenhuma decisão do app mobile concede autorização. O app apresenta; o backend
decide.

---

## 1. Ativos

| Ativo                         | Onde vive                                        | Por que importa                                                    |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Credenciais (senha)           | `users.password_hash` (Argon2id)                 | Takeover de conta = acesso ao grupo e à localização de terceiros   |
| Refresh tokens                | `auth_sessions.refresh_token_hash`, histórico    | Sessão longa (30 d); roubo = acesso persistente                    |
| Sessões / access tokens (JWT) | `auth_sessions`; JWT só em memória do app        | Autenticam toda chamada e o WebSocket                              |
| Grupos e memberships          | `trusted_groups`, `group_memberships`            | Definem QUEM pode ver QUEM — a fronteira de privacidade do produto |
| Alertas (SOS)                 | `emergency_alerts`                               | O pedido de ajuda em si; falso alerta ou supressão são graves      |
| Localização                   | `alert_locations`, `*_location_updates/sessions` | O dado mais sensível do sistema                                    |
| Push tokens                   | `push_devices.token`                             | Permitem enviar notificação a um aparelho específico               |
| Check-ins e trajetos          | `safety_checkins`, `safe_journeys`               | Rotina e deslocamento de uma pessoa                                |
| Trilha de auditoria           | `audit_events`                                   | Evidência em incidente; alvo de adulteração                        |
| Outbox                        | `outbox_events`                                  | Efeitos pendentes; contém IDs e correlação                         |
| Métricas                      | `/metrics`                                       | Revelam volume, topologia e horários de uso                        |
| Dados pessoais                | `users.name`, `users.email`, tudo acima          | Obrigação legal e de confiança                                     |

## 2. Atores

| Ator                                 | Capacidade                                                  |
| ------------------------------------ | ----------------------------------------------------------- |
| Usuário legítimo                     | Conta própria, aparelhos próprios                           |
| Membro malicioso de grupo            | Autenticado, membro, quer mais do que o papel permite       |
| Usuário autenticado sem membership   | Conta válida, tenta adivinhar/reutilizar IDs de outros      |
| Atacante anônimo                     | Rede, sem conta: força bruta, enumeração, DoS               |
| Atacante com token roubado           | Access ou refresh token de outra pessoa                     |
| Processo/instância comprometida      | Executa código dentro da API: lê banco, segredos em memória |
| Provedor externo indisponível/hostil | Expo Push fora do ar ou respondendo lixo                    |
| Dependência de terceiro comprometida | Pacote npm ou GitHub Action com código malicioso            |

## 3. Trust boundaries

```
┌──────────────┐  HTTPS / WSS (Bearer)  ┌──────────────┐   TCP (credencial própria)  ┌──────────────┐
│  App mobile  │ ─────────────────────► │  API Fastify │ ──────────────────────────► │  PostgreSQL  │
│  (SecureStore│ ◄───────────────────── │  + worker    │ ◄────────────────────────── │              │
│   p/ refresh)│                        │  outbox      │                             └──────────────┘
└──────────────┘                        └──────┬───────┘
                                               │ HTTPS (EXPO_ACCESS_TOKEN)
                                               ▼
                                        ┌──────────────┐
                                        │  Expo Push   │
                                        └──────────────┘

┌──────────────┐  push / PR / deploy futuro  ┌──────────────┐
│  GitHub / CI │ ──────────────────────────► │  build/deploy│
└──────────────┘                             └──────────────┘
```

Tudo que cruza uma fronteira é entrada não confiável — inclusive o header
`Origin`, o `X-Request-Id`, o `alg` do JWT e as variáveis de ambiente.

## 4. Ameaças, mitigações e risco residual

Legenda de risco: **A** alto · **M** médio · **B** baixo.

### 4.1 Credential stuffing

| Campo              | Conteúdo                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A** — senhas vazadas de outros serviços testadas contra `/auth/login`                                                                                                                                                           |
| Mitigação atual    | Rate limit por IP em `/auth/*` (10/min); Argon2id torna cada tentativa cara                                                                                                                                                       |
| Mitigação Phase 11 | Freio **por conta** (`LoginThrottle`): 5 falhas em 15 min bloqueiam a conta por 15 min, chave = hash do e-mail; backoff progressivo por IP; métrica `safecircle_auth_login_attempts_total{result}`; auditoria `AUTH_LOGIN_FAILED` |
| Risco residual     | **M** — o freio é por instância (réplicas multiplicam o teto); ataque muito lento e distribuído passa. Sem MFA nesta fase.                                                                                                        |

### 4.2 Força bruta em uma conta

| Campo              | Conteúdo                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M**                                                                                                                                          |
| Mitigação atual    | Rate limit por IP; Argon2id (19 MiB, t=2)                                                                                                      |
| Mitigação Phase 11 | Freio por conta com bloqueio temporário (nunca lockout permanente: seria DoS contra a vítima); senha mínima de 12 caracteres para contas novas |
| Risco residual     | **B** — contas antigas podem ter 8 caracteres até trocarem a senha (troca de senha não existe ainda)                                           |

### 4.3 Enumeração de contas

| Campo              | Conteúdo                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M** — descobrir quem usa o app é o primeiro passo de stalking                                                                                                                                                                                         |
| Mitigação atual    | Login devolve `INVALID_CREDENTIALS` tanto para e-mail inexistente quanto para senha errada; hash dummy equaliza o timing; convite não revela se o e-mail tem conta                                                                                      |
| Mitigação Phase 11 | Teste de timing na suíte; freio por conta responde o mesmo `RATE_LIMITED` do IP                                                                                                                                                                         |
| Risco residual     | **M** — `POST /auth/register` responde `EMAIL_ALREADY_IN_USE` (409): enumeração é possível via registro, limitada pelo rate limit. Decisão consciente: a alternativa (registro "cego" com e-mail de confirmação) exige envio de e-mail, fora do escopo. |

### 4.4 Roubo de token (access)

| Campo              | Conteúdo                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A**                                                                                                                                                                                                          |
| Mitigação atual    | Access token curto (15 min); nunca em log (redaction); só em memória no app                                                                                                                                    |
| Mitigação Phase 11 | **Validação de sessão por requisição**: `sid` precisa apontar para sessão viva; revogar a sessão mata o access token na hora; `GET/DELETE /me/sessions`, `revoke-others`; WebSocket da sessão é fechado (4403) |
| Risco residual     | **B** — janela até o dono perceber e revogar; sem device binding                                                                                                                                               |

### 4.5 Replay de refresh token

| Campo              | Conteúdo                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A** — refresh vale 30 dias                                                                                                                                                                                                                               |
| Mitigação atual    | Rotação a cada uso (compare-and-swap); só o hash SHA-256 persistido; token aleatório de 256 bits                                                                                                                                                           |
| Mitigação Phase 11 | **Detecção de reuso**: hash antigo vai para `auth_refresh_token_history`; reaparecer fora da janela de graça (10 s) revoga a sessão inteira, audita `AUTH_REFRESH_REUSE_DETECTED`, incrementa `safecircle_refresh_reuse_detected_total`; resposta genérica |
| Risco residual     | **B** — atacante que rouba o token e o usa **antes** do dono ganha a sessão até o dono tentar renovar (aí a sessão morre para os dois)                                                                                                                     |

### 4.6 Session hijack

| Campo              | Conteúdo                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Risco              | **A**                                                                                                                    |
| Mitigação atual    | HTTPS obrigatório em produção (fora da API — ingress); Bearer, sem cookies (sem CSRF)                                    |
| Mitigação Phase 11 | Limite de 10 sessões ativas; listagem/revogação; `last_used_at` para o usuário reconhecer sessão estranha                |
| Risco residual     | **M** — TLS depende da infraestrutura; sem certificate pinning; sem fingerprint de aparelho (por decisão de privacidade) |

### 4.7 IDOR

| Campo              | Conteúdo                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A** — trocar um UUID na URL e ver a localização de um estranho é o pior cenário do produto                                                                        |
| Mitigação atual    | Todo acesso a recurso passa por `loadAccessible*`/`requireMembership`: não-membro recebe **404** idêntico a inexistente; IDs são UUID v4                            |
| Mitigação Phase 11 | Suíte regressiva table-driven (`tests/security/authorization-matrix.test.ts`) cobrindo 31 endpoints × {externo, ex-membro}; `docs/security/authorization-matrix.md` |
| Risco residual     | **B** — endpoint novo sem entrar na matriz. Mitigação: a matriz é a lista de verificação de toda fase futura                                                        |

### 4.8 Escalada de privilégio / Broken Function Level Authorization

| Campo              | Conteúdo                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M**                                                                                                                                                     |
| Mitigação atual    | `requireGroupRole`; único OWNER garantido por índice parcial; ADMIN não mexe em ADMIN/OWNER; criador/dono é o único que muda o próprio recurso            |
| Mitigação Phase 11 | Suíte BFLA: MEMBER → 403 em toda ação de OWNER/ADMIN e de autoria alheia; ADMIN não altera papéis; ninguém toca em push device ou sessão de outro usuário |
| Risco residual     | **B**                                                                                                                                                     |

### 4.9 Acesso de ex-membro

| Campo              | Conteúdo                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Risco              | **A** — quem saiu (ou foi removido) de um grupo familiar não pode continuar vendo localização                                              |
| Mitigação atual    | Autorização consulta membership a **cada** requisição (nada em cache no token); destinatários de push e realtime são resolvidos na entrega |
| Mitigação Phase 11 | Testes explícitos: ex-membro recebe 404 na requisição seguinte à saída, sem esperar token expirar                                          |
| Risco residual     | **B** — evento realtime já enfileirado antes da saída pode chegar (janela de segundos)                                                     |

### 4.10 WebSocket não autorizado

| Campo              | Conteúdo                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Risco              | **A** — canal que carrega eventos do grupo                                                                                                                         |
| Mitigação atual    | Bearer no handshake (mesmo `authenticate`); fechamento ao expirar o token (4401); limite de 5 conexões/usuário; heartbeat; backpressure; server-push only          |
| Mitigação Phase 11 | Sessão viva exigida; `Origin` fora da allow-list → 403; rate limit de handshake (30/min/IP); revogação de sessão fecha o socket (4403); frame > 1 KiB fecha (1009) |
| Risco residual     | **B**                                                                                                                                                              |

### 4.11 Resource exhaustion

| Campo              | Conteúdo                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M**                                                                                                                                                                                                                            |
| Mitigação atual    | Rate limit em auth/convites/check-ins/trajetos; throttling de pontos de localização; listas com teto fixo no servidor (sem `limit` do cliente); `maxPayload` do WS                                                               |
| Mitigação Phase 11 | `bodyLimit` global 256 KiB → 413; só `application/json` → 415; rate limit de handshake e de exportação; freio por conta com sweep de memória                                                                                     |
| Risco residual     | **M** — não há WAF nem proteção L3/L4 na API; DoS volumétrico é problema de infraestrutura. `POST /alerts` deliberadamente **não** tem rate limit (SOS), protegido pela regra de um ACTIVE por usuário/grupo e pela idempotência |

### 4.12 Reassociação indevida de push token

| Campo              | Conteúdo                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M** — receber notificações de emergência de outra conta                                                                                                                                      |
| Mitigação atual    | Registro só autenticado; `UNIQUE(token)`; token conhecido passa a pertencer ao usuário autenticado atual (troca de conta no mesmo aparelho); desativação só do próprio (`user_id` na cláusula) |
| Mitigação Phase 11 | Testes BFLA de push device; classificação de push token como dado sensível operacional (nunca em resposta, log, outbox ou export)                                                              |
| Risco residual     | **B** — quem tem sessão válida em um aparelho pode registrar o token daquele aparelho para si: é o comportamento desejado                                                                      |

### 4.13 Vazamento de localização

| Campo              | Conteúdo                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Risco              | **A**                                                                                                                                                                                      |
| Mitigação atual    | Só membros do grupo leem; só o dono escreve; coordenadas nunca em log (redaction), push, realtime, outbox, audit ou métrica; retenção 30 d; coleta só em primeiro plano e sessão explícita |
| Mitigação Phase 11 | Suíte de privacidade varre outbox, auditoria e logs com marcadores; export inclui só a própria localização e nunca pontos ao vivo de ninguém                                               |
| Risco residual     | **M** — membro legítimo pode fotografar a tela; backup do banco sem criptografia exporia tudo (ver `docs/security/release-security-checklist.md`)                                          |

### 4.14 GPS spoofing

| Campo              | Conteúdo                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M** — dono do trajeto pode enviar posição falsa                                                                   |
| Mitigação atual    | Coordenadas validadas em faixa; `capturedAt` contra datas absurdas; throttling                                      |
| Mitigação Phase 11 | Nenhuma nova. Registrado como **risco residual aceito**: o backend não tem como provar que um ponto vem do GPS real |
| Risco residual     | **M** — inerente; o produto informa "onde a pessoa diz estar"                                                       |

### 4.15 Log injection

| Campo              | Conteúdo                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **B**                                                                                                                            |
| Mitigação atual    | Logs estruturados (JSON, Pino); `X-Request-Id` só se UUID; strings do usuário (nome, destino, nome do grupo) **não** são logadas |
| Mitigação Phase 11 | Teste confirma ausência de marcadores de nome/destino em logs; códigos de erro de conjunto fechado                               |
| Risco residual     | **B**                                                                                                                            |

### 4.16 Métricas expostas

| Campo              | Conteúdo                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Risco              | **M** — volume, horários e topologia                                                     |
| Mitigação atual    | `/metrics` desligado por padrão; Bearer com comparação em tempo constante; labels sem ID |
| Mitigação Phase 11 | Produção **recusa subir** com `METRICS_ENABLED=true` sem `METRICS_TOKEN`                 |
| Risco residual     | **B**                                                                                    |

### 4.17 Adulteração de auditoria/outbox

| Campo              | Conteúdo                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M**                                                                                                                       |
| Mitigação atual    | Usuário não escreve nas tabelas (nenhum endpoint); só o worker/serviços; auditoria via outbox (não se perde)                |
| Mitigação Phase 11 | CLI da outbox não edita payload; sem endpoint HTTP de replay; documentação de encryption-at-rest e least privilege do banco |
| Risco residual     | **M** — quem tem acesso ao banco altera tudo; não há assinatura/hash-chain da trilha (fora de escopo)                       |

### 4.18 SQL injection

| Campo              | Conteúdo                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Risco              | **A** se existir; **B** de existir                                                                                                                                                                                                                                                               |
| Mitigação atual    | Drizzle ORM com parâmetros; SQL bruto só em 6 pontos (claim `FOR UPDATE SKIP LOCKED`, `coalesce` de retenção ×2, `coalesce` de ordenação de sessões ×2, `select 1`, `attempt_count + 1`), todos com `sql` template do Drizzle referenciando colunas ou parâmetros; nenhuma concatenação de input |
| Mitigação Phase 11 | Revisão de todo `sql\`` registrada nesta seção; UUIDs validados por Zod antes de chegar ao banco                                                                                                                                                                                                 |
| Risco residual     | **B**                                                                                                                                                                                                                                                                                            |

### 4.19 SSRF

| Campo              | Conteúdo                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Risco              | **B**                                                                                                         |
| Mitigação atual    | Um único `fetch` externo: Expo Push, URL **fixa no código** (`EXPO_PUSH_API_URL`); nenhuma URL vem de usuário |
| Mitigação Phase 11 | Inventário: superfície SSRF = zero URLs controladas pelo cliente                                              |
| Risco residual     | **B**                                                                                                         |

### 4.20 Supply chain

| Campo              | Conteúdo                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A** — um pacote npm ou action comprometida roda com tudo                                                                                                                                                                 |
| Mitigação atual    | `pnpm install --frozen-lockfile` no CI                                                                                                                                                                                     |
| Mitigação Phase 11 | Actions fixadas por **SHA de commit**; `permissions: contents: read`; Dependabot semanal (npm + actions); `pnpm security:audit` (high/critical) no CI; CodeQL; `ws` atualizado (GHSA-96hv-2xvq-fx4p); waivers documentados |
| Risco residual     | **M** — auditoria só pega vulnerabilidade **conhecida**; pacote malicioso novo não é detectado; `onlyBuiltDependencies` limita scripts de instalação                                                                       |

### 4.21 Vazamento de segredo

| Campo              | Conteúdo                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **A**                                                                                                                                                                                  |
| Mitigação atual    | `.env` no `.gitignore`; `.env.example` só com placeholders; redaction de `Authorization`, tokens, senhas                                                                               |
| Mitigação Phase 11 | Produção recusa segredo fraco/placeholder (`isWeakSecret`); mensagens de erro de configuração **nunca** imprimem o valor; checklist do repositório (secret scanning + push protection) |
| Risco residual     | **M** — as configurações do GitHub são manuais e não verificadas por código (ver `repository-security.md`)                                                                             |

### 4.22 Dependência vulnerável

| Campo              | Conteúdo                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Risco              | **M**                                                                                                             |
| Mitigação atual    | Nenhuma automatizada                                                                                              |
| Mitigação Phase 11 | `pnpm security:audit` falha o CI em high/critical; Dependabot; waivers com validade em `vulnerability-waivers.md` |
| Risco residual     | **B** — moderadas em ferramentas de build (esbuild via drizzle-kit, uuid via expo) aceitas com prazo              |

### 4.23 Retenção excessiva

| Campo              | Conteúdo                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risco              | **M** — dado guardado é dado vazável                                                                                                                                      |
| Mitigação atual    | Políticas por domínio (30/90/180 d) com scripts separados                                                                                                                 |
| Mitigação Phase 11 | `pnpm privacy:cleanup` consolida tudo; sessões encerradas e histórico de refresh ganham prazo (30 d); `docs/privacy/retention-policy.md` define o que ainda não tem prazo |
| Risco residual     | **M** — perfil, grupos, alertas (sem localização), acknowledgements não têm prazo enquanto não há exclusão de conta (**RELEASE BLOCKER**, ver ADR 0012)                   |

### 4.24 Instância comprometida

| Campo              | Conteúdo                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Risco              | **A**                                                                                                 |
| Mitigação atual    | Segredos só em env; nada em disco                                                                     |
| Mitigação Phase 11 | Documentação de least privilege do usuário do banco e de rotação de segredos (`incident-response.md`) |
| Risco residual     | **A** — quem executa código na API lê o que a API lê. Não há isolamento adicional nesta fase          |

## 5. O que este modelo NÃO cobre

- Segurança física do aparelho (aparelho desbloqueado nas mãos de terceiro).
- Engenharia social contra membros do grupo.
- Falsos alertas por usuário legítimo (problema de produto, não de segurança).
- Disponibilidade do provedor de push.
- Conformidade jurídica: controles técnicos não são, sozinhos, conformidade com LGPD ou lojas.

## 6. Revisão

Revisar este documento quando: entrar um endpoint novo (atualizar a matriz),
entrar uma integração externa (SSRF), mudar o modelo de sessão, ou antes de
cada release (checklist).
