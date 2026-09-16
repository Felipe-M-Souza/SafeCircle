# ADR 0012 — Security & Privacy Hardening

## Status

Aceito — Phase 11 (Security & Privacy Hardening). Terceira fase do bloco de
Production Readiness. **Nenhum contrato HTTP existente mudou**; rotas,
cabeçalhos e comportamentos foram adicionados ou endurecidos.

## Contexto

Até a Phase 10 o SafeCircle tinha as garantias funcionais e operacionais
(observabilidade, outbox). O que faltava, antes de um Release Candidate, era
revisar sistematicamente as garantias de **segurança e privacidade** que as
fases anteriores foram acumulando caso a caso: autenticação e sessões,
autorização anti-IDOR, configuração de produção, superfície HTTP/WebSocket,
cadeia de suprimento e ciclo de vida dos dados pessoais.

Um app de segurança pessoal inverte a tolerância habitual: uma falha de
autorização não é "um bug", é alguém vendo onde outra pessoa está. E um
lockout mal desenhado não é "um incômodo", é alguém sem conseguir pedir ajuda.
Toda decisão abaixo foi tomada com esse par em mente.

Princípios (`.cursor/rules/05-security-privacy.mdc`):

```
backend é autoridade · deny by default · least privilege
data minimization · defense in depth · fail secure
```

## Decisões

### 1. Threat model e matriz de autorização como artefatos versionados

`docs/security/threat-model.md` lista ativos, atores, fronteiras e 24 ameaças
com mitigação atual, mitigação desta fase e **risco residual** — nenhuma linha
afirma risco zero. `docs/security/authorization-matrix.md` diz quem pode fazer
o quê em cada endpoint e é verificada por uma suíte table-driven: endpoint
novo sem linha na matriz e caso na suíte é PR incompleto.

### 2. Anti-IDOR com 404, BFLA com 403

Mantido o padrão das fases anteriores e agora testado exaustivamente
(31 endpoints × externo × ex-membro): quem não é membro recebe **404
indistinguível de inexistente**; membro sem papel ou autoria recebe **403**,
porque a existência já é legitimamente conhecida. Ex-membro perde acesso na
requisição seguinte à saída — a autorização consulta membership a cada
chamada, nada fica em cache no token.

### 3. Política de senha: comprimento, não composição

Mínimo **12**, máximo **128**, sem regras de símbolo/dígito. Comprimento é o
que resiste a força bruta; regras de composição só produzem `Senha@123`.
Passphrases são bem-vindas. O máximo é explícito: senha acima dele é
recusada, nunca truncada em silêncio. A política vale para **senhas novas**;
contas criadas com mínimo 8 continuam entrando (o login não revalida
comprimento). Troca de senha não existe ainda — registrado.

### 4. Argon2id com parâmetros centralizados e verificados

Argon2id preservado com os parâmetros OWASP (19 MiB, t=2, p=1), exportados de
um único módulo e **verificados por teste** no hash gravado: ninguém reduz o
custo "só em dev" sem quebrar a suíte. Nenhum benchmark próprio foi executado
para ajustá-los — os valores são os da recomendação, não os de uma medição.

### 5. Freio por conta, além do rate limit por IP

Credential stuffing distribuído passa pelo rate limit por IP. O `LoginThrottle`
conta falhas **por conta** (chave = hash do e-mail, nunca o e-mail): 5 falhas
em 15 minutos bloqueiam por 15 minutos. Decisões deliberadas:

- **Sem lockout permanente**: um lockout até intervenção humana é uma arma de
  negação de serviço contra a vítima. A conta volta sozinha.
- **Sucesso zera**: errar duas vezes e acertar não deixa marca.
- **Por instância, em memória**: com N réplicas o teto efetivo é N vezes maior.
  Aceito e documentado; não adicionamos Redis só para distribuir contadores.
- A resposta é o mesmo `RATE_LIMITED` do IP: nada confirma que a conta existe.

Rate limit por IP ganhou backoff progressivo no login e um limite próprio no
refresh (30/min), no handshake do WebSocket (30/min) e na exportação (5/h).

### 6. Login anti-enumeração preservado

`INVALID_CREDENTIALS` para e-mail inexistente e para senha errada, com hash
dummy equalizando o tempo. Testado, inclusive o timing. Fica registrado que
`POST /auth/register` responde `EMAIL_ALREADY_IN_USE`: enumeração é possível
por lá, limitada pelo rate limit. A alternativa (registro "cego" com e-mail de
confirmação) exige infraestrutura de e-mail — fora do escopo, risco aceito.

### 7. Refresh token: rotação atômica e detecção de reuso

