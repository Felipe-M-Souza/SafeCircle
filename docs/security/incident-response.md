# Resposta a incidentes — SafeCircle

Roteiro de plantão para incidentes de segurança e privacidade (Phase 11).
Complementa o runbook operacional. Não é parecer jurídico: obrigações de
notificação a titulares ou autoridades dependem da jurisdição e de decisão da
organização — este documento só garante que a informação necessária para essa
decisão exista e não seja destruída.

Prioridade permanente do produto: **SOS > push > realtime > check-in/trajeto >
métricas/auditoria**. Conter um incidente não pode deixar alguém sem conseguir
pedir ajuda; quando houver conflito, prefira revogar acesso a derrubar a API.

## 0. Antes de tudo

- Anote a hora em que soube e por onde (alerta de métrica, relato de usuário,
  Dependabot, CodeQL).
- Abra um canal interno único para o incidente. Nele **não** circulam
  segredos, tokens, coordenadas nem dados de usuários: só ids e requestIds.
- Uma pessoa coordena; as demais executam. Registre quem.

## 1. Conter

Escolha a menor ação que interrompe o dano:

| Situação                                        | Ação de contenção                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Conta específica comprometida                   | Revogar todas as sessões dela (§4); o usuário troca a senha assim que a troca existir (hoje: orientar a não reutilizar)                   |
| Refresh token vazado (reuso detectado)          | A API já revogou a sessão. Confirme em `auth_sessions.revoked_reason = 'REFRESH_REUSE'` e verifique se há outras sessões do mesmo usuário |
| `JWT_ACCESS_SECRET` exposto                     | **Rotacionar imediatamente** (§3). Todo access token em circulação morre; refresh tokens continuam válidos (são opacos)                   |
| `METRICS_TOKEN` exposto                         | Rotacionar; considerar `METRICS_ENABLED=false` até o deploy                                                                               |
| `EXPO_ACCESS_TOKEN` exposto                     | Revogar na conta Expo e gerar outro; o push fica degradado até o deploy — a outbox reprocessa                                             |
| Credencial do banco exposta                     | Rotacionar a senha do papel da aplicação; revisar `pg_stat_activity` por conexões estranhas                                               |
| Instância possivelmente comprometida            | Tirar do balanceador (não matar: §2), subir instância limpa, rotacionar todos os segredos                                                 |
| Dependência maliciosa publicada                 | Fixar versão anterior no lockfile, `pnpm install --frozen-lockfile`, deploy; abrir waiver ou remoção                                      |
| Vazamento de localização por bug de autorização | Deploy do fix é a contenção. Enquanto não sai: avaliar desligar temporariamente o endpoint afetado (feature flag não existe — é deploy)   |
| Credential stuffing em massa                    | Os freios já atuam por IP e por conta; se insuficiente, reduzir tetos e redeploy; não bloquear contas manualmente (DoS contra a vítima)   |

## 2. Preservar evidências

**Antes** de reiniciar, apagar ou "limpar":

1. Exporte (dump) as tabelas `audit_events`, `auth_sessions`,
   `auth_refresh_token_history` e `outbox_events` do período. Elas contêm só
   ids, hashes e códigos — podem ser guardadas no canal de evidências.
2. Copie os logs da aplicação do período (já redigidos: sem senha, token ou
   coordenada). Correlacione por `requestId`.
3. Registre a saída de `pnpm outbox:status` e `pnpm outbox:list-dead`.
4. Registre versões: `GIT_SHA`, `APP_VERSION`, `pnpm-lock.yaml`.
5. **Não** rode `pnpm privacy:cleanup` nem os `*:cleanup` até a análise
   terminar: eles apagam exatamente o que você vai querer ler.

Regra: apagar evidência "para conter" quase nunca contém; só cega.

## 3. Rotacionar segredos

Ordem recomendada quando há suspeita ampla (instância comprometida):

1. `JWT_ACCESS_SECRET` — deploy. Efeito: todo access token vale 401 na hora;
   o app renova via refresh sem o usuário perceber.
2. Credencial do PostgreSQL — no banco e no ambiente; deploy.
3. `METRICS_TOKEN` — no coletor e no ambiente.
4. `EXPO_ACCESS_TOKEN` — na conta Expo e no ambiente.
5. Tokens do GitHub/CI, se o vetor foi supply chain.

Gere valores com um gerador criptográfico (≥ 32 bytes aleatórios). Nunca
reaproveite, nunca cole em issue ou chat. Produção **recusa subir** com segredo
fraco ou placeholder (`isWeakSecret`), então um valor ruim falha cedo.

