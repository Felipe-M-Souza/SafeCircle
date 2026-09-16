# ADR 0013 — E2E e Release Candidate

## Status

Aceito — Phase 12 (E2E / Release Candidate). Última fase antes da publicação.
O foco não foi adicionar funcionalidade: foi provar que o sistema funciona
ponta a ponta em condições próximas das reais, fechar o bloqueador de release
da Phase 11 e produzir um candidato reproduzível. Classificação da entrega:
**RC PREPARED — DEVICE VALIDATION PENDING**.

## Contexto

Até a Phase 11 o SafeCircle tinha testes de integração (Fastify `inject`, banco
real), testes de componente no mobile e hardening documentado. Faltava o que só
um processo real revela — worker e schedulers rodando de verdade, restart com
backlog, WebSocket atravessando um servidor HTTP, banco caindo e voltando — e
faltava resolver a exclusão de conta, registrada como **RELEASE BLOCKER**.

Restrição honesta do ambiente desta fase: **nenhum aparelho físico, emulador ou
credencial EAS/Apple/Google disponível**. Tudo que depende de plataforma foi
preparado (flows, plano, builds) e marcado como não executado, sem inventar
resultado.

## Decisões

### 1. E2E da API como suíte black-box sobre o processo real

`pnpm e2e:api` sobe `src/server.ts` via tsx (não `buildApp` + `inject`) sobre
um banco PostgreSQL descartável (`safecircle_e2e`), com worker da outbox,
schedulers e rate limits reais em perfil relaxado, e fala com ele por HTTP e
WebSocket. Vinte e um cenários cobrem auth, grupos, SOS, check-in, trajeto,
privacidade, exclusão de conta, recuperação da outbox e observabilidade.

Por que separado da suíte de integração: o `inject` é rápido e determinístico
para regras de negócio, mas não exercita o servidor HTTP, o ciclo de vida dos
plugins, o polling do worker nem o shutdown. O E2E existe para esses. Roda no
CI (Linux, PostgreSQL em container) — o pipeline principal não depende de
aparelho.

### 2. Ambiente E2E reproduzível, sem provedores reais

- Banco: criado e migrado do zero pelo global setup; `pnpm e2e:reset` zera;
  `pnpm e2e:seed` cria duas pessoas e um grupo sintéticos (`*.e2e@safecircle.test`).
- `PUSH_PROVIDER=noop`: um provedor que marca como enviado sem chamar a Expo.
  Recusado em produção pela validação de configuração.
- `RATE_LIMIT_PROFILE=relaxed` e `SCHEDULER_POLL_INTERVAL_MS=1000`: o
  vencimento de check-in/trajeto é observado em segundos, não em 15 minutos,
  **sem alterar o comportamento de produção** — produção ignora o perfil
  relaxado e o intervalo tem piso de 1 s.
- Dados sempre sintéticos: e-mails no domínio reservado, coordenadas no oceano,
  nenhum push token real.

### 3. Exclusão de conta: o bloqueador resolvido

`POST /me/delete-account` com **reautenticação por senha** (um access token
roubado não apaga uma vida digital), precedido por `GET /me/account-deletion`
que devolve bloqueios e impacto para o app explicar antes de pedir a senha.

Política de ownership: a exclusão é **bloqueada** enquanto a pessoa for OWNER
de um grupo com outros membros (`ACCOUNT_DELETION_BLOCKED_BY_GROUP_OWNERSHIP`).
Para resolver sem expulsar a própria família, foi adicionado
`POST /groups/:id/transfer-ownership`: o OWNER passa a propriedade a outro
membro e vira ADMIN. Grupo em que a pessoa é a única sai junto com a conta.
Nunca há transferência automática nem grupo apagado com outros membros dentro.

Recursos ativos: alerta ACTIVE, check-in ou trajeto ACTIVE/OVERDUE **bloqueiam**
(`ACCOUNT_DELETION_BLOCKED_BY_ACTIVE_RESOURCES`), com os ids na resposta. Uma
emergência nunca é cancelada em silêncio por uma exclusão.

Decisão por entidade (transação única, linha do usuário travada com `FOR UPDATE`):

