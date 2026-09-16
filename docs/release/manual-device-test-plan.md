# Plano de testes manuais em aparelho — SafeCircle 0.1.0-rc.1

Testes que **dependem de plataforma** e não podem ser provados por automação
de API (Phase 12 §50–59, §89, §113–121). Cada item recebe um dos resultados:

```
PASS · FAIL · NOT EXECUTED · NOT APPLICABLE
```

**Estado desta entrega: todos os itens estão `NOT EXECUTED`.** Não havia
aparelho físico, emulador nem credenciais EAS no ambiente em que a Phase 12 foi
produzida, e este plano não é preenchido por dedução. Enquanto estiver assim, o
RC é `RC PREPARED — DEVICE VALIDATION PENDING`, não `RC READY`.

Pré-requisitos: development build (não Expo Go — push e permissões exigem build
nativa), API E2E ou staging com `PUSH_PROVIDER=expo` e `EXPO_ACCESS_TOKEN`,
duas contas (`pnpm e2e:seed`), coordenadas **sintéticas** no simulador de GPS.
Nunca usar endereço pessoal.

Matriz mínima: Android atual + Android uma versão anterior + 1 aparelho físico
Android; iOS atual + 1 iPhone físico. Sem iPhone disponível → registrar como
pendência real.

Legenda de colunas: A = Android emulador atual · A-1 = Android versão anterior
· AF = Android físico · iS = iOS simulador · iF = iPhone físico.

## 1. Instalação e identidade

| #   | Teste                                                       | A            | A-1          | AF           | iS           | iF           |
| --- | ----------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| 1.1 | Build instala; nome "SafeCircle", ícone, splash             | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 1.2 | Rodapé da home mostra versão e ambiente (`0.1.0 · preview`) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 1.3 | Bundle não contém segredos (ver §12)                        | NOT EXECUTED | —            | —            | NOT EXECUTED | —            |

## 2. Permissões — notificações

| #   | Teste                                                                   | A            | A-1          | AF           | iS           | iF           |
| --- | ----------------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| 2.1 | Primeira solicitação aparece no momento certo (não no primeiro segundo) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 2.2 | Permitir → token registrado (`POST /me/push-devices` 201)               | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 2.3 | Negar → app segue funcionando; card explica como ativar                 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 2.4 | Negado permanentemente → abrir Configurações do sistema e voltar ao app | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

## 3. Permissões — localização

| #   | Teste                                                                         | A            | A-1          | AF           | iS           | iF           |
| --- | ----------------------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| 3.1 | Solicitada só ao acionar SOS / ativar compartilhamento (texto em pt-BR)       | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 3.2 | Permitir "enquanto usa" → posição capturada                                   | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 3.3 | Negar → SOS **ainda é enviado** (sem localização); UI informa                 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 3.4 | Negado permanentemente → orientação para Configurações; SOS continua possível | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 3.5 | O sistema **não** oferece "Sempre permitir" (sem background)                  | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

## 4. GPS (coordenadas sintéticas)

| #   | Teste                                                           | A            | A-1          | AF           | iS           | iF           |
| --- | --------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| 4.1 | Localização disponível → mapa mostra a posição sintética        | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 4.2 | GPS desligado → erro claro; SOS sem localização segue           | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 4.3 | Baixa precisão → indicador de precisão exibido                  | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 4.4 | Mudança de posição → membro vê atualização em poucos segundos   | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 4.5 | Sem atualização por >1 min → indicador de posição desatualizada | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 4.6 | Parar compartilhamento → membro vê "encerrado"; coleta cessa    | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

## 5. Foreground-only (decisão da v1)

| #   | Teste                                                                              | A            | A-1          | AF           | iS           | iF           |
| --- | ---------------------------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ |
| 5.1 | UI diz que a localização é atualizada enquanto o app está aberto                   | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 5.2 | App em segundo plano → updates **param** (por design); ao voltar, retomam          | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 5.3 | Tela bloqueada → idem                                                              | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 5.4 | Nenhum indicador de localização em background do sistema aparece com o app fechado | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

## 6. Push real (SOS, check-in vencido, trajeto atrasado — cada um)

| #   | Teste                                                                              | AF           | iF           |
| --- | ---------------------------------------------------------------------------------- | ------------ | ------------ |
| 6.1 | App em primeiro plano: notificação/atualização chega                               | NOT EXECUTED | NOT EXECUTED |
| 6.2 | App em segundo plano: notificação do sistema chega; conteúdo sem nome/local        | NOT EXECUTED | NOT EXECUTED |
| 6.3 | App fechado: notificação chega                                                     | NOT EXECUTED | NOT EXECUTED |
| 6.4 | Toque na notificação → abre a tela do recurso certo                                | NOT EXECUTED | NOT EXECUTED |
| 6.5 | Cold start pelo toque → login restaurado → tela do recurso com estado atual (REST) | NOT EXECUTED | NOT EXECUTED |
| 6.6 | Notificação duplicada (at-least-once) não quebra a UI                              | NOT EXECUTED | NOT EXECUTED |
| 6.7 | Logout desativa o aparelho; nenhum push chega depois                               | NOT EXECUTED | NOT EXECUTED |