Rotação já era compare-and-swap. Agora o hash antigo vai para
`auth_refresh_token_history` **na mesma transação** da rotação. Um token que
não é o atual de nenhuma sessão é procurado no histórico:

- encontrado **dentro de 10 segundos** da rotação → corrida benigna (dois
  refreshes do mesmo aparelho); recusa genérica, sessão intacta;
- encontrado **fora** da janela → reuso: a sessão inteira é revogada
  (`REFRESH_REUSE`), o fato é auditado (`AUTH_REFRESH_REUSE_DETECTED`, ator
  nulo — quem apresentou pode ser o atacante), a métrica sobe e o WebSocket da
  sessão é fechado. A resposta é a mesma de token inválido.

Só hashes são persistidos; expiram 30 dias após a rotação. Um teste de
concorrência prova que 5 refreshes simultâneos produzem exatamente um sucesso
sem revogar nada.

### 8. Validação de sessão por requisição

O JWT continua sem estado, mas o `sid` passou a ser validado a cada chamada:
sessão inexistente, revogada ou expirada → 401, mesmo com JWT dentro da
validade. Custa uma consulta por chave primária e é o que faz "sair de todos os
aparelhos" valer **agora**, não em até 15 minutos. `last_used_at` é atualizado
com folga de 60 s, não a cada requisição.

### 9. Sessões visíveis e revogáveis; limite de 10

`GET /me/sessions`, `DELETE /me/sessions/:id` (inclusive a atual),
`POST /me/sessions/revoke-others`. Resposta sanitizada: id, datas e `current`
— nunca hash, IP ou User-Agent (não os guardamos). Sessão alheia → 404.

Limite de **10 sessões ativas por usuário**: ao exceder, a mais antiga por
último uso é revogada (`SESSION_LIMIT`) na mesma transação do login. Preferimos
isso a recusar o login — quem está entrando agora tem o aparelho na mão. Não
limitamos a um aparelho: famílias compartilham tablets.

### 10. JWT: algoritmo em allow-list e claims obrigatórias

`algorithms: ["HS256"]` — o `alg` do token nunca decide nada; `alg: none` é
recusado. `iss`, `aud`, `exp`, `iat`, `sub` e `sid` obrigatórios; `sub`/`sid`
UUIDs; tolerância de relógio de 5 s. Nenhuma PII no payload (verificado).

### 11. Produção fail-fast

Em `NODE_ENV=production` a API **recusa subir** se: `JWT_ACCESS_SECRET` está
ausente ou é fraco (curto, igual ao de dev, pouca variedade, placeholder);
`DATABASE_URL` está ausente; `OUTBOX_ENABLED=false`; `METRICS_ENABLED=true`
sem `METRICS_TOKEN`; alguma origem CORS é inválida (wildcard, path, esquema
estranho — isto em qualquer ambiente). As mensagens nomeiam a variável e
**nunca** imprimem o valor.

### 12. CORS por allow-list; Origin também no WebSocket

`CORS_ALLOWED_ORIGINS` (o antigo `CORS_ORIGINS` segue aceito): lista explícita
de `https://host[:porta]`, sem wildcard. Produção é sempre estrita; dev/test
refletem a origem para o app web local, a menos que a lista exista. Como a API
usa Bearer, não há cookies nem `credentials`. Requisição **sem** `Origin`
(app nativo) não passa por CORS — a autenticação decide. O mesmo policy vale
para o handshake do `/realtime`: origem fora da lista → 403 antes de autenticar.
Origem permitida **não** substitui autenticação.

### 13. Cabeçalhos de segurança de uma API, não de uma SPA