| Entidade                                            | Decisão                                                                                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perfil, sessões, histórico de refresh, push devices | Apagados (cascade)                                                                                                                                                                                                |
| Grupos em que era a única pessoa                    | Apagados                                                                                                                                                                                                          |
| Memberships em outros grupos                        | Removidas; grupo fica; membros recebem o evento de membership; auditoria sem ator                                                                                                                                 |
| Alertas, check-ins, trajetos próprios (encerrados)  | Apagados, com localização, sessões ao vivo e confirmações de terceiros **sobre eles** — sem o alerta, "vi" de outra pessoa não significa nada                                                                     |
| Confirmações próprias em alertas de outros          | Apagadas                                                                                                                                                                                                          |
| Convites enviados e convites para o e-mail          | Apagados (o e-mail é PII)                                                                                                                                                                                         |
| Auditoria                                           | Fica pelo prazo de retenção com `actor_user_id` nulo (SET NULL); metadata sem PII — não reidentificável                                                                                                           |
| Outbox                                              | Nada apagado nem "fingido". Eventos PENDING que citam a pessoa são entregues **anonimizados**: o handler de auditoria trata violação de FK (ator/grupo já apagados) inserindo com ator nulo. Testado: nenhum DEAD |

Auditoria da própria exclusão: `ACCOUNT_DELETION_REQUESTED` e
`ACCOUNT_DELETION_COMPLETED`, ambos com ator nulo desde a origem e o id da
conta como alvo (uuid, não PII). No app, fluxo em quatro etapas sem dark
patterns: consequências → bloqueios → senha → confirmação com "Cancelar" tão
visível quanto "Excluir". Depois do 204 o SecureStore é limpo, o realtime cai
(4403) e o app volta à tela pública; nenhum reconnect.

Idempotência/retry: uma segunda tentativa após o sucesso recebe 401 (a sessão
não existe); duas tentativas simultâneas produzem uma 204 e uma 401 e um único
evento de conclusão.

### 4. Smoke, release:check e bug bar

- `pnpm smoke:api`: nove etapas contra uma API em execução (health, ready,
  registro, login, grupo, alerta, resolve, logout, login + exclusão da própria
  conta de teste). Medido: 402 ms.
- `pnpm release:check`: lint, format, typecheck, testes, build, auditoria de
  dependências, `db:check`, consistência das migrations, bloqueadores e E2E da
  API, em sequência, com resumo. Não constrói binário mobile.
- `pnpm release:blockers`: lê `docs/release/release-blockers.md` e falha com
  BLOCKER em aberto ou HIGH sem decisão. Roda no CI. É o que impede declarar RC
  com um bloqueador esquecido.

### 5. Background location: Opção B — foreground-only na v1

