# ADR 0002 — Estratégia de autenticação

## Status

Aceito — Phase 1 (Autenticação).

## Contexto

A Phase 1 do SafeCircle precisa autenticar usuários de forma segura, cobrindo
cadastro, login, sessão persistente no mobile, restauração de sessão, `/me`,
renovação e logout. Autenticação é uma fronteira crítica de segurança: o
backend é a autoridade e o repositório é público (nenhum segredo versionado).

As decisões abaixo priorizam segurança, minimização de dados e simplicidade,
sem antecipar recursos de fases futuras (verificação de e-mail, recuperação de
senha, MFA, login social etc.).

## Decisão

### Modelo de dados

- `users`: `id` (UUID, `gen_random_uuid()`), `name`, `email` (único,
  normalizado em trim + lowercase na aplicação), `passwordHash`, `createdAt`,
  `updatedAt`.
- `auth_sessions`: `id`, `userId` (FK → `users`, `on delete cascade`),
  `refreshTokenHash`, `expiresAt`, `createdAt`, `updatedAt`, `revokedAt`.
  Índice único em `refreshTokenHash` e índice em `userId`.

Não são coletados telefone, endereço, localização, IP, fingerprint ou device
tracking nesta fase.

### Senhas — Argon2id

O hash de senha usa **Argon2id** (via `@node-rs/argon2`, biblioteca mantida com
binários pré-compilados). Parâmetros baseados nas recomendações do OWASP
(`memoryCost` 19 MiB, `timeCost` 2, `parallelism` 1). A senha em texto puro
nunca é persistida nem registrada em logs; o hash nunca é exposto em respostas.
Política mínima: 8 caracteres (evolutível sem alterar o domínio).

### Access Token — JWT

Access token é um **JWT** assinado pelo backend, com TTL curto (15 min por
padrão). Claims mínimos: `sub` (ID do usuário), `sid` (ID da sessão), além de
`iat`/`exp` e `iss`/`aud` (`safecircle` / `safecircle-app`). Não contém dados
pessoais (nome, e-mail, telefone, localização).

### Refresh Token — opaco + hash

Refresh token é **opaco e criptograficamente aleatório** (`randomBytes(32)`,
base64url), não um JWT. No banco armazenamos somente o **hash SHA-256**
(determinístico, adequado a lookup por alta entropia). Senha continua
obrigatoriamente em Argon2id; o refresh token, por ter entropia alta, usa
SHA-256.

### Rotação e uso único

No `/auth/refresh`, o refresh token é rotacionado. A troca é atômica via
**compare-and-swap** (`UPDATE ... WHERE refresh_token_hash = <atual> AND
revoked_at IS NULL`), garantindo que o token anterior deixe de valer e que
apenas uma rotação vença sob concorrência. Não implementamos, nesta fase,
detecção de reuso/token family (evitar complexidade prematura).

### Sessões persistidas

O banco é a fonte de verdade das sessões. Logout revoga a sessão
(`revokedAt`), de forma idempotente, sem revelar detalhes de outras sessões.

### Armazenamento seguro no mobile

- Access token: apenas em memória.
- Refresh token: `expo-secure-store` (Keychain/Keystore) em plataformas nativas.
- Web (demonstração/desenvolvimento): armazenamento **apenas em memória** — a
  sessão não persiste após reload. Nunca usamos `localStorage`/`AsyncStorage`
  para refresh token.

### Erros e enumeração

Códigos estáveis (`INVALID_CREDENTIALS`, `EMAIL_ALREADY_IN_USE`,
`INVALID_REFRESH_TOKEN`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `VALIDATION_ERROR`,
`UNAUTHORIZED`, `RATE_LIMITED`). Login retorna o mesmo `INVALID_CREDENTIALS`
para e-mail inexistente e senha incorreta, com equalização de timing (verify
contra hash dummy) para dificultar enumeração. Nunca expomos stack trace ou
mensagens cruas do PostgreSQL.

### Rate limiting

`@fastify/rate-limit` aplicado por rota nos endpoints sensíveis (`register`,
`login`, `refresh`), com `global: false` para não afetar futuros fluxos de
emergência. Em ambiente de teste os limites são altíssimos para evitar
flakiness.

## Alternativas consideradas

- **Refresh token como JWT**: rejeitado — dificulta revogação imediata e uso
  único; preferimos token opaco com estado no banco.
- **bcrypt/scrypt para senha**: Argon2id é a recomendação atual do OWASP.
- **Sessão via cookie httpOnly**: adequado para web puro, mas o cliente
  principal é mobile; Bearer token + SecureStore atende melhor agora.
- **SQLite em testes**: rejeitado — os testes exercitam comportamento
  relacional (FK, unique, transações), então usamos PostgreSQL real.

## Consequências

Positivas:

- Revogação real de sessão e rotação com uso único.
- Superfície mínima de dados pessoais.
- Contratos de erro estáveis, com i18n no cliente.

Negativas / trade-offs:

- Estado de sessão no banco exige lookup a cada refresh.
- Sem persistência de sessão na web (intencional para a demonstração).
- Sem detecção de reuso de refresh token nesta fase (planejável no futuro).
