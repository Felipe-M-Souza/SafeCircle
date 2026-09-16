# Achados em aparelho — 2026-09-16, rodada 2 (APK 4d1e4197)

Segunda rodada do proprietário num Android físico, já com as correções da
rodada 1 (PR #23). Dois relatos; ambos reproduzidos por evidência e corrigidos
com testes que falham sem a correção.

| #   | Relato                                                                                                  | Evidência                                                                                                                                                         | Causa raiz                                                                                                                                                                                                                              | Correção                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A barra de navegação do sistema (inferior) cobre o conteúdo, por exemplo o botão "CHEGUEI EM SEGURANÇA" | Captura de tela da home                                                                                                                                           | Android edge-to-edge (RN 0.86 / SDK 57): o conteúdo desenha atrás das barras do sistema e o app não aplicava insets de área segura em nenhuma tela                                                                                      | `SafeAreaProvider` + `SafeAreaView` (`react-native-safe-area-context`) na raiz do app, com fundo da marca; o header de `Screen` deixa de reservar 56 px fixos para a status bar                                                         |
| 2   | "Quando ativo a localização, o app está bugando e fechando"                                             | Logs da API: `POST .../live-location/start` → 201 às 19:23:02 e 19:23:47, `history` → 200, e **nenhum** ponto enviado depois: o processo morreu logo após iniciar | `react-native-maps` no Android exige chave do Google Maps (`android.config.googleMaps.apiKey`); sem ela o Maps SDK lança `RuntimeException: API key not found` ao inflar o `MapView`, que é montado assim que existe a primeira posição | `isNativeMapAvailable()` decide antes de montar: no Android sem chave, o mapa dá lugar a um cartão que informa a limitação e abre a posição no app de mapas do sistema (`geo:`); a localização continua sendo compartilhada normalmente |

## Sobre o mapa

A chave do Maps SDK for Android é pública por natureza (vai dentro do APK) e
deve ser restringida ao pacote `com.safecircle.app` e à assinatura SHA-1 da
keystore gerenciada pelo EAS. Quando o proprietário criar a chave no Google
Cloud, basta adicionar em `apps/mobile/app.json`:

```json
{
  "expo": {
    "android": { "config": { "googleMaps": { "apiKey": "<chave restrita>" } } }
  }
}
```

e gerar nova build. Sem a chave o app funciona sem mapa embutido, em vez de
fechar. No iOS o MapKit não exige chave.

## Testes adicionados

| Teste                                                                      | O que prova                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/src/lib/__tests__/maps.test.ts` (4)                           | Android sem chave (ausente, vazia, config nula) → indisponível; com chave → disponível; iOS sempre; web nunca; URL `geo:`/`maps:` com 6 casas                              |
| `apps/mobile/src/components/__tests__/LiveLocationMap.native.test.tsx` (3) | sem mapa: cartão de fallback, nenhum componente do `react-native-maps` montado, botão abre o app de mapas; com mapa: `MapView` e marcador; sem primeiro ponto: placeholder |

Rolagem/insets: o mock de `react-native-safe-area-context` no Jest devolve
insets zero; a prova real é em aparelho (o corte era visual). A alteração é
estrutural e única (raiz do app), não por tela.

## Não reproduzido nesta rodada

Nada mais foi relatado. Ícone, splash e logo (PR #24) entram na próxima build.
