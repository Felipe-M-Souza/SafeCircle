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

## Definições jurídicas

As páginas legais descrevem com exatidão **o que o sistema faz**, extraído de
`docs/release/privacy-policy-inputs.md`, que por sua vez veio do código. O que o
código não determina foi preenchido e os avisos de rascunho saíram:

| Definição | Valor | Origem |
| --------- | ----- | ------ |
| Controlador | FELIPE DE MELO SOUZA TECNOLOGIA DA INFORMACAO LTDA, CNPJ 61.927.710/0001-56, São Paulo/SP | whois de `softechconsulting.com.br` e cadastro público da Receita Federal |
| Encarregado (LGPD art. 41) | Felipe de Melo Souza, `privacidade@softechconsulting.com.br` | definido pelo proprietário |
| Contatos | `suporte@`, `privacidade@`, `seguranca@` em `softechconsulting.com.br` | definido pelo proprietário |
| Idade mínima | não há; conta de criança até 12 anos exige consentimento de quem responde por ela (LGPD art. 14) | definido pelo proprietário |
| Foro | Comarca de São Paulo/SP, ressalvado o domicílio do consumidor (CDC art. 101) | redigido aqui |

### Duas coisas que merecem revisão de advogado

O texto abaixo foi redigido a partir do que o código faz, não por um
profissional habilitado. Funciona como ponto de partida e não como parecer:

1. **A limitação de responsabilidade** no item 7 dos termos. O valor pago limita
   a indenização, mas o aplicativo trata de segurança pessoal e o Código de
   Defesa do Consumidor restringe esse tipo de cláusula.
2. **A designação do encarregado.** A Resolução CD/ANPD nº 2/2022 dispensa
   agentes de pequeno porte de indicar um encarregado, desde que mantenham um
   canal de comunicação. Indicar uma pessoa é mais transparente, mas é uma
   escolha, não uma obrigação.

### As três caixas precisam existir

Publicar os endereços não os cria. A Google verifica o endereço de suporte
antes de aprovar o aplicativo, e um canal de privacidade que ninguém atende é
descumprimento da LGPD, não um detalhe de forma.

O e-mail do domínio é servido pelo Titan, contratado junto com a hospedagem.
**O painel do Titan não funciona em celular** — ele mostra "Titan Control Panel
experience is not currently optimized for mobile" e não deixa passar, mesmo com
"site para computador" marcado. É preciso um computador.

No painel da HostGator, em E-mails, abra o gerenciamento do plano de
`softechconsulting.com.br`, o que leva ao painel do Titan. Lá:

1. Crie `suporte@softechconsulting.com.br` como caixa real.
2. Adicione `privacidade@` e `seguranca@` como **apelidos** dessa caixa.
   Apelido não consome licença; caixa extra costuma ser cobrada.
3. Ative o **encaminhamento** da caixa para o endereço que você lê todo dia.

Encaminhar não basta. Sem configurar "Enviar e-mail como" no destino, a
resposta sai do endereço pessoal, e quem escreveu para `privacidade@` recebe
resposta de outro lugar. No Gmail isso fica em Configurações, Contas e
importação, usando o SMTP `smtp.titan.email` na porta 465 com SSL.

Detalhe que já foi decidido: `seguranca@` vai **sem cedilha**. Endereço com
acento existe na especificação e quebra na prática, e este é um canal que a
Google vai verificar.

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