## 7. Offline e reconexão (alertas, check-ins, trajetos, localização ao vivo)

| #   | Teste                                                                               | A            | AF           | iS           | iF           |
| --- | ----------------------------------------------------------------------------------- | ------------ | ------------ | ------------ | ------------ |
| 7.1 | Modo avião → ações falham com mensagem de rede; nada trava                          | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 7.2 | SOS offline → ao reconectar, o retry com a mesma Idempotency-Key cria **um** alerta | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 7.3 | Reconectar → REST ressincroniza; realtime reconecta; estado correto                 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 7.4 | API reinicia com socket aberto → app reconecta sozinho                              | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |
| 7.5 | Access token expira (15 min) → refresh transparente; socket reconecta               | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED |

## 8. Sessões

| #   | Teste                                                                   | A            | iS           |
| --- | ----------------------------------------------------------------------- | ------------ | ------------ |
| 8.1 | Aparelho A revoga sessão de B → B perde API e socket → B volta ao login | NOT EXECUTED | NOT EXECUTED |
| 8.2 | Reuso de refresh (simulado) → sessão revogada; app pede login           | NOT EXECUTED | NOT EXECUTED |

## 9. Exclusão de conta

| #   | Teste                                                                              | A            | iS           |
| --- | ---------------------------------------------------------------------------------- | ------------ | ------------ |
| 9.1 | Fluxo completo: consequências → senha → confirmar → tela pública; login falha      | NOT EXECUTED | NOT EXECUTED |
| 9.2 | Bloqueio por propriedade → mensagem lista o grupo; transferir no grupo desbloqueia | NOT EXECUTED | NOT EXECUTED |
| 9.3 | Senha errada → volta à etapa da senha, sem sair                                    | NOT EXECUTED | NOT EXECUTED |
| 9.4 | SecureStore limpo: reabrir o app cai na tela pública, sem reconexão                | NOT EXECUTED | NOT EXECUTED |

## 10. Deep links

| #    | Teste                                                         | A            | iS           |
| ---- | ------------------------------------------------------------- | ------------ | ------------ |
| 10.1 | `safecircle://` para alerta/check-in/trajeto próprio → abre   | NOT EXECUTED | NOT EXECUTED |
| 10.2 | Id inválido → erro seguro, sem crash                          | NOT EXECUTED | NOT EXECUTED |
| 10.3 | Id de recurso de outro grupo → 404 na API → mensagem genérica | NOT EXECUTED | NOT EXECUTED |

## 11. Robustez

| #    | Teste                                                                                  | AF           | iF           |
| ---- | -------------------------------------------------------------------------------------- | ------------ | ------------ |
| 11.1 | 10+ ciclos foreground/background: um socket, um watcher, sem listeners duplicados      | NOT EXECUTED | NOT EXECUTED |
| 11.2 | Sessão prolongada (30 min) com localização ao vivo: sem crescimento anormal de memória | NOT EXECUTED | NOT EXECUTED |
| 11.3 | Bateria (qualitativo) durante 30 min de compartilhamento                               | NOT EXECUTED | NOT EXECUTED |
| 11.4 | Relógio do aparelho adiantado/atrasado 10 min: vencimento decidido pelo servidor       | NOT EXECUTED | NOT EXECUTED |
| 11.5 | Timezone diferente: horários exibidos no fuso local; `dueAt` correto                   | NOT EXECUTED | NOT EXECUTED |

## 12. Bundle e configuração

| #    | Teste                                                                                                                   | Resultado                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 12.1 | Inspecionar bundle (`npx expo export`): sem JWT secret, DATABASE_URL, METRICS_TOKEN, EXPO_ACCESS_TOKEN, chaves privadas | NOT EXECUTED (build EAS não gerada; a inspeção estática do código-fonte mostra que só `EXPO_PUBLIC_*` é lido no app) |
| 12.2 | Release build sem `console.log` sensível; ErrorBoundary sem stack                                                       | NOT EXECUTED                                                                                                         |
| 12.3 | Android: cleartext desabilitado; `allowBackup=false`; permissões mínimas                                                | verificado em `app.json` (config) — teste em aparelho NOT EXECUTED                                                   |
| 12.4 | iOS: usage descriptions presentes; sem background modes                                                                 | verificado em `app.json` (config) — teste em aparelho NOT EXECUTED                                                   |

## 13. Acessibilidade e localização de idioma

| #    | Teste                                                     | A            | iS           |
| ---- | --------------------------------------------------------- | ------------ | ------------ |
| 13.1 | Botões com rótulo de acessibilidade (SOS, ações críticas) | NOT EXECUTED | NOT EXECUTED |
| 13.2 | Estado não depende só de cor (texto acompanha)            | NOT EXECUTED | NOT EXECUTED |
| 13.3 | Font scaling grande: telas críticas continuam usáveis     | NOT EXECUTED | NOT EXECUTED |
| 13.4 | UI inteira em pt-BR                                       | NOT EXECUTED | NOT EXECUTED |

## Registro de execução

| Data | Aparelho / SO | Build (profile, versionCode) | Executor | Itens PASS | Itens FAIL | Observações |
| ---- | ------------- | ---------------------------- | -------- | ---------- | ---------- | ----------- |
|      |               |                              |          |            |            |             |