## 4. Revogar sessões

Por usuário, pela própria API (o usuário) ou pelo banco (o operador):

```sql
-- Todas as sessões ativas de um usuário
UPDATE auth_sessions
   SET revoked_at = now(), revoked_reason = 'USER_REVOKED_OTHERS', updated_at = now()
 WHERE user_id = '<uuid>' AND revoked_at IS NULL;
```

Efeito imediato: o access token deixa de valer na próxima requisição (a API
valida a sessão a cada chamada) e o WebSocket da sessão é fechado na próxima
tentativa de uso; o refresh token devolve `SESSION_REVOKED`.

Revogação em massa (todos os usuários) é a última cartada — desloga todo
mundo, inclusive quem está no meio de um SOS. Prefira rotacionar
`JWT_ACCESS_SECRET` (mata access tokens, preserva refresh) quando o problema é
token de acesso.

## 5. Avaliar auditoria e outbox

Perguntas que a trilha responde (por `actor_user_id`, `target_id`, `group_id`,
`request_id`, `created_at`):

- Quem fez login e de quando até quando (`AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGOUT`,
  `AUTH_SESSION_REVOKED`, `AUTH_OTHER_SESSIONS_REVOKED`).
- Houve reuso de refresh (`AUTH_REFRESH_REUSE_DETECTED`) — e em quais sessões.
- Quem exportou dados (`PRIVACY_EXPORT_REQUESTED`).
- Que alertas, check-ins, trajetos e sessões de localização a conta suspeita
  criou/encerrou; de que grupos saiu ou removeu pessoas.

O que a trilha **não** responde, por decisão: IP, aparelho, User-Agent e
conteúdo (coordenadas, nomes). Se a investigação precisar de origem de rede,
a fonte é o log da aplicação, correlacionado por `request_id`.

Na outbox, `outbox_events` mostra que efeitos ficaram pendentes ou em DEAD
durante o incidente — útil para saber se um push de SOS deixou de sair.

## 6. Comunicar internamente

- Um resumo por hora no canal do incidente: o que se sabe, o que foi feito,
  próximo passo, quem faz.
- Sem especulação sobre culpados; sem dados pessoais no texto.
- Decisões (rotacionou X, revogou Y) com hora e autor.
- A decisão de comunicar usuários ou autoridades é da organização, com base
  no que a análise mostrar. Este roteiro não a substitui e não a promete.

## 7. Não apagar precipitadamente

Checklist antes de qualquer `DELETE`, `TRUNCATE`, restart de banco ou
`privacy:cleanup` durante um incidente:

- [ ] O dump de evidências do §2 existe e está fora do servidor afetado?
- [ ] A ação é necessária para **conter**, ou só para "deixar limpo"?
- [ ] Alguém além de quem executa revisou?

Se qualquer resposta for não, não apague.

## 8. Pós-incidente

Em até uma semana, um documento curto em `docs/security/incidents/` (criar a
pasta no primeiro incidente) com:

1. Linha do tempo (descoberta, contenção, rotação, encerramento).
2. Vetor e causa-raiz.
3. Impacto: quantos usuários/grupos, que dados, por quanto tempo.
4. O que funcionou e o que faltou (métrica ausente, log insuficiente, teste
   que não existia).
5. Ações: cada uma com dono e prazo; as que virarem código entram no threat
   model (`threat-model.md`) e, se for o caso, na matriz de autorização.

Sem culpa individual no documento: o sistema é que falhou em impedir.

## Sinais que devem abrir este roteiro

| Sinal                                                                                           | Onde ver     |
| ----------------------------------------------------------------------------------------------- | ------------ |
| `safecircle_refresh_reuse_detected_total` > 0                                                   | `/metrics`   |
| `safecircle_auth_login_attempts_total{result="rate_limited"}` subindo                           | `/metrics`   |
| `safecircle_security_rate_limited_total{route_group="auth"}` em pico                            | `/metrics`   |
| Evento `auth_refresh_reuse_detected` ou `realtime_origin_rejected` em volume                    | logs         |
| Alerta do Dependabot high/critical ou `pnpm security:audit` falhando                            | GitHub / CI  |
| Achado do CodeQL de severidade alta                                                             | Aba Security |
| Relato de usuário: "recebi alerta de grupo que não é meu", "vi localização de quem não conheço" | suporte      |