`@fastify/helmet` com CSP mínima (`default-src 'none'; frame-ancestors
'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
HSTS só com `HSTS_ENABLED=true`, porque ligado em dev HTTP quebra o navegador;
depende do TLS terminar no ingress — documentado.

### 14. Corpo limitado e só JSON

`bodyLimit` global de 256 KiB → **413 `PAYLOAD_TOO_LARGE`** (antes virava 400
genérico). O parser padrão de `text/plain` foi removido: qualquer
`Content-Type` que não seja JSON → **415 `UNSUPPORTED_MEDIA_TYPE`**. Dois
códigos novos, aditivos; o app os traduz.

### 15. WebSocket endurecido

Além de Origin e rate limit de handshake: a conexão carrega o `sid`, e revogar
a sessão fecha o socket com **4403 `SESSION_REVOKED`**; frame acima de 1 KiB é
fechado pelo `ws` (1009); mensagens do cliente continuam ignoradas — testado
que um "comando" enviado pelo socket não cria nem apaga nada.

### 16. Inputs e paginação

Não existe parâmetro de paginação controlado pelo cliente: todas as listagens
usam tetos fixos no servidor. Revisado e mantido — um `limit=1000000` não tem
onde entrar. UUIDs, enums, timestamps e strings já eram validados por Zod;
casos negativos determinísticos entraram na suíte.

### 17. SQL e SSRF

Todo SQL bruto foi inventariado: 6 pontos (`FOR UPDATE SKIP LOCKED`,
`coalesce` de retenção ×2, `coalesce` de ordenação de sessões ×2, `select 1`,
`attempt_count + 1`), todos com template parametrizado do Drizzle, nenhum com
concatenação de input. Único `fetch`
externo: Expo Push, URL fixa no código. Superfície SSRF controlada pelo
cliente: **zero**.

### 18. Push tokens como dado sensível operacional

Autorização revisada e testada (registro só autenticado, desativação só do
próprio, token nunca em resposta/log/outbox/export). **Sem criptografia de
coluna improvisada**: a proteção certa é encryption at rest do banco e
backups criptografados, agora no checklist de release.

### 19. Exportação dos próprios dados

`GET /me/privacy/export` devolve JSON versionado com o que é do usuário mais
o contexto mínimo (nome do grupo ao lado da membership). Fora: qualquer
segredo, qualquer dado de terceiro (e-mail de outros membros, quem convidou,
localização de outros), internos (outbox, auditoria, métricas). A localização
inicial dos **próprios** alertas entra; pontos de localização ao vivo entram
só como resumo de sessão (início/fim), para limitar o que um token roubado
extrai de uma vez. Rate limit próprio; `Cache-Control: no-store`; conteúdo
nunca logado; auditoria `PRIVACY_EXPORT_REQUESTED` com metadata vazia.

### 20. Retenção consolidada

`pnpm privacy:cleanup` encadeia as seis políticas (localização de alertas,
check-ins, trajetos, auditoria, outbox, autenticação). Novos prazos: sessões
encerradas 30 d, histórico de refresh até expirar. Falha em uma etapa não
impede as outras e sai com código ≠ 0 nomeando a etapa. O que ainda não tem
prazo está listado como pendência consciente em
`docs/privacy/retention-policy.md`.

### 21. Exclusão de conta: não implementada — RELEASE BLOCKER

> **Atualização (Phase 12):** bloqueador resolvido. A exclusão de conta foi
> implementada com reautenticação por senha, bloqueio por propriedade de grupo
> (com transferência de propriedade como saída) e por recursos ativos, e
> decisão por entidade — ver ADR 0013 §3. O texto abaixo é o registro
> histórico da decisão desta fase.

Mapeamento das dependências de `DELETE /me`:

| Dependência                       | Comportamento hoje (FK)                      | Problema para exclusão                                                                     |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Grupos onde é OWNER               | membership CASCADE; grupo fica **sem OWNER** | Viola a invariante de um OWNER por grupo; outros membros ficariam órfãos                   |
| Grupos onde é ADMIN/MEMBER        | CASCADE                                      | Aceitável (sai do grupo)                                                                   |
| Alertas ACTIVE criados            | CASCADE                                      | Um SOS em andamento sumiria sem ninguém ser avisado                                        |
| Check-ins/trajetos ACTIVE         | CASCADE                                      | Idem: membros esperando confirmação perdem o contexto                                      |
| Localização (todas as tabelas)    | CASCADE                                      | Desejado                                                                                   |
| Push devices, sessões, histórico  | CASCADE                                      | Desejado                                                                                   |
| Auditoria (`actor_user_id`)       | SET NULL                                     | Desejado (trilha fica, anônima)                                                            |
| Outbox PENDING com ids do usuário | Sem FK                                       | Handler falharia ao carregar o usuário → DEAD ou push para membros sobre um alerta apagado |
| Convites enviados por ele         | CASCADE                                      | Aceitável                                                                                  |

Decisão: **não implementar agora**. Uma exclusão que apaga um grupo com
outros membros em silêncio, ou que transfere ownership sem consentimento, ou
que some com um SOS ativo, é pior do que não existir. O fluxo correto exige
regras de produto (transferência voluntária de ownership, bloqueio enquanto
houver alerta ativo, aviso aos membros, período de carência) que não cabem
numa fase de hardening. Fica registrado, literalmente, no runbook e no
checklist de release:

> RELEASE BLOCKER — implementar fluxo completo de exclusão de conta antes da
> publicação nas lojas.

### 22. Mobile: SecureStore, id de instalação, deep links

Revisado, sem mudança de código além da política de senha: refresh token só em
`expo-secure-store` no nativo e só em memória na web (nunca AsyncStorage);
logout limpa; falha de storage não cai em fallback inseguro; o id de
instalação é UUID aleatório do app (não IMEI, Android ID, MAC ou ad ID);
push/deep links carregam só `type` e ids e o app busca na API.

### 23. Supply chain e CI

`permissions: contents: read`; actions fixadas por **SHA de commit**
(verificados via API do GitHub — nenhum SHA inventado); Dependabot semanal
para npm e actions com teto de PRs; `pnpm security:audit` (high/critical) no
CI; CodeQL (`security-extended`) GitHub-native; `ws` atualizado para fechar
uma advisory high; duas moderadas de ferramentas de build documentadas com
prazo em `vulnerability-waivers.md`. Configurações do GitHub que não são
código estão em `repository-security.md` como checklist **não verificado**.

### 24. Métricas e eventos de segurança

`safecircle_auth_login_attempts_total{result}`, `safecircle_auth_refresh_total{result}`,
`safecircle_security_rate_limited_total{route_group}`,
`safecircle_refresh_reuse_detected_total`. Labels de conjunto fechado; nunca
e-mail, IP ou id. Eventos de auditoria novos: `AUTH_SESSION_REVOKED`,
`AUTH_OTHER_SESSIONS_REVOKED` (metadata `revokedCount`),
`AUTH_REFRESH_REUSE_DETECTED`, `PRIVACY_EXPORT_REQUESTED`.

### 25. `trustProxy` explícito

`TRUST_PROXY=false|true|<saltos>`, padrão `false`: `X-Forwarded-For` só é
acreditado atrás do proxy configurado. Sem isso, o rate limit por IP seria
contornável forjando o header. TLS artesanal no Fastify **não**: a terminação
é do ingress.

## Alternativas consideradas

- **Lockout permanente após N falhas**: rejeitado — DoS contra a vítima.
- **Redis para rate limit distribuído**: rejeitado nesta fase; custo de um
  componente novo maior que o ganho, dado o teto multiplicado por réplicas.
- **MFA obrigatório / passkeys / OAuth social**: fora de escopo declarado.
- **Fingerprint de aparelho nas sessões (IP, UA)**: rejeitado por privacidade;
  o usuário reconhece a sessão por `lastUsedAt`/`createdAt`.
- **Criptografia de coluna caseira para push token**: rejeitado; a camada
  certa é o banco/backup.
- **Exclusão parcial de conta "para marcar como feito"**: rejeitado; ver §21.
- **Tratar toda corrida de refresh como reuso**: rejeitado; deslogaria usuários
  legítimos com rede instável. Janela de graça de 10 s.
- **CSP completa de SPA na API**: rejeitado; é uma API JSON.
- **Pinning de actions por tag**: rejeitado; tag é móvel.
- **Endpoint HTTP de exclusão de dados/replay**: rejeitado; operação é CLI.

## Consequências

Positivas: revogar sessão passou a ter efeito imediato; roubo de refresh token
é detectado e contido; a matriz de autorização é um contrato testado, não uma
intenção; produção não sobe mal configurada; a superfície HTTP/WS tem limites
explícitos; o usuário enxerga e controla suas sessões e pode exportar seus
dados; a cadeia de suprimento tem verificação contínua; a retenção tem um
único ponto de execução.

Negativas: uma consulta a mais por requisição autenticada (sessão); dois
códigos de erro novos que o app precisa traduzir; senha mínima maior para
contas novas; `text/plain` deixou de ser aceito; a configuração de produção
ficou mais exigente (o que é o objetivo); freio de login e rate limit
continuam por instância; exclusão de conta virou bloqueador explícito de
release em vez de ausência silenciosa.

## Riscos residuais

- Rate limiting e freio de login **por instância**.
- **GPS spoofing**: o backend não prova a origem de uma coordenada.
- **Push at-least-once**: pode duplicar (ADR 0011).
- **Sem MFA**; sem troca de senha; enumeração possível via registro.
- **Exclusão de conta pendente** (RELEASE BLOCKER).
- Configurações de segurança do **GitHub são manuais** e não verificadas por
  código.
- **TLS, encryption at rest e backups** dependem da infraestrutura de
  produção, não deste repositório.
- Instância comprometida lê o que a API lê.

## Deixado para as Phases 12 e 13

- Exclusão de conta completa (transferência voluntária de ownership, bloqueio
  com alerta ativo, carência).
- Troca de senha e recuperação de conta (exige e-mail).
- Verificação em aparelhos reais; revisão de permissões nas lojas.
- Preencher `repository-security.md` e `release-security-checklist.md`.
- Prazos de retenção para convites processados e push devices inativos.
- Alerting externo a partir das métricas de segurança.
