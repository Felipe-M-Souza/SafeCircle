# ADR 0014 — Avisar quem foi convidado (push e e-mail)

Status: aceito — 2026-09-17
Contexto: Phase 13, primeira leva de melhorias depois da validação em aparelho.

## Problema

Até a Phase 12 o convite existia, mas ninguém era avisado. Quem convidava
digitava o e-mail e a pessoa convidada só descobria se abrisse o app por conta
própria e entrasse em "Convites recebidos". Na prática, um convite para quem
ainda não usa o SafeCircle não chegava nunca: a pessoa não tinha motivo para
instalar o app.

## Decisão

Ao criar um convite, a mesma transação enfileira três efeitos na outbox:

| Efeito                           | Destinatário                                         | Quando não acontece                                 |
| -------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `PUSH_GROUP_INVITATION_CREATED`  | a pessoa convidada, se já tem conta e aparelho ativo | sem conta, sem aparelho, ou convite já resolvido    |
| `EMAIL_GROUP_INVITATION_CREATED` | o endereço convidado                                 | sem provedor SMTP (`noop`), ou convite já resolvido |
| `AUDIT_GROUP_INVITATION_CREATED` | trilha de auditoria                                  | nunca                                               |

### 1. O endereço nunca entra na outbox

O payload leva apenas `invitationId` e `groupId`. O handler carrega
`group_invitations.invited_email` **no momento da entrega**. Três consequências,
todas desejáveis:

- A outbox é uma tabela durável; e-mail é PII e não deve ficar lá (ADR 0011).
- Convite revogado, aceito, recusado ou expirado entre o commit e a entrega
  simplesmente não gera aviso — o handler vê o status atual, não o do passado.
- O convite apagado junto com o grupo ou a conta não deixa evento órfão que
  falha para sempre.

### 2. Push de convite quebra a regra "destinatários = membros do grupo"

Todos os outros pushes carregam os tokens dos membros do grupo. Quem foi
convidado **ainda não é membro**, então o handler resolve o destinatário pelo
e-mail do convite. Sem conta ou sem aparelho ativo, não há push e isso não é
erro: o evento fica `PROCESSED`, porque não há nada a entregar.

### 3. Dois provedores: API HTTP do Resend e SMTP genérico

`EmailProvider` com três implementações, no mesmo padrão do push:
`ResendApiEmailProvider` (HTTP), `SmtpEmailProvider` (nodemailer) e
`NoopEmailProvider`. A escolha vira configuração de ambiente, não dependência
de código.

A primeira decisão foi só SMTP, por portabilidade: funciona com Resend,
SendGrid, Amazon SES, Postmark ou Gmail. **Isso quebrou na hospedagem.** O
Railway bloqueia portas SMTP de saída (465 e 587) fora do plano Pro, e a
conexão expira com `ETIMEDOUT` antes de qualquer autenticação — verificado em
produção em 2026-09-17, com o mesmo endereço respondendo normalmente de fora.

A API HTTP do Resend usa a porta 443, que nenhuma hospedagem bloqueia, e foi
por isso que a abstração existia: adicionar o caminho custou uma classe, sem
tocar no domínio. O SMTP fica para quem hospedar em outro lugar.

Ganho colateral do caminho HTTP: a API do Resend aceita `Idempotency-Key`.
Como a outbox é at-least-once, reprocessar um evento entregaria o convite duas
vezes; com o id do evento como chave, o provedor descarta a repetição.

O padrão é `noop`, inclusive em produção. Diferente do push, e-mail **não** é
recusado em produção sem configuração: o convite continua funcionando dentro do
app, e um deploy sem SMTP é uma limitação conhecida, não um erro que impeça a
API de subir.

### 4. Configuração de e-mail nunca derruba a API

A validação inicial recusava o boot quando o provedor escolhido estava sem
credencial. Parecia prudente e estava errado: derrubou o serviço inteiro duas
vezes durante a configuração, deixando SOS, alertas e trajetos fora do ar por
causa de **convite por e-mail**.

`selectEmailProvider` passou a cair para `noop` com um log de erro explícito
(`email_provider_misconfigured`, nomeando a variável que falta). O e-mail
desliga, o resto continua. O log é alto de propósito: silenciar levaria a
descobrir meses depois que nenhum convite chegou.

### 5. Falha permanente contra falha transitória

Resposta SMTP 5xx (endereço inexistente, domínio recusando) é permanente: o
evento vai para DEAD sem gastar retries. Qualquer outra falha — conexão,
autenticação, limite temporário — é transitória e volta pela outbox. Política da
família `email`: 6 tentativas, TTL de 24 h. Um convite vale 7 dias; depois de um
dia sem conseguir entregar, insistir não ajuda mais.

### 6. O que vai na mensagem

Nome do grupo, primeiro nome de quem convidou e a data de expiração. Nada além
disso: sem sobrenome, sem lista de membros, sem telefone, sem localização.

Isso revela o nome do grupo e um primeiro nome a quem controla aquele endereço,
inclusive se o endereço estiver errado. É inerente a um convite — sem esses dois
dados a mensagem é indistinguível de spam e ninguém aceita. O texto diz
explicitamente que nada acontece sem aceitar e que nenhum dado é compartilhado
até lá.

O e-mail não tem imagem remota, pixel de rastreamento nem link de terceiros. O
único link é o deep link do próprio app (`APP_DEEP_LINK`, público, sem token).

### 7. Log sem PII

Nem o provedor nem o handler registram o endereço: o log carrega
`fingerprintEmail`, um hash curto que serve para correlacionar uma entrega sem
expor a pessoa. Mesmo o provedor `noop`, que é usado em desenvolvimento, segue
essa regra — do contrário o log local viraria um vazamento.

## Alternativas descartadas

- **Guardar o e-mail no payload** e evitar a consulta na entrega: mais simples,
  mas coloca PII numa tabela durável e entrega convite revogado.
- **Só o SDK oficial do Resend**: amarraria o projeto a um fornecedor. A API
  HTTP é chamada com `fetch` e um corpo JSON de quatro campos; um SDK não
  acrescentaria nada além da dependência.
- **Manter só SMTP e assinar o plano Pro do Railway** para desbloquear as
  portas: cerca de 20 dólares por mês para enviar alguns convites.
- **Exigir SMTP em produção**, como o push exige `expo`: transformaria uma
  melhoria em bloqueador de deploy.
- **Link de aceite direto no e-mail** (token de uso único): aceitaria o convite
  sem abrir o app, mas cria um segredo por e-mail, um endpoint público novo e
  toda a superfície de ataque que vem junto. Fica para quando houver uma decisão
  explícita sobre isso.

## Limites conhecidos

- O caminho SMTP existe no código mas **não é exercitado no ambiente atual**:
  o Railway o bloqueia. Só foi validado em teste, não em produção.

- Sem domínio verificado e registros SPF/DKIM, o e-mail tende a cair em spam.
  Isso é configuração de infraestrutura do proprietário, não do código.
- Não há reenvio de convite pela interface: é preciso revogar e criar outro.
- O deep link abre o app, mas não navega direto para o convite; a tela de
  convites é a mesma para todos os convites pendentes.
