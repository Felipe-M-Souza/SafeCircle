# ADR 0015 — Localização com a tela bloqueada, por serviço em primeiro plano

Status: aceito — 2026-09-17
Substitui: ADR 0013 §5 (Opção B, foreground-only na v1)
Estende: ADR 0007 (localização ao vivo)

## Problema

Até aqui a posição só era atualizada com o app aberto na tela. Um trajeto
seguro é exatamente a situação em que a pessoa guarda o celular no bolso e
bloqueia a tela: o compartilhamento parava quando mais importava, e o grupo via
uma posição congelada sem saber que estava congelada.

A decisão original de ficar em primeiro plano (ADR 0013 §5) foi tomada por não
haver como validar em aparelho na Phase 12. Agora há aparelho e validação.

## Decisão

Trocar `watchPositionAsync` (preso ao primeiro plano) por
`startLocationUpdatesAsync` com **serviço em primeiro plano** no Android e
**atualizações em segundo plano** no iOS.

### Por que serviço em primeiro plano, e não background location

Existem dois caminhos no Android, e eles são diferentes:

|                                       | Serviço em primeiro plano (escolhido) | `ACCESS_BACKGROUND_LOCATION`                            |
| ------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Tela bloqueada e app em segundo plano | funciona                              | funciona                                                |
| Iniciar sem o app ter sido aberto     | não                                   | sim                                                     |
| Notificação fixa enquanto compartilha | sim, obrigatória                      | não                                                     |
| Permissão de background               | **não precisa**                       | precisa                                                 |
| Google Play                           | sem exigência extra                   | formulário, vídeo de demonstração e revisão mais rígida |

O produto só inicia compartilhamento com a pessoa tocando em um botão com o app
aberto. Nenhum caso de uso precisa começar sozinho. Então a permissão de
background seria custo puro: mais revisão, mais risco de rejeição e uma
permissão assustadora no diálogo do sistema, em troca de nada.

A notificação fixa não é efeito colateral tolerado, é **parte do produto**: a
pessoa vê o tempo todo que está compartilhando. Um app de segurança pessoal que
rastreia sem sinal visível seria exatamente o que a regra 4.5 do README proíbe.

`ACCESS_BACKGROUND_LOCATION` continua em `blockedPermissions` no `app.json`: a
build não pode adquiri-la por engano, nem por dependência transitiva.

### Um stream para todos os compartilhamentos

Antes cada recurso (alerta, trajeto) abria seu próprio watcher. O sistema
operacional tem **um** stream de localização, então `background-location.ts`
centraliza: liga no primeiro assinante, desliga no último, entrega a mesma
amostra a todos. O `LiveLocationController` não mudou — `watchLiveLocation`
passou a delegar ao stream compartilhado.

### `killServiceOnDestroy: true`

Fechar o app encerra o compartilhamento. A alternativa (serviço sobrevivendo ao
app) criaria um rastreamento que a pessoa não consegue ver nem parar pelo
caminho óbvio. Preferimos parar de compartilhar a manter algo fora do controle
dela.

### Processo reativado sem compartilhamento ativo

O sistema pode reiniciar o processo e disparar a task quando não há
compartilhamento nenhum em memória. Nesse caso a task **desliga as atualizações**
em vez de ignorar: evita um serviço em primeiro plano órfão consumindo bateria
e mostrando notificação sem motivo.

### iOS

`isIosBackgroundLocationEnabled: true` adiciona o background mode de localização.
`showsBackgroundLocationIndicator: true` mantém o indicador azul visível e
`pausesUpdatesAutomatically: false` impede o sistema de pausar por conta própria.
A permissão pedida continua sendo apenas "Ao usar o app" — atualizações em
segundo plano iniciadas em primeiro plano funcionam com ela.

## Consequências

- Permissões Android novas: `FOREGROUND_SERVICE` e `FOREGROUND_SERVICE_LOCATION`,
  adicionadas pelo plugin. Nenhuma delas pede diálogo ao usuário.
- Consumo de bateria maior enquanto o compartilhamento está ligado. É limitado
  pelo mesmo throttling de antes: no máximo uma amostra a cada 5 s ou 10 m.
- Textos do app, política de privacidade e disclosure de loja mudam: deixam de
  dizer "só em primeiro plano" e passam a descrever a notificação fixa.
- Retenção, minimização e o resto do modelo de privacidade não mudam: mesma
  quantidade de dados, mesmos prazos, mesmo escopo de quem vê.

## Limites conhecidos

- Se o sistema matar o processo por pressão de memória, o compartilhamento para.
  Recuperar exigiria upload a partir de um contexto headless, com token lido do
  armazenamento seguro — complexidade que só se justifica com evidência de que
  acontece na prática.
- Não validado em aparelho no momento desta decisão: o plano manual
  (`docs/release/manual-device-test-plan.md`) tem os casos, marcados como
  pendentes até alguém executá-los.
- Android 14+ pode restringir serviços em primeiro plano iniciados de estados
  específicos; aqui ele sempre parte de uma ação da pessoa com o app aberto, que
  é o caso permitido.