Não havia como validar TaskManager, foreground service Android, background
modes iOS, consentimento separado e indicador do sistema em aparelhos físicos.
Implementar pela metade seria fingir suporte. Decisão: manter foreground-only,
que já era o comportamento (ADRs 0007 e 0009); tornar isso explícito na UI ("A
localização ao vivo é atualizada enquanto o SafeCircle está aberto."), bloquear
as permissões de background na configuração nativa (`blockedPermissions`, sem
`isIosBackgroundLocationEnabled`) e declarar nas lojas que não há coleta em
segundo plano. Reavaliar em fase futura, com aparelhos.

### 6. Ambientes e configuração

Três ambientes: `development`, `preview`, `production`, espelhados em
`eas.json` (perfis de build, canais e `EXPO_PUBLIC_APP_ENV`/`EXPO_PUBLIC_API_URL`
por perfil). As URLs de preview/produção são placeholders `.invalid` até existir
staging real — não inventamos endpoint. Metadados de build: `APP_VERSION`,
`GIT_SHA`, `BUILD_DATE` na API (log de startup) e versão + ambiente + commit
curto no rodapé da home do app, sempre públicos, nunca segredos.

Versão: **0.1.0-rc.1** nos pacotes; `0.1.0` no `app.json` (as lojas exigem
versão numérica). Não é `1.0.0` e não há tag automática.

### 7. Identidade e permissões nativas

`com.safecircle.app` em iOS e Android; permissões Android limitadas a
localização em uso e notificações, com bloqueio explícito de background
location, câmera, microfone, contatos, armazenamento e Bluetooth;
`usesCleartextTraffic=false`; `allowBackup=false`; iOS com
`NSLocationWhenInUseUsageDescription` em pt-BR e sem background modes.

### 8. Validação em aparelho: preparada, não executada

`docs/release/manual-device-test-plan.md` lista cada teste de plataforma com
resultado `NOT EXECUTED`. Os flows Maestro (`apps/mobile/e2e/*.yaml`) foram
escritos com textos e `testID`s reais do app (auth, grupos, SOS, exclusão) e
não foram executados. Nenhum resultado foi preenchido por dedução. Enquanto
isso não acontecer, o RC não é `RC READY`.

### 9. Ensaios operacionais executados

Migrations do zero (~4 s) e reexecução idempotente; backup/restore com
`pg_dump`/`pg_restore` em dataset sintético com contagens idênticas; queda do
banco com API viva (`/ready` 503, `/health` 200, recuperação em 1 s, worker
retoma); restart da API com backlog na outbox (E2E); retenção consolidada;
carga moderada de 30 usuários virtuais por 20 s (520 req/s, 0 erros, p95 de
leitura < 80 ms, memória volta ao patamar após a carga, cardinalidade de
métricas estável). Números reais em `docs/release/test-report.md`.

### 10. Rollback

`docs/release/rollback-plan.md`: rollback da API é reimplantar o commit
anterior; **não existem down migrations** e todas as migrations até aqui são
aditivas, o que torna o rollback de API viável; restauração de backup é último
recurso com perda de dados explícita; o app não volta — a API mantém
compatibilidade (nenhum contrato removido; `/v2` rejeitado).

## Alternativas consideradas

- **Detox / Appium para mobile**: rejeitados; Maestro é mais simples,
  black-box e adequado ao Expo. Mesmo assim, não executado aqui.
- **E2E mobile no pipeline principal**: rejeitado; emulador em CI é caro e
  instável. Smoke/API no CI; mobile em job manual.
- **Excluir conta apagando o grupo com outros membros**: rejeitado; dado de
  terceiros. Bloqueio + transferência de propriedade.
- **Transferir ownership automaticamente para o ADMIN mais antigo**: rejeitado;
  sem consentimento.
- **Cancelar recursos ativos ao excluir**: rejeitado; emergência não se cancela
  em silêncio.
- **Anonimizar em vez de apagar alertas/check-ins/trajetos próprios**:
  considerado; rejeitado porque a parte com valor para o grupo (o fato de que
  houve um alerta) já vive na auditoria anonimizada, e manter linhas de domínio
  órfãs complicaria toda consulta.
- **Aguardar a outbox drenar antes de apagar**: rejeitado; handlers tolerantes
  a entidade ausente são mais simples e não deixam a exclusão à mercê de um
  worker parado.
- **Down migrations**: não criadas; prometer reversão automática que nunca foi
  testada seria pior do que documentar forward-fix e restore.
- **Background location (Opção A)**: rejeitada nesta fase por impossibilidade
  de validação real.
- **Tag `v0.1.0-rc.1` automática**: não criada; preferência da spec.

## Consequências

Positivas: o bloqueador de release está fechado com testes de integração e E2E;
existe uma suíte que sobe o servidor de verdade e falha quando worker,
scheduler, WebSocket ou restart quebram; há um comando único de verificação de
RC e um gate de bloqueadores no CI; a exclusão de conta é transacional,
bloqueia o que deve bloquear e não toca em terceiros; a decisão de foreground
está declarada onde importa (UI, config nativa, lojas).

Negativas: o E2E acrescenta ~30 s ao CI e exige PostgreSQL; a exclusão de
conta impõe pré-condições que o usuário precisa resolver (transferência,
encerrar emergências) — correto, mas mais fricção; a validação de plataforma
continua pendente e o RC não pode ser chamado de pronto; as URLs de preview e
produção ainda são placeholders.

## Limites

- Nada foi validado em aparelho físico; push real, permissões, GPS, deep
  links, offline no app, background e bateria são `NOT EXECUTED`.
- Nenhum binário foi gerado (sem credenciais).
- Graceful shutdown não é observável no ambiente Windows de desenvolvimento;
  é verificado no CI (Linux) pelo E2E de recuperação da outbox: SIGTERM →
  socket 1001/`SERVER_SHUTDOWN` e logs `shutdown_started`/`shutdown_completed`.
- Sem staging real: configuração preparada, endpoint não inventado.

## Itens para a Phase 13

Publicação nas lojas (após `RC READY`), política de privacidade final a partir
de `privacy-policy-inputs.md`, declarações das lojas a partir de
`store-disclosure-inputs.md`, troca e recuperação de senha, tela de exportação
de dados, prazos para convites processados e push devices inativos, crash
reporting (avaliar), domínio/TLS/backups definitivos, secrets manager,
execução do plano manual e das builds EAS, preenchimento dos checklists de
release e de segurança do repositório.
