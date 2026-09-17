# Site do SafeCircle

Site institucional e páginas legais, em `safecircle.softechconsulting.com.br`.

Existe por dois motivos, nessa ordem de urgência:

1. **Google Play e App Store exigem uma URL pública de política de privacidade**
   para aceitar o aplicativo. Sem isso não há publicação.
2. Explicar o produto a quem chega por um convite ou por um link.

## Como é feito

HTML e CSS escritos à mão. Sem framework, sem etapa de build, sem dependência.

Isso não é preguiça, é coerência: o site de um aplicativo que promete não
rastrear ninguém não deveria carregar fonte do Google, CDN ou analytics. Não há
**nenhum** JavaScript e **nenhuma** requisição para fora do domínio, o que
permite a política de segurança mais restritiva possível em `_headers`:

```
default-src 'none'; img-src 'self'; style-src 'self'
```

Se algum dia entrar um script, essa linha precisa mudar. É bom que precise.

| Arquivo             | O que é                                                       |
| ------------------- | ------------------------------------------------------------- |
| `index.html`        | Página inicial: o que o app faz e os compromissos de privacidade |
| `privacidade.html`  | Política de privacidade                                       |
| `termos.html`       | Termos de uso                                                 |
| `suporte.html`      | Contato, como relatar problema, como entrar nos testes        |
| `404.html`          | Página de erro                                                |
| `styles.css`        | Estilos, com tema claro e escuro conforme o sistema           |
| `_headers`          | Cabeçalhos de segurança aplicados pela Cloudflare            |
| `assets/`           | Gerados por `pnpm brand:assets`; não edite à mão              |

## Rodar localmente

```bash
pnpm site:dev
```

Abre em http://localhost:4321. O servidor (`scripts/serve-web.mjs`) serve os
arquivos estáticos e existe só para revisão; em produção quem serve é o
Cloudflare.

## Conteúdo pendente antes de publicar

As páginas legais descrevem com exatidão **o que o sistema faz**, extraído de
`docs/release/privacy-policy-inputs.md`, que por sua vez veio do código. Mas há
trechos marcados com `[preencher]` que o código não determina e que dependem de
decisão do proprietário:

- Razão social, CNPJ e endereço do responsável pelo tratamento.
- E-mails de contato: privacidade, suporte e segurança.
- Idade mínima e regra para menores de idade.
- Base legal do tratamento na LGPD, encarregado de dados e foro.
- Limitação de responsabilidade, conforme orientação jurídica.

Cada página com pendência mostra um aviso visível de rascunho no topo. **Remova
o aviso só depois de preencher tudo** — publicar com os marcadores é pior do que
não publicar.

## De onde vem o conteúdo

Nada foi inventado. A política reflete o comportamento verificável do código:

| Seção da política         | Origem                                               |
| ------------------------- | ---------------------------------------------------- |
| Dados coletados, retenção | `docs/privacy/data-inventory.md`, `retention-policy.md` |
| Localização               | ADR 0007 e ADR 0015                                  |
| Terceiros                 | `docs/release/store-disclosure-inputs.md`            |
| Direitos e exclusão       | ADR 0012 §21 e `modules/account/`                    |

Quando o comportamento do app mudar, a política muda junto. Foi o que aconteceu
com a localização em segundo plano: o ADR 0015 alterou o produto e o texto
deixou de dizer "só em primeiro plano".

## Publicação

Cloudflare, conectado ao repositório, por um Worker só de assets declarado em
`wrangler.jsonc` na raiz — contas novas não oferecem mais o fluxo clássico do
Pages. Passo a passo em `docs/release/site-institucional.md`.
