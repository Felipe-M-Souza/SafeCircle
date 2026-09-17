# Marca do SafeCircle — fontes e recursos gerados

Fontes entregues pelo proprietário em 2026-09-16:

| Arquivo           | Conteúdo                                               | Dimensões  |
| ----------------- | ------------------------------------------------------ | ---------- |
| `icon-source.png` | Ícone: pino azul com o grupo e o sino de alerta        | 1254×1254  |
| `logo-source.png` | Logo horizontal "SafeCircle" com o pino, fundo transparente | 1672×941 |

Os arquivos em `apps/mobile/assets/` são **gerados** por
`pnpm brand:assets` (`scripts/brand-assets.mjs`, usa `sharp`) e commitados,
para que a build não dependa do script. Não edite os gerados à mão; altere a
fonte e rode o script de novo. `generated.json` registra as medidas e cores
amostradas na última geração.

| Gerado              | Uso                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| `icon.png`          | `expo.icon` (iOS e fallback). A fonte tem cantos arredondados brancos; o script recorta a margem e preenche os cantos com o azul da borda, porque iOS e launchers aplicam a própria máscara |
| `adaptive-icon.png` | `android.adaptiveIcon.foregroundImage`: arte a 72% do canvas, centrada, sobre transparente (zona segura do Android é 66%); fundo `#014D91`, amostrado da fonte |
| `splash-icon.png`   | `expo-splash-screen` (`imageWidth: 240`, fundo branco)                              |
| `logo.png`          | Componente `BrandLogo` nas telas de login, cadastro, home e abertura               |
| `favicon.png`       | `web.favicon`                                                                       |

Tudo aqui é público. Ícone, splash e logo só entram no app em uma nova build
EAS (não há EAS Update).
