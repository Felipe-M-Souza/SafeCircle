# Plano de rollback — SafeCircle

Como voltar atrás depois de um deploy ruim (Phase 12 §76, §105–108). Escrito
antes do primeiro release para não ser improvisado durante um incidente.

Princípio: **a API volta; o app não volta.** Um binário distribuído nas lojas
continua instalado nos aparelhos por dias ou semanas. Por isso a compatibilidade
de contrato é responsabilidade da API, e rollback de API só é seguro quando a
versão anterior ainda entende o que o app atual envia.

## 1. Rollback da API

| Situação                                                    | Ação                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Bug de aplicação sem mudança de schema                      | Reimplantar a imagem/commit anterior. Nenhum dado é afetado                                           |
| Bug com migration **aditiva** aplicada (coluna/tabela nova) | Reimplantar a versão anterior **sem** reverter o schema: colunas novas ficam sem uso e não atrapalham |
| Bug com migration que mudou semântica de dados              | Não reverter a API sozinha: forward-fix (§4). Reverter a API sobre dados já convertidos corrompe      |
| API não sobe (fail-fast de configuração)                    | Não é rollback: corrija a variável apontada na mensagem e reimplante                                  |

Passos:

1. Congelar deploys; abrir canal de incidente (`docs/security/incident-response.md`).
2. Identificar o último commit bom (`GIT_SHA` no log `application_ready`).
3. Reimplantar esse commit com a **mesma configuração** (envs) — segredos não mudam.
4. Confirmar `/ready` = 200, `outbox_worker_started` no log, `pnpm outbox:status` sem backlog crescendo.
5. Rodar `pnpm smoke:api` contra o ambiente.

## 2. Migrations: o que existe e o que não existe

- **Não existem down migrations.** As migrations do Drizzle (`0000`–`0010`) são
  só para frente; este documento não promete reversão automática de schema.
- Todas as migrations até aqui são **aditivas** (tabelas e colunas novas,
  índices). Nenhuma apaga ou renomeia coluna em uso. Isso é o que torna o
  rollback de API viável: a versão N-1 ignora o que N adicionou.
- Regra para o futuro: mudança destrutiva de schema exige duas releases
  (expand → contract) e nota explícita no `rc-release-notes.md`.
- Ensaio executado nesta fase: migrations do zero em ~4 s, reexecução
  idempotente, aplicação sobre dataset sintético restaurado (no-op). Ver
  `rc-evidence.md`.

## 3. Restaurar o banco

Último recurso, quando dados foram corrompidos (não para bug de código).

1. **Preservar evidências antes** (dump do estado atual) — ver incident-response §2.
2. Colocar a API em manutenção (tirar do balanceador). `/ready` responderá 503
   quando o banco sumir; o app mostra erro genérico e não perde o SOS já
   registrado localmente (a intenção fica com a `Idempotency-Key`).
3. Restaurar o backup mais recente **anterior** ao problema:

```bash
pg_restore -h <host> -U <usuario> -d <banco_novo> <arquivo.dump>
```

Ensaio local desta fase: `pg_dump -Fc` (292 ms) e `pg_restore` (521 ms) sobre
o banco E2E, com contagens idênticas em todas as tabelas — números reais,
dataset pequeno. Produção terá tempos proporcionais ao volume. 4. Apontar a API para o banco restaurado (ou renomear) e reimplantar. 5. Aceitar e comunicar a **perda de dados** entre o backup e a restauração:
alertas, check-ins e trajetos criados nesse intervalo não existem mais.
Outbox pendente daquele intervalo também não: efeitos não entregues se
perdem junto. Não há como recuperar sem o WAL. 6. Refresh tokens emitidos depois do backup deixam de existir → esses
aparelhos caem para a tela de login. Comportamento esperado.

Requisitos que este plano assume e que são da infraestrutura: backups
automáticos, criptografados, com retenção definida e restauração testada
(`docs/security/release-security-checklist.md` itens 25–27).

## 4. Forward-fix

Preferido sempre que o problema é de código e o schema já avançou: corrigir,
testar (`pnpm release:check`), reimplantar. Mais rápido e menos arriscado do
que reverter sobre dados novos.

## 5. Rollback mobile: limitações

- Não existe "voltar" o app no aparelho do usuário. Lojas permitem interromper
  o rollout e publicar uma versão nova; a antiga continua instalada até o
  usuário atualizar.
- Consequência: **a API precisa tolerar o app antigo e o novo ao mesmo tempo**
  durante qualquer rollout. Contratos existentes não mudam (§6); campos novos
  são aditivos e opcionais.
- Kill switch remoto não existe nesta versão (decisão: sem serviço de
  configuração remota na v1). Se um app precisar ser retirado de circulação, o
  caminho é uma release nova nas lojas.

## 6. Compatibilidade de versões

| Par                   | Garantia                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App antigo × API nova | Funciona: nenhuma rota, código de erro ou envelope realtime existente mudou até a Phase 12. Códigos novos (413/415, exclusão de conta) só aparecem em situações novas                                                                                                                                                                                                           |
| App novo × API antiga | Funciona para tudo exceto o que a API antiga não tem (`/me/sessions`, `/me/privacy/export`, `/me/delete-account`, transferência de propriedade): o app recebe 404 `NOT_FOUND` e mostra erro genérico. Não quebra                                                                                                                                                                |
| Outbox entre versões  | O payload é versionado (`version: 1`). Versão desconhecida vai para DEAD com `UNSUPPORTED_EVENT_VERSION`, sem travar o worker. Eventos pendentes de N são processados por N-1 enquanto os tipos existirem em ambos; tipos novos (auditoria de sessão/exclusão) em N-1 viram DEAD `UNKNOWN_EVENT_TYPE` e podem ser reprocessados com `pnpm outbox:retry-dead` após reimplantar N |
| Sem `/v2`             | Decisão: preservar contratos em vez de versionar a URL (§108 da spec)                                                                                                                                                                                                                                                                                                           |

## 7. Checklist rápido de rollback

- [ ] Evidências preservadas (dump, logs, `outbox:status`).
- [ ] Commit alvo identificado pelo `GIT_SHA` do log.
- [ ] Migrations desde o alvo são todas aditivas? Se não, forward-fix.
- [ ] Reimplantação feita com a configuração vigente.
- [ ] `/ready` 200, worker iniciado, `pnpm smoke:api` verde.
- [ ] Backlog da outbox drenando (`pnpm outbox:status`); DEAD revisado.
- [ ] Comunicação interna registrada com hora e autor.
