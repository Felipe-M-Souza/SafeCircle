# Achados em aparelho — 2026-09-16 (APK preview 8dd7ce01)

Primeira execução do SafeCircle em um aparelho Android físico, pelo
proprietário, com o APK `preview-apk` build `8dd7ce01` apontando para a API de
preview no Railway. Três defeitos relatados; todos reproduzidos com evidência
(logs da API) e corrigidos com testes automatizados que falham sem a correção.

| #   | Relato                                                                   | Evidência nos logs da API                                                                           | Causa raiz                                                                                                                                                                                            | Correção                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "Localização do trajeto" mostra **Dados inválidos. Verifique os campos** | `POST /journeys/:id/live-location/start` → 400 em 1 ms; idem `POST /alerts/:id/live-location/start` | O `fetch` do app envia `Content-Type: application/json` em todo POST, mesmo sem corpo. O parser padrão do Fastify recusa "JSON vazio" com 400, que o app traduz como validação                        | API: corpo vazio com esse header vale como "sem corpo" (`app.ts`). App: só envia o header quando há corpo (`lib/api.ts`)                                                                     |
| 2   | Alerta **não cancela / não resolve**                                     | `POST /alerts/:id/resolve` e `/cancel` → 400 em 1 ms, repetidos a cada toque                        | Mesma causa do item 1                                                                                                                                                                                 | Mesma correção                                                                                                                                                                               |
| —   | (não relatado, visível nos logs) tempo real nunca conecta                | `GET /realtime` → 403 `realtime_origin_rejected`, a cada reconexão                                  | O WebSocket do React Native envia `Origin: https://<host da API>`; em produção, com allow-list vazia, qualquer `Origin` era recusado. A premissa "app nativo não envia Origin" só vale para o `fetch` | `isOriginAllowed` aceita **same-origin** (`Origin` igual a `protocol://host` da requisição) em qualquer modo; origens parecidas continuam 403 (`security/origins.ts`, `plugins/realtime.ts`) |
| 3   | Tela **sem rolagem**, cortando informações                               | —                                                                                                   | A home usava um `View` raiz com `flex: 1` centralizado; conteúdo maior que a tela era cortado. As demais telas usam `Screen`, que já rola                                                             | Home passa a ser um `ScrollView` com `flexGrow: 1` no conteúdo (centraliza quando cabe, rola quando não cabe)                                                                                |

## Por que os testes não pegaram antes

- Integração da API usa `app.inject` sem payload nas ações sem corpo: o
  Fastify não recebe `Content-Type` e o parser nem roda.
- O cliente E2E (`e2e/harness.ts`) só envia `Content-Type` quando há corpo, ou
  seja, comportava-se **melhor** que o app real.
- O cliente de teste de WebSocket (`ws`) não envia `Origin` por padrão; o do
  React Native envia.
- Layout: RNTL não mede altura; só um aparelho revela o corte.

## Testes adicionados (falham sem a correção)

| Teste                                                                           | O que prova                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/tests/device-client-compat.test.ts` (6)                               | resolve/cancel/live-location start com `Content-Type` e corpo vazio → 200/201; rota que exige corpo → 400 de validação; JSON malformado → 400 sem eco; `__proto__` → 400; 413 preservado |
| `apps/api/tests/security/realtime-hardening.test.ts` (+1)                       | `Origin` igual à origem da API conecta em modo estrito; outra porta ou sufixo de host → 403                                                                                              |
| `apps/api/e2e/sos.e2e.ts` (+1)                                                  | pela API real, `fetch` como o app faz (header sem corpo) inicia localização e cancela alerta                                                                                             |
| `apps/mobile/src/lib/__tests__/api-headers.test.ts` (2)                         | cliente não envia `Content-Type` em POST sem corpo; envia com corpo                                                                                                                      |
| `apps/mobile/src/screens/__tests__/AuthenticatedHomeScreen.scroll.test.tsx` (1) | raiz da home é `ScrollView` com `flexGrow` e o conteúdo abaixo da dobra está na árvore                                                                                                   |

Sem a correção do parser, `device-client-compat.test.ts` falha em 2 casos
(verificado com `git stash`).

## Impacto em documentação

ADR 0012 §12 e §14 receberam a atualização datada. `docs/security/threat-model.md`
e a matriz de autorização continuam corretos: `Origin` fora da allow-list ainda
é 403; same-origin não é uma origem de terceiros.

## Próximo passo

Redeploy da API (Railway) e nova build `preview-apk` a partir de um ramo que
contenha esta correção; nova rodada em aparelho pelo proprietário. Até lá,
device validation permanece `NOT EXECUTED` no plano manual.
