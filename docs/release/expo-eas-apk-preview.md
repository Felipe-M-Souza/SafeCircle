# Expo/EAS — configuração e APK de preview

Como o SafeCircle está vinculado ao Expo Application Services (EAS) e como
gerar um APK Android de preview instalável. Sem publicação em loja, sem
`eas submit`, sem profile de produção. Nada aqui é segredo: `projectId`,
`owner` e slug são identificadores públicos.

## Conta e projeto

| Item          | Valor                                                                   |
| ------------- | ----------------------------------------------------------------------- |
| Conta Expo    | `felipe_melo_souza` (confirmada por `eas whoami`)                       |
| Projeto EAS   | `@felipe_melo_souza/safecircle` — criado em 2026-09-16, não existia     |
| Slug          | `safecircle`                                                            |
| `projectId`   | `d61985af-730f-4bb3-91ba-92c22abd57e4`                                  |
| Dashboard     | https://expo.dev/accounts/felipe_melo_souza/projects/safecircle         |
| Identidade    | `com.safecircle.app` (Android e iOS), scheme `safecircle`               |
| Expo SDK      | 57 (`expo ~57.0.23`, React Native 0.86)                                 |
| EAS CLI usado | `eas-cli/24.6.0`, via `pnpm dlx eas-cli@latest` (sem instalação global) |

O app Expo vive em `apps/mobile/`; todos os comandos EAS rodam a partir dele.
Os arquivos `app.json` e `eas.json` ficam nesse diretório.

## Autenticação

O EAS CLI guarda a sessão localmente. Verifique antes de qualquer comando:

```bash
cd apps/mobile
pnpm dlx eas-cli@latest whoami
```

Se não estiver autenticado, `pnpm dlx eas-cli@latest login` abre o login no
navegador. Nunca cole senha, token ou cookie em chat, script ou repositório.
Um `EXPO_TOKEN` só faz sentido em CI, como secret do provedor, e não é usado
neste fluxo.

## Profiles de build (`apps/mobile/eas.json`)

| Profile       | Distribuição | Android          | `EXPO_PUBLIC_APP_ENV` | `EXPO_PUBLIC_API_URL`                               |
| ------------- | ------------ | ---------------- | --------------------- | --------------------------------------------------- |
| `development` | internal     | APK (dev client) | development           | `http://10.0.2.2:3000` (emulador → host)            |
| `preview`     | internal     | APK              | preview               | `https://staging-api.example.invalid` (placeholder) |
| `preview-apk` | internal     | APK              | preview               | **variável de ambiente EAS** do ambiente `preview`  |
| `production`  | store        | AAB              | production            | `https://api.example.invalid` (placeholder)         |

`preview-apk` é o profile desta entrega. Ele não carrega URL de API no
repositório: lê `EXPO_PUBLIC_API_URL` das variáveis de ambiente EAS do ambiente
`preview` (`environment: "preview"`), para que um endpoint temporário de teste
não vire endpoint permanente commitado. `production` continua gerando AAB e não
foi usado.

## Ambiente da API usado pelo APK

`EXPO_PUBLIC_*` vai para o bundle e é público. O app lê `EXPO_PUBLIC_API_URL`
em `apps/mobile/src/config.ts` e, se a variável não existir, usa
`http://localhost:3000`.

Estado em 2026-09-16: **não há API de preview pública** e nenhuma variável
`EXPO_PUBLIC_API_URL` foi definida no ambiente `preview` do EAS. Portanto o APK
gerado aponta para `http://localhost:3000`, que num aparelho é o próprio
aparelho: **o binário instala e abre, mas não tem fluxo ponta a ponta
funcional** (login, grupos e alertas falham ao chamar a API). Isso é uma
limitação registrada, não um defeito escondido.

Para um APK funcional, defina a URL antes de buildar, sem commitar:

```bash
cd apps/mobile
pnpm dlx eas-cli@latest env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://SUA-API-DE-PREVIEW --visibility plaintext
```

- URL `https` pública (túnel ou staging): funciona com a configuração atual.
- URL `http` na rede local (ex.: `http://192.168.x.x:3000`): a build de release
  bloqueia cleartext (`expo-build-properties` → `usesCleartextTraffic: false`).
  Seria preciso permitir cleartext só nesse profile, o que exige decisão
  explícita; não foi feito.

Nunca colocar em `EXPO_PUBLIC_*`: `JWT_SECRET`, `DATABASE_URL`,
`METRICS_TOKEN`, `EXPO_ACCESS_TOKEN`, service accounts, chaves privadas ou
senhas.

