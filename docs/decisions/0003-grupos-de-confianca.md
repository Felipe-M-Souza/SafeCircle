# ADR 0003 — Grupos de Confiança

## Status

Aceito — Phase 2 (Grupos de Confiança).

## Contexto

O SafeCircle precisa de grupos privados de confiança (família, amigos,
vizinhos) como base para os alertas de emergência das próximas fases. Grupos
são recursos privados: um usuário não pode descobrir, visualizar ou modificar
um grupo apenas conhecendo/alterando um ID. O backend é a autoridade sobre
participação, papel, visualização, administração, convites e remoção.

## Decisão

### Modelo de dados

- `trusted_groups`: `id` (UUID), `name` (obrigatório, `trim`, até 80 chars,
  sem unicidade global — dois usuários podem ter "Família"), timestamps.
- `group_memberships`: `id`, `groupId` (FK → trusted_groups, cascade),
  `userId` (FK → users, cascade), `role` (`group_role`: OWNER/ADMIN/MEMBER),
  timestamps.
- `group_invitations`: `id`, `groupId`, `invitedByUserId`, `invitedEmail`
  (normalizado), `status` (`invitation_status`: PENDING/ACCEPTED/REJECTED/
  REVOKED/EXPIRED), `expiresAt`, timestamps + `acceptedAt`/`rejectedAt`/
  `revokedAt`.

### Membership como fonte de verdade do papel

O papel do usuário vive em `group_memberships` — não duplicamos `ownerUserId`
em `trusted_groups`. Um índice único parcial garante **exatamente um OWNER por
grupo** no PostgreSQL:
`CREATE UNIQUE INDEX ... ON group_memberships (group_id) WHERE role = 'OWNER'`.
Há também `UNIQUE(group_id, user_id)` (uma membership por usuário/grupo).

### Papéis e permissões

- OWNER: ver, renomear, convidar, revogar, remover ADMIN/MEMBER, promover/
  rebaixar; não pode sair (transferência de ownership fora de escopo).
- ADMIN: ver, renomear, convidar, revogar, remover MEMBER; pode sair.
- MEMBER: ver, sair.

Autorização é sempre no backend; a UI apenas reflete permissões.

### Convite por e-mail e proteção contra enumeração

O convite é identificado pelo `invitedEmail` normalizado, permitindo convidar
quem ainda não tem conta (o convite aparece em `GET /me/group-invitations`
quando a pessoa se cadastra com o mesmo e-mail). O endpoint de convite **não**
revela se o e-mail já possui conta (anti-enumeração). Convidar o próprio
e-mail → `CANNOT_INVITE_SELF`; e-mail que já é membro → `ALREADY_GROUP_MEMBER`.

### Expiração e duplicidade

Convites expiram em **7 dias** (constante do backend, sem scheduler). Convites
vencidos são tratados como expirados na leitura/aceitação (status atualizado
sob demanda). Um índice único parcial impede mais de um convite PENDING por
`(group_id, invited_email)`:
`... WHERE status = 'PENDING'` → `INVITATION_ALREADY_PENDING`.

### Transações e concorrência

- Criar grupo: `trusted_group` + membership OWNER em uma transação.
- Aceitar convite: valida, checa expiração, faz compare-and-swap
  `PENDING → ACCEPTED` e cria a membership (`ON CONFLICT DO NOTHING`) na mesma
  transação — retry/concorrência não duplicam membership.
- Alterar papel: validação de ator/alvo + update em transação.

### Isolamento entre grupos (anti-IDOR)

Não-membros recebem **404 `GROUP_NOT_FOUND`** em qualquer rota de grupo (não
revelamos a existência do recurso). Membros sem papel suficiente recebem
**403 `INSUFFICIENT_GROUP_ROLE`**. IDs são validados como UUID; valores
inválidos resultam em 404 apropriado, nunca em erro de SQL.

### Privacidade dos dados

`GET /groups/:id/members` retorna apenas `id`, `name`, `role`, `joinedAt` —
**sem e-mail** e sem qualquer dado de autenticação (`passwordHash`, sessões,
tokens). Respostas de convite não expõem informações da conta associada.

## Alternativas consideradas

- **`ownerUserId` em `trusted_groups`**: rejeitado — duplicaria a fonte de
  verdade do papel; o índice parcial já garante um único OWNER.
- **Revelar 403 para não-membros**: rejeitado — vazaria a existência do grupo;
  preferimos 404.
- **CHECK/trigger para um OWNER**: o índice único parcial é mais simples e
  suficiente.
- **Envio real de e-mail de convite**: fora de escopo desta fase.

## Consequências

Positivas:

- Garantias fortes no banco (um OWNER, uma membership, um convite PENDING).
- Isolamento e privacidade por padrão; contratos de erro estáveis.
- Base pronta para os alertas de emergência (Phase 3).

Negativas / trade-offs:

- OWNER não pode sair até existir transferência de ownership (fase futura).
- Expiração sob demanda (sem scheduler) — convites vencidos só mudam de status
  quando lidos/aceitos.
