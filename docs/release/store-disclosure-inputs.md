# Insumos para declarações nas lojas

Respostas técnicas, verificáveis no código da versão 0.1.0-rc.1, para preencher
o **Google Play Data Safety** e o **Apple App Privacy** na Phase 13. Quem
preenche os formulários decide a categoria oficial; aqui está o que o app
realmente faz.

## Google Play — Data Safety

| Pergunta                                               | Resposta                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O app coleta ou compartilha dados do usuário?          | Sim, coleta. Compartilha apenas o token de push e o conteúdo mínimo da notificação com a Expo (e via ela, com FCM)                                                                                                                    |
| Os dados são criptografados em trânsito?               | Sim (HTTPS/WSS; exigido pela configuração de produção)                                                                                                                                                                                |
| Há forma de solicitar exclusão dos dados?              | Sim, dentro do app: "Excluir minha conta" (reautenticação por senha), e o dado é removido conforme `retention-policy.md`                                                                                                              |
| **Localização** — aproximada/precisa                   | **Precisa**, coletada; compartilhada apenas com membros do grupo dentro do app (não com terceiros). Finalidade: funcionalidade do app (emergência). Opcional: a pessoa escolhe quando compartilhar. **Não coletada em segundo plano** |
| **Informações pessoais** — nome, e-mail                | Coletados; finalidade: funcionalidade (conta, convites). Obrigatórios para usar o app                                                                                                                                                 |
| **Informações pessoais** — outros                      | Destino textual do trajeto (texto livre); finalidade: funcionalidade; opcional                                                                                                                                                        |
| **Credenciais**                                        | Senha coletada (armazenada como hash). Finalidade: autenticação                                                                                                                                                                       |
| **Mensagens**                                          | Não                                                                                                                                                                                                                                   |
| **Fotos/vídeo/áudio/arquivos**                         | Não                                                                                                                                                                                                                                   |
| **Contatos**                                           | Não                                                                                                                                                                                                                                   |
| **Identificadores do dispositivo**                     | UUID **gerado pelo app** para a instalação (não é ID de hardware nem de publicidade); token de push. Finalidade: notificações                                                                                                         |
| **Atividade no app**                                   | Registros de ações (alertas, check-ins, trajetos) que a própria pessoa cria; auditoria interna com ids. Finalidade: funcionalidade e segurança                                                                                        |
| **Informações de saúde/financeiras**                   | Não                                                                                                                                                                                                                                   |
| **Diagnóstico / desempenho**                           | Nenhum SDK de crash/analytics. Métricas operacionais do servidor sem dados pessoais                                                                                                                                                   |
| Dados coletados pelo Play são usados para publicidade? | Não                                                                                                                                                                                                                                   |
| Compartilhamento com terceiros                         | Expo Push (token + conteúdo fixo + ids). Google Maps SDK (requisições de mapa do aparelho)                                                                                                                                            |

Permissões Android declaradas (ver `app.json`): `ACCESS_FINE_LOCATION`,
`ACCESS_COARSE_LOCATION`, `POST_NOTIFICATIONS`. Bloqueadas explicitamente:
`ACCESS_BACKGROUND_LOCATION`, câmera, microfone, contatos, armazenamento,
Bluetooth. `usesCleartextTraffic=false`; `allowBackup=false`.

## Apple — App Privacy (nutrition label)

| Categoria                           | Coletado?                                                                                                    | Vinculado à identidade? | Rastreamento? | Finalidade        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------- | ----------------- |
| Location — Precise Location         | Sim                                                                                                          | Sim (é da conta)        | Não           | App Functionality |
| Contact Info — Name                 | Sim                                                                                                          | Sim                     | Não           | App Functionality |
| Contact Info — Email Address        | Sim                                                                                                          | Sim                     | Não           | App Functionality |
| Identifiers — User ID               | Sim (id interno da conta)                                                                                    | Sim                     | Não           | App Functionality |
| Identifiers — Device ID             | Não (UUID de instalação gerado pelo app; não é IDFA/IDFV) — avaliar se a Apple exige declarar como Device ID | —                       | Não           | Notificações      |
| User Content — Other                | Sim (destino textual do trajeto)                                                                             | Sim                     | Não           | App Functionality |
| Usage Data                          | Não                                                                                                          | —                       | Não           | —                 |
| Diagnostics                         | Não                                                                                                          | —                       | Não           | —                 |
| Sensitive Info / Health / Financial | Não                                                                                                          | —                       | —             | —                 |
| Contacts / Photos / Audio           | Não                                                                                                          | —                       | —             | —                 |

`NSLocationWhenInUseUsageDescription` declarada (texto em pt-BR no `app.json`).
**Sem** `NSLocationAlwaysAndWhenInUseUsageDescription`, sem background modes,
`ITSAppUsesNonExemptEncryption=false` (só HTTPS padrão).

## Localização em segundo plano — declaração

**Não usa `ACCESS_BACKGROUND_LOCATION`** — a permissão continua em
`blockedPermissions`, então **não** é preciso preencher o formulário de
background location do Google Play nem gravar vídeo de demonstração.

O compartilhamento continua com a tela bloqueada por meio de um **serviço em
primeiro plano** (`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION`,
tipo `location`), sempre iniciado por uma ação da pessoa com o app aberto e
sempre acompanhado de notificação fixa. No iOS são background updates com o
indicador azul visível, sob a permissão "Ao usar o app" (ADR 0015).

Para o formulário de tipo de serviço em primeiro plano do Google Play: uso é
"localização", justificativa é compartilhar a posição com um grupo de confiança
escolhido pela pessoa durante um alerta de emergência ou trajeto seguro,
enquanto ela mantiver o recurso ligado.

## Notificações push

- Só após permissão do sistema; a pessoa pode desativar nas configurações.
- Conteúdo: texto fixo por tipo ("Alerta de emergência", "Check-in não
  confirmado", "Trajeto não confirmado") e ids. **Nunca** nome, localização,
  destino ou e-mail — a notificação pode aparecer na tela bloqueada.
- Entrega at-least-once: pode, raramente, chegar duplicada.

## Conta e exclusão

- Criação de conta com nome, e-mail e senha.
- Exclusão dentro do app, com senha. Pré-condições: transferir/resolver
  propriedade de grupos com outros membros e encerrar alertas/check-ins/
  trajetos em andamento. Depois: perfil, sessões, aparelhos, alertas próprios
  (com localização), check-ins, trajetos e participações removidos; auditoria
  anonimizada por até 180 dias.
- Exportação dos próprios dados disponível pela API (`GET /me/privacy/export`).
  A tela no app para isso é pendência da Phase 13.

## Diagnóstico

Nenhum vendor de crash reporting ou analytics nesta versão (recomendação para
a Phase 13 avaliar). Métricas Prometheus são do servidor, sem dado pessoal,
protegidas por token.

## Identidade do app

- Nome: SafeCircle · slug: `safecircle` · scheme: `safecircle://`
- iOS `bundleIdentifier`: `com.safecircle.app` · Android `package`: `com.safecircle.app`
- Versão: `0.1.0` (`app.json`) · pacotes: `0.1.0-rc.1`
