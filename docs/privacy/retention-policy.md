# Política de retenção — SafeCircle

Consolidação (Phase 11) das decisões de retenção tomadas fase a fase, mais as
que ainda faltavam. Regra de ouro, válida para toda categoria:

> **Nada que está ativo, pendente ou em processamento é apagado.** Só o que já
> encerrou e passou do prazo.

Execução: um único comando, em cron diário, encadeia todas as políticas:

```bash
pnpm privacy:cleanup
```

Cada etapa é independente; falha em uma não impede as outras, e o processo
termina com exit code diferente de zero nomeando a etapa. O resumo mostra
categoria e quantidade — nunca um registro individual.

## Prazos em vigor

| Categoria                                        | Prazo                                | Conta a partir de       | Etapa em `privacy:cleanup` | Decidido em |
| ------------------------------------------------ | ------------------------------------ | ----------------------- | -------------------------- | ----------- |
| Localização inicial do alerta                    | 30 dias                              | Encerramento do alerta  | `localizacao_alertas`      | ADR 0007    |
| Pontos e sessões de localização ao vivo (alerta) | 30 dias                              | Encerramento do alerta  | `localizacao_alertas`      | ADR 0007    |
| Pontos e sessões de localização do trajeto       | 30 dias                              | Encerramento do trajeto | `trajetos`                 | ADR 0009    |
| Check-ins finalizados (SAFE/CANCELLED/OVERDUE)   | 90 dias                              | Finalização             | `checkins`                 | ADR 0008    |
| Trajetos finalizados (ARRIVED/CANCELLED/OVERDUE) | 90 dias                              | Finalização             | `trajetos`                 | ADR 0009    |
| Trilha de auditoria                              | 180 dias                             | Criação do evento       | `auditoria`                | ADR 0010    |
| Outbox — eventos PROCESSED                       | 30 dias                              | Processamento           | `outbox`                   | ADR 0011    |
| Outbox — eventos DEAD                            | 90 dias                              | Entrada em dead-letter  | `outbox`                   | ADR 0011    |
| Sessões expiradas ou revogadas                   | 30 dias                              | Expiração/revogação     | `autenticacao`             | ADR 0012    |
| Histórico de refresh tokens rotacionados         | Até expirar (30 dias após a rotação) | Rotação                 | `autenticacao`             | ADR 0012    |

Por que 30 dias para sessões encerradas e não zero: a linha revogada, com o
motivo (`LOGOUT`, `REFRESH_REUSE`, `SESSION_LIMIT`…), é evidência em uma
investigação de takeover. Depois de um mês ela só ocupa espaço.

## O que NUNCA é apagado por retenção

| Item                                         | Motivo                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| Alertas, check-ins e trajetos ACTIVE/OVERDUE | São a operação em andamento                             |
| Outbox PENDING/PROCESSING                    | É trabalho a fazer; apagar é perder o efeito (ADR 0011) |
| Sessões ativas                               | O usuário está logado                                   |
| Alertas encerrados (registro em si)          | Ver "sem prazo definido" abaixo                         |
| Perfil, grupos, memberships                  | Pertencem à conta; só saem com a exclusão de conta      |

## Sem prazo definido (decisões conscientes e pendências)

| Dado                                 | Situação                 | Decisão                                                                                                                                                             |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alerta encerrado (sem localização)   | Mantido indefinidamente  | **Consciente**: histórico de SOS tem valor para a pessoa e para o grupo; a parte sensível (localização) já expira em 30 d. Revisar quando houver exclusão de conta. |
| Confirmações de alerta               | Junto com o alerta       | Seguem o alerta.                                                                                                                                                    |
| Convites processados/expirados       | Mantidos                 | **Pendência**: definir 90 d após processamento em fase futura; contém e-mail do convidado.                                                                          |
| Push devices inativos                | Mantidos                 | **Pendência**: token de aparelho que saiu; definir remoção após N dias inativo (a Expo invalida o token, mas a linha fica).                                         |
| Perfil (nome, e-mail, hash de senha) | Enquanto a conta existir | Depende da **exclusão de conta**, não implementada — **RELEASE BLOCKER** (ADR 0012).                                                                                |
| Logs da aplicação                    | Fora do banco            | Política da infraestrutura de logs (sugestão: 30 d). Logs não contêm senha, token, coordenada nem corpo sensível (redaction).                                       |
| Backups do banco                     | Fora do banco            | Devem seguir o menor prazo aplicável ao dado mais sensível que contêm e ser criptografados (`docs/security/release-security-checklist.md`).                         |

## Exportação e exclusão

- **Exportação** (`GET /me/privacy/export`): não altera retenção; devolve o
  estado atual dos dados próprios.
- **Exclusão de conta** (Phase 12): `POST /me/delete-account`, com a senha atual.
  Apaga o que é da pessoa (perfil, sessões, histórico de refresh, push
  devices, alertas/check-ins/trajetos próprios com localização, confirmações,
  convites, memberships e grupos em que era a única). A auditoria fica pelo
  prazo de 180 dias com o ator anonimizado. Bloqueada enquanto houver grupo
  próprio com outros membros ou emergência em andamento. Detalhes e decisão
  por entidade no ADR 0013 §3.

## Garantias verificadas por teste

`apps/api/tests/security/privacy-cleanup.test.ts` prova, contra PostgreSQL
real, que: ACTIVE nunca é removido; só o expirado de cada categoria sai;
usuários, grupos e memberships ficam intactos; o resumo não contém ids,
e-mails nem coordenadas; e uma etapa que falha é nomeada sem derrubar as demais.
