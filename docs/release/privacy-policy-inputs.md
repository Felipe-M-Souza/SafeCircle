# Insumos técnicos para a política de privacidade

Fatos **verificáveis no código** desta versão (0.1.0-rc.1) para quem vai
redigir a política de privacidade na Phase 13. Nada aqui é texto jurídico nem
afirmação de conformidade; é o que o sistema faz. Fonte primária:
`docs/privacy/data-inventory.md` e `docs/privacy/retention-policy.md`.

## 1. Quem somos no sistema

O SafeCircle é um app de segurança pessoal para grupos de confiança. O backend
(API) é a autoridade sobre dados e autorização; o app só apresenta e coleta.

## 2. Dados coletados e finalidade

| Dado                                               | Quando é coletado                            | Finalidade                                                          |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Nome                                               | Cadastro                                     | Identificar a pessoa para os membros dos grupos dela                |
| E-mail                                             | Cadastro                                     | Login; destino de convites de grupo                                 |
| Senha                                              | Cadastro/login                               | Autenticar. Armazenada só como hash Argon2id; nunca em claro        |
| Grupos e papéis (OWNER/ADMIN/MEMBER)               | Ao criar/entrar em um grupo                  | Definir quem pode ver o quê                                         |
| Alerta de emergência (SOS)                         | Ao acionar                                   | Avisar o grupo; registrar quando foi aberto e encerrado             |
| Localização no acionamento do SOS                  | Ao acionar, se a pessoa permitiu localização | Mostrar ao grupo onde o pedido de ajuda foi feito                   |
| Localização ao vivo (alerta ou trajeto)            | Só quando a pessoa ativa explicitamente      | Acompanhamento pelo grupo durante a emergência/trajeto              |
| Check-ins (prazo e status)                         | Ao criar                                     | Rotina de segurança combinada com o grupo                           |
| Trajetos (previsão, destino textual)               | Ao criar                                     | Deslocamento monitorado; destino é texto livre digitado pela pessoa |
| Confirmações ("vi", "estou indo")                  | Ao tocar                                     | Coordenação do grupo durante um alerta                              |
| Token de notificação push do aparelho              | Ao permitir notificações                     | Entregar notificações de emergência ao aparelho                     |
| Identificador de instalação (UUID gerado pelo app) | Primeira execução                            | Reconhecer a instalação para gerenciar o token de push              |
| Sessões (datas de criação/último uso/expiração)    | Login                                        | Manter a pessoa logada; permitir "sair dos outros aparelhos"        |
| Registros de auditoria (evento, ids, resultado)    | Em ações críticas                            | Segurança, investigação de incidentes e suporte                     |

**Não coletamos:** contatos, fotos, câmera, microfone, Bluetooth, endereço
IP persistido, User-Agent persistido, identificadores de publicidade ou de
hardware (IMEI, MAC, Android ID), analytics de uso, localização em segundo
plano.

## 3. Localização — detalhes que a política deve refletir

- Só é coletada em dois contextos explícitos: ao acionar um SOS (uma posição)
  e quando a pessoa **ativa** o compartilhamento ao vivo durante um alerta ou
  trajeto.
- **Só em primeiro plano**: com o app fechado ou em segundo plano a
  localização não é coletada nem enviada. A UI informa isso.
- É visível apenas aos membros do grupo daquele alerta/trajeto, enquanto durar
  e por até 30 dias depois. Nunca aparece em notificações push nem em logs.
- A pessoa pode parar o compartilhamento a qualquer momento; ele também para
  quando o alerta/trajeto encerra.
- Coordenadas vêm do GPS do aparelho e não são verificadas pelo servidor.

## 4. Compartilhamento com terceiros

| Terceiro                        | O que recebe                                                                                                                                                            | Por quê                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Expo Push Service (Expo)        | Token de push do aparelho e o conteúdo da notificação: texto fixo, tipo do evento e ids internos (alerta/grupo/check-in/trajeto). **Nunca** nome, localização ou e-mail | Entregar notificações via APNs/FCM   |
| Apple (APNs) / Google (FCM)     | Via Expo, o mesmo conteúdo acima                                                                                                                                        | Entrega da notificação               |
| Google Maps (Android, opcional) | Requisições de mapa do aparelho para renderizar o mapa (SDK do Google Maps)                                                                                             | Exibir o mapa de localização ao vivo |
| Apple Maps (iOS)                | Idem, via MapKit                                                                                                                                                        | Idem                                 |

Nenhum outro terceiro. Não há analytics, anúncios, SDKs de atribuição ou
crash reporting nesta versão.

## 5. Retenção (resumo; prazos exatos em `retention-policy.md`)

| Dado                                        | Prazo                                           |
| ------------------------------------------- | ----------------------------------------------- |
| Localização (SOS e ao vivo)                 | 30 dias após o encerramento                     |
| Check-ins e trajetos finalizados            | 90 dias                                         |
| Registros de auditoria                      | 180 dias, anonimizados quando a conta é apagada |
| Sessões encerradas / histórico de renovação | 30 dias                                         |
| Eventos internos de entrega (outbox)        | 30 dias (processados) / 90 dias (falhos)        |
| Perfil, grupos, alertas (sem localização)   | Enquanto a conta existir                        |

Limpeza automática diária (`pnpm privacy:cleanup`).

## 6. Direitos que o sistema já atende tecnicamente

| Direito                     | Como                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acesso/portabilidade        | `GET /me/privacy/export`: JSON com os dados da própria pessoa (perfil, grupos, convites, alertas próprios com localização inicial, check-ins, trajetos, sessões, aparelhos). Sem segredos, sem dados de terceiros                                                                     |
| Exclusão                    | Exclusão de conta no app ("Excluir minha conta"), com reautenticação por senha. Remove perfil, sessões, aparelhos, alertas/check-ins/trajetos próprios com localização, participações em grupos e grupos em que era a única pessoa. Auditoria fica anonimizada pelo prazo de retenção |
| Correção                    | **Não existe** edição de nome/e-mail nesta versão — registrar como limitação                                                                                                                                                                                                          |
| Revogar acesso de aparelhos | "Sair dos outros aparelhos" e revogação de sessão individual                                                                                                                                                                                                                          |

Condições da exclusão que a política deve mencionar: a pessoa precisa antes
transferir a propriedade de grupos que tenham outros membros (ou removê-los) e
encerrar alertas, check-ins e trajetos em andamento. Alertas ativos nunca são
cancelados automaticamente pela exclusão.

## 7. Segurança (fatos)

- Senhas com Argon2id; tokens de acesso curtos (15 min); refresh tokens
  rotacionados com detecção de reuso; sessões revogáveis.
- Transporte HTTPS (responsabilidade do ambiente de produção).
- Dados em repouso: criptografia é requisito da infraestrutura de produção
  (não do app) — ver checklist de release.
- Logs não contêm senha, tokens, coordenadas nem corpo de requisições sensíveis.

## 8. Menores de idade, base legal, DPO, jurisdição

Não determinados pelo código. Decisão da organização na Phase 13.