## Validação executada

| Verificação                                                | Resultado                                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx expo-doctor`                                          | 21/21 após as correções abaixo                                                                                                                                                |
| `eas config --platform android --profile preview-apk`      | owner, projectId, package, versão 0.1.0, `buildType: apk`, `distribution: internal` corretos                                                                                  |
| Validação do repositório (`pnpm release:check --skip-e2e`) | lint, format, typecheck, build, audit, db:check, migrations, blockers PASS; suíte da API 39 arquivos/503 testes e mobile 35/195 verdes após corrigir o isolamento de um teste |

Correções feitas pelo Expo Doctor:

- `android.usesCleartextTraffic` não é um campo válido do `app.json` (não tinha
  efeito). A intenção passou para o plugin `expo-build-properties`
  (`android.usesCleartextTraffic: false`), que gera a configuração nativa.
- `expo`, `expo-location` e `expo-notifications` alinhados às versões patch do
  SDK 57 (`expo install --fix`). Sem upgrade de SDK.

## Credenciais Android

Primeira build Android do projeto: o EAS gera e guarda a keystore na conta
Expo. Ela não é exportada, não é versionada e nenhuma senha é registrada aqui.
`eas credentials` mostra o que existe; não use `--clear-credentials` sem
decisão explícita.

## Gerar o APK

```bash
cd apps/mobile
pnpm dlx eas-cli@latest build --platform android --profile preview-apk
```

Acompanhe até o status final (`FINISHED`, `FAILED` ou `CANCELED`); entrar na
fila (`QUEUED`) não é sucesso. As builds ficam em
https://expo.dev/accounts/felipe_melo_souza/projects/safecircle/builds.

## Build desta entrega

Status: **APK BUILT — DEVICE INSTALLATION PENDING**.

| Item                | Valor                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| EAS build ID        | `4fea644d-42d2-4b5c-98ca-45999dcbeb94`                                                                      |
| Status              | `FINISHED` (criada 2026-09-16 05:22 UTC, concluída 05:29 UTC)                                               |
| Página da build     | https://expo.dev/accounts/felipe_melo_souza/projects/safecircle/builds/4fea644d-42d2-4b5c-98ca-45999dcbeb94 |
| APK (download)      | https://expo.dev/artifacts/eas/6oIM6YFi7UZh91idE1eq3_jWAN1TIvRA95XQH1WY0zs.apk (link transitório do Expo)   |
| Profile             | `preview-apk` (internal, APK)                                                                               |
| Versão              | `0.1.0`, `versionCode` 1 (inicializado remotamente pelo EAS; `appVersionSource: remote`)                    |
| Git SHA             | `8846500ca8a33936b8dd28c7a587dd9d97c3771f` (branch `chore/expo-eas-apk-preview`)                            |
| Ambiente            | `EXPO_PUBLIC_APP_ENV=preview`; **sem `EXPO_PUBLIC_API_URL`** → fallback `http://localhost:3000`             |
| Credenciais Android | keystore gerada e gerenciada pelo EAS nesta build (primeira do projeto); nada exportado ou versionado       |

O link do artefato é fornecido pelo Expo e pode expirar; a página da build é a
referência estável. Como não havia API de preview, este APK instala e abre mas
não completa login nem fluxos que chamem a API (limitação descrita acima).

## Instalação manual no aparelho

1. Abra a página da build no Expo (link acima) no próprio aparelho Android ou
   escaneie o QR code da página.
2. Baixe o APK e permita a instalação de fontes desconhecidas quando o Android
   pedir (apenas para esta instalação).
3. Abra o SafeCircle. O rodapé da tela inicial mostra versão e ambiente
   (`preview`).

## Limitações e o que não foi feito

- Nenhuma validação em aparelho físico foi executada nesta tarefa:
  `NOT EXECUTED — requires physical Android device`.
- Sem API de preview: o APK não tem fluxo ponta a ponta funcional (ver acima).
- `EXPO_PUBLIC_GIT_SHA` não é injetado pelo EAS neste profile; o rodapé mostra
  o commit apenas quando a variável é definida na build.
- iOS não configurado (sem credenciais Apple); nenhuma build iOS.
- EAS Update não foi ativado (os profiles têm `channel`, mas o app não inclui
  `expo-updates`); EAS Hosting não configurado.
- Background location segue desligada: v1 é foreground-only (ADR 0013).
- Nenhum `eas submit`, nenhuma publicação em Google Play ou App Store.
