# Checklist de segurança para release — SafeCircle

Percorrer antes de qualquer publicação (Phase 12 — Release Candidate — e
Phase 13 — lojas). Item não verificado é item **não garantido**: não marque por
dedução. Preencha data e responsável.

Release: ____________ · Data: ____________ · Responsável: ____________

## Bloqueadores

| #   | Item                                                                                                            | OK  | Evidência |
| --- | --------------------------------------------------------------------------------------------------------------- | --- | --------- |
| 1   | **RELEASE BLOCKER — implementar fluxo completo de exclusão de conta antes da publicação nas lojas.** (ADR 0012) |     |           |
| 2   | Política de privacidade publicada e coerente com `docs/privacy/data-inventory.md`                               |     |           |
| 3   | Testes em aparelhos reais (iOS e Android) executados: login, SOS, push, localização, check-in, trajeto          |     |           |

## Segredos e configuração

| #   | Item                                                                                                                        | OK  | Evidência |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --- | --------- |
| 4   | `JWT_ACCESS_SECRET` gerado aleatoriamente (≥ 32 bytes), único de produção, guardado só no secret store                      |     |           |
| 5   | `DATABASE_URL` de produção com usuário de **menor privilégio** (só DML nas tabelas da aplicação; sem superuser, sem CREATE) |     |           |
| 6   | `METRICS_ENABLED=false`, ou `true` **com** `METRICS_TOKEN` e porta em rede privada                                          |     |           |
| 7   | `EXPO_ACCESS_TOKEN` configurado na Expo com "Enhanced Security for Push Notifications"                                      |     |           |
| 8   | `OUTBOX_ENABLED=true` (produção recusa subir sem isso)                                                                      |     |           |
| 9   | `CORS_ALLOWED_ORIGINS` só com as origens web reais, sem wildcard; vazio se não há app web                                   |     |           |
| 10  | `TRUST_PROXY` coerente com a topologia real (número de proxies à frente da API)                                             |     |           |
| 11  | `HSTS_ENABLED=true` **somente** se o TLS externo está garantido pelo ingress                                                |     |           |
| 12  | Nenhum `.env` no repositório; `.env.example` só com placeholders                                                            |     |           |
| 13  | Startup em produção validado: a API sobe com a configuração final (fail-fast passou)                                        |     |           |

## Repositório e CI

| #   | Item                                                                                                      | OK  | Evidência |
| --- | --------------------------------------------------------------------------------------------------------- | --- | --------- |
| 14  | Branch protection em `main` conforme `repository-security.md`                                             |     |           |
| 15  | CI verde no commit da release (lint, format, typecheck, testes API e mobile, build, migrations, db:check) |     |           |
| 16  | `pnpm security:audit` sem high/critical; waivers em `vulnerability-waivers.md` dentro da validade         |     |           |
| 17  | CodeQL sem achados de severidade alta abertos                                                             |     |           |
| 18  | Dependabot alerts revisados                                                                               |     |           |
| 19  | Secret scanning e push protection ligados                                                                 |     |           |
| 20  | Actions fixadas por SHA (verificar que Dependabot não introduziu tag móvel)                               |     |           |

## Rede e transporte

| #   | Item                                                                                                                       | OK  | Evidência |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --- | --------- |
| 21  | TLS terminado no ingress/proxy com certificado válido; HTTP redireciona para HTTPS                                         |     |           |
| 22  | WSS funcionando para `/realtime` através do proxy (upgrade permitido, timeouts adequados)                                  |     |           |
| 23  | Rate limits com tetos de produção (`NODE_ENV=production`)                                                                  |     |           |
| 24  | Número de réplicas conhecido: os limites por instância (rate limit, freio de login) são multiplicados por ele — aceitável? |     |           |

## Banco de dados e backups

| #   | Item                                                                           | OK  | Evidência |
| --- | ------------------------------------------------------------------------------ | --- | --------- |
| 25  | PostgreSQL com **encryption at rest** (disco/volume ou recurso do provedor)    |     |           |
| 26  | Backups **criptografados**, com retenção definida e teste de restauração feito |     |           |
| 27  | Acesso ao banco restrito à rede da API e ao operador (sem exposição pública)   |     |           |
| 28  | Migrations `0000`–`0010` aplicadas do zero em ambiente igual ao de produção    |     |           |
| 29  | Cron diário de `pnpm privacy:cleanup` agendado e testado                       |     |           |

## Mobile

| #   | Item                                                                                                              | OK  | Evidência |
| --- | ----------------------------------------------------------------------------------------------------------------- | --- | --------- |
| 30  | Refresh token só em `expo-secure-store`; nenhum token em AsyncStorage                                             |     |           |
| 31  | Permissões declaradas (`app.json`) limitadas ao necessário: localização **em uso** (não background), notificações |     |           |
| 32  | Textos de permissão explicam o uso em pt-BR                                                                       |     |           |
| 33  | `EXPO_PUBLIC_API_URL` aponta para produção via HTTPS                                                              |     |           |
| 34  | Chave do Google Maps (Android) configurada fora do repositório e restrita ao pacote                               |     |           |
| 35  | Deep links/push carregam só ids e tipo; o app busca na API                                                        |     |           |

## Operação

| #   | Item                                                                                             | OK  | Evidência |
| --- | ------------------------------------------------------------------------------------------------ | --- | --------- |
| 36  | Runbook lido pelo plantão; contatos definidos                                                    |     |           |
| 37  | `incident-response.md` revisado; canal de incidente existe                                       |     |           |
| 38  | Alertas externos configurados para os sinais do runbook (§12) e de segurança (incident-response) |     |           |
| 39  | Logs com retenção definida e sem dado sensível (redaction verificada por teste)                  |     |           |

## Assinaturas

Segurança: ____________ · Produto: ____________ · Operação: ____________
