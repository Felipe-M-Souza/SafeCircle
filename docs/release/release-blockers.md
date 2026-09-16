# Release blockers e bug bar — SafeCircle 0.1.0-rc.1

Fonte de verdade para `pnpm release:blockers` (Phase 12 §47, §97–99). O script
falha o CI se houver **BLOCKER** que não esteja `RESOLVED` ou **HIGH** que não
esteja `RESOLVED`/`ACCEPTED`.

## Bug bar

```
BLOCKER : 0 em aberto
HIGH    : 0 não aceitos
MEDIUM  : avaliados, com decisão registrada
LOW     : documentados
ACCEPTED: risco aceito com justificativa e revisão
```

Formato das linhas (lido pelo script): `| RB-nnn | Severidade | Status | Título | Referência |`.
Severidades: `BLOCKER`, `HIGH`, `MEDIUM`, `LOW`. Status: `OPEN`, `RESOLVED`, `ACCEPTED`.

## Itens

| ID     | Severidade | Status   | Título                                                                                                 | Referência                                                                             |
| ------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| RB-001 | BLOCKER    | RESOLVED | Exclusão de conta inexistente (Phase 11)                                                               | ADR 0013 §3; `tests/account-deletion.test.ts`; `e2e/privacy.e2e.ts`                    |
| RB-002 | BLOCKER    | RESOLVED | OWNER não conseguia excluir a conta sem expulsar o grupo                                               | `POST /groups/:id/transfer-ownership`; ADR 0013 §3                                     |
| RB-003 | HIGH       | RESOLVED | Advisory high no `ws` (GHSA-96hv-2xvq-fx4p)                                                            | Phase 11; `ws` 8.21.3                                                                  |
| RB-004 | HIGH       | ACCEPTED | Validação em aparelho físico não executada (push, permissões, GPS)                                     | `manual-device-test-plan.md` — todos NOT EXECUTED; RC fica `DEVICE VALIDATION PENDING` |
| RB-005 | HIGH       | ACCEPTED | Credenciais Apple/Google ausentes: sem AAB nem iOS; APK Android de preview gerado via EAS (2026-09-16) | `rc-evidence.md`; requer ação do proprietário                                          |
| RB-006 | MEDIUM     | ACCEPTED | Rate limit e freio de login por instância                                                              | ADR 0012 §5; KNOWN-001                                                                 |
| RB-007 | MEDIUM     | ACCEPTED | Push at-least-once pode duplicar raramente                                                             | ADR 0011 §7; KNOWN-002                                                                 |
| RB-008 | MEDIUM     | ACCEPTED | GPS pode ser spoofed pelo dono do trajeto/alerta                                                       | Threat model §4.14; KNOWN-003                                                          |
| RB-009 | MEDIUM     | ACCEPTED | Localização ao vivo só em primeiro plano (decisão v1)                                                  | ADR 0013 §5; KNOWN-004                                                                 |
| RB-010 | MEDIUM     | ACCEPTED | Sem troca de senha nem recuperação de conta                                                            | ADR 0012; KNOWN-005                                                                    |
| RB-011 | MEDIUM     | ACCEPTED | Advisories moderadas em ferramentas de build (esbuild via drizzle-kit, uuid via expo)                  | `docs/security/vulnerability-waivers.md` (expiram 2026-12-15)                          |
| RB-012 | LOW        | ACCEPTED | Sem MFA                                                                                                | Fora de escopo declarado                                                               |
| RB-013 | LOW        | ACCEPTED | Enumeração de contas possível via registro (409), limitada por rate limit                              | ADR 0012 §6                                                                            |
| RB-014 | LOW        | ACCEPTED | Tela de exportação de dados no app não existe (só API)                                                 | Phase 13                                                                               |
| RB-015 | LOW        | ACCEPTED | Configurações de segurança do GitHub são manuais e não verificadas por código                          | `docs/security/repository-security.md`                                                 |

## Leitura

- **Critical blockers = 0.** Os dois BLOCKERs desta fase estão resolvidos e
  cobertos por testes de integração e E2E.
- Os dois HIGH aceitos (RB-004, RB-005) não são defeitos de código: são
  validações que exigem aparelho físico e credenciais que este ambiente não
  tem. Por isso a classificação do RC é **RC PREPARED — DEVICE VALIDATION
  PENDING**, não `RC READY`. Assim que forem executadas (ou obtidas), mudam
  para `RESOLVED` e a classificação pode ser revista.
- Um novo BLOCKER em aberto derruba o CI (`pnpm release:blockers`) e impede
  declarar RC final.

## Como registrar um item novo

1. Adicione uma linha com o próximo `RB-nnn`, severidade e status `OPEN`.
2. Referencie a evidência (teste, ADR, documento).
3. `pnpm release:blockers` passa a falhar até o status mudar — é o comportamento
   desejado.
