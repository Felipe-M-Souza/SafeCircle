# Checklist de segurança do repositório

Configurações do GitHub que **não** vivem no código e precisam ser verificadas
manualmente (Phase 11). Este documento não afirma que nada abaixo está ligado:
cada item tem uma coluna de verificação para ser preenchida por quem tem
acesso às configurações do repositório `Felipe-M-Souza/SafeCircle`.

Última verificação registrada: **não verificada** (preencher).

## Segredos

| Item                                      | Onde                                       | Verificado em | Por |
| ----------------------------------------- | ------------------------------------------ | ------------- | --- |
| Secret scanning habilitado                | Settings → Code security → Secret scanning |               |     |
| Push protection habilitada                | Settings → Code security → Push protection |               |     |
| Nenhum secret no histórico (`git log -p`) | Revisão manual + secret scanning           |               |     |
| `.env` ignorado e nunca commitado         | `.gitignore` (verificado por código: sim)  | sim (código)  | —   |

Se um segredo já foi commitado alguma vez, considere-o comprometido e
**rotacione** — remover do histórico não desfaz a exposição.

## Dependências

| Item                                   | Onde                                                   | Verificado em | Por |
| -------------------------------------- | ------------------------------------------------------ | ------------- | --- |
| Dependabot alerts habilitado           | Settings → Code security → Dependabot alerts           |               |     |
| Dependabot security updates habilitado | Settings → Code security → Dependabot security updates |               |     |
| `.github/dependabot.yml` presente      | Repositório (verificado por código: sim)               | sim (código)  | —   |
| `pnpm security:audit` no CI            | `.github/workflows/ci.yml` (sim)                       | sim (código)  | —   |
| CodeQL habilitado                      | `.github/workflows/codeql.yml` (sim) + aba Security    | sim (código)  |     |

## Branch protection (`main`)

| Item                                                                      | Verificado em | Por |
| ------------------------------------------------------------------------- | ------------- | --- |
| Require a pull request before merging                                     |               |     |
| Require approvals (mínimo 1)                                              |               |     |
| Dismiss stale approvals when new commits are pushed                       |               |     |
| Require status checks to pass: `Lint, typecheck, testes e build`          |               |     |
| Require status checks to pass: `Análise estática (JavaScript/TypeScript)` |               |     |
| Require branches to be up to date before merging                          |               |     |
| Require conversation resolution before merging                            |               |     |
| Do not allow bypassing the above settings                                 |               |     |
| Restrict force pushes / deletions                                         |               |     |

Observação: com um único mantenedor, "require approvals" bloqueia o próprio
autor de aprovar (o GitHub recusa auto-aprovação). É o comportamento esperado
no fluxo das fases: o PR fica **Ready for Review** e o merge é humano.

## Actions

| Item                                                                 | Onde                                                | Verificado em | Por |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------- | --- |
| `permissions: contents: read` nos workflows                          | `ci.yml`, `codeql.yml` (sim)                        | sim (código)  | —   |
| Actions fixadas por SHA de commit                                    | `ci.yml`, `codeql.yml` (sim)                        | sim (código)  | —   |
| Workflow permissions padrão = "Read repository contents"             | Settings → Actions → General → Workflow permissions |               |     |
| "Allow GitHub Actions to create and approve pull requests" desligado | Settings → Actions → General                        |               |     |
| Actions permitidas: só GitHub e verified creators (ou lista)         | Settings → Actions → General → Actions permissions  |               |     |

SHAs fixados nesta fase (verificados via API do GitHub em 2026-09-15):

| Action                 | Versão  | SHA                                        |
| ---------------------- | ------- | ------------------------------------------ |
| `actions/checkout`     | v4.4.0  | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node`   | v4.4.0  | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `pnpm/action-setup`    | v4.4.0  | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` |
| `github/codeql-action` | v4.38.0 | `b96794f015dfd88f77b49b1c93e0fa7110f94c63` |

Dependabot (`github-actions`) propõe a atualização desses SHAs.

## Revisão

| Item                                                                       | Verificado em | Por |
| -------------------------------------------------------------------------- | ------------- | --- |
| CODEOWNERS (se houver mais de um mantenedor)                               |               |     |
| Regra de que PR de dependência é revisado antes do merge                   |               |     |
| Convite de colaboradores exige 2FA (Settings da organização, se aplicável) |               |     |

## Como usar

Antes de cada release (ver `release-security-checklist.md`), percorra as
tabelas e preencha data e responsável. Item não verificado é item **não
garantido** — não marque por dedução.
