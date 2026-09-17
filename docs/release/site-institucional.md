# Site institucional — publicação na Cloudflare

Como publicar `apps/web` em `safecircle.softechconsulting.com.br`. Nada aqui é
segredo.

## Por que o site é um bloqueador de release

Google Play e App Store **exigem** uma URL pública de política de privacidade
no cadastro do aplicativo. Sem o site no ar, o app não é publicado. Por isso o
site entra antes da publicação, não depois.

## Por que a Cloudflare

|                         | Cloudflare                        | HostGator (já contratado)        |
| ----------------------- | --------------------------------- | -------------------------------- |
| Custo                   | gratuito                          | já pago                          |
| Publicação              | automática a cada push no GitHub  | manual, por FTP ou cPanel        |
| Conteúdo versionado     | sim, é o próprio repositório      | só se alguém lembrar de reenviar |
| HTTPS                   | automático                        | disponível                       |
| Cabeçalhos de segurança | arquivo `_headers` no repositório | configuração no servidor         |

O que decidiu foi a publicação automática: a política de privacidade precisa
acompanhar mudanças de comportamento do app, e um processo manual acaba
esquecido. Na Cloudflare, atualizar o texto é abrir um pull request.

## Passo a passo

### 1. Criar o projeto no Cloudflare

Contas criadas a partir de 2026 **não oferecem mais o fluxo clássico do Pages**:
o painel unificou tudo em Workers. Por isso o repositório tem `wrangler.jsonc`
na raiz, declarando `apps/web` como diretório de arquivos estáticos. É um
Worker "só de assets": nenhum código roda por requisição, a Cloudflare apenas
serve os arquivos a partir da borda.

1. No painel, vá em **Workers & Pages**, botão **Create application**, e escolha
   importar de um repositório Git.
2. Autorize o acesso a `Felipe-M-Souza/SafeCircle`.
3. Preencha assim:

| Campo                 | Valor                 |
| --------------------- | --------------------- |
| Project name          | `safecircle-site`     |
| Build command         | deixe **vazio**       |
| Deploy command        | `npx wrangler deploy` |
| Path                  | `/`                   |
| Variáveis de ambiente | **nenhuma**           |

O nome do projeto precisa bater com o `name` do `wrangler.jsonc`. O token de
API é criado pela própria Cloudflare no assistente; não é preciso gerar nada à
mão, e ele não vai para o repositório.

Não há etapa de build: o site é estático e é publicado como está.

### 2. Migrar o DNS para a Cloudflare

Ligar o subdomínio ao Worker exige que a zona `softechconsulting.com.br`
esteja na Cloudflare. Um domínio hospedado em outro provedor não aceita o
"Connect domain" do Worker.

A migração é uma cópia da zona, não uma transferência de registro: o domínio
continua registrado onde está, muda apenas quem responde pelas consultas de DNS.

**O escaneamento automático da Cloudflare não traz tudo.** Na zona real ele
encontrou 16 dos 28 registros. Ficaram de fora os dois `MX`, o `SPF`, o
`DMARC`, o `DKIM` do Resend, os dois `CNAME` de envio, o `DKIM` do cPanel e
quatro nomes de serviço (`mail`, `cpanel`, `webdisk`, `autoconfig`). Publicar
assim derrubaria o e-mail do domínio.

Antes de trocar os nameservers, tire um retrato da zona antiga consultando os
servidores autoritativos do provedor atual e compare com o que a Cloudflare
importou. Os nomes ausentes se descobrem por varredura: os padrões do cPanel
(`mail`, `cpanel`, `webmail`, `webdisk`, `autoconfig`, `autodiscover`, `whm`,
`ftp`, `cpcalendars`, `cpcontacts`) e os seletores de DKIM em uso.

O que faltar entra por **DNS > Records > Import**, com um arquivo de zona BIND
e a caixa **Proxy imported DNS records** desmarcada. Valor de `TXT` acima de
255 caracteres precisa ser quebrado em vários trechos entre aspas, na mesma
linha.

#### Proxy desligado em tudo

Todos os 28 registros ficam em **DNS only** (nuvem cinza). Não é provisório
por preguiça, é necessário:

| Registro                                                                                                | Por que não pode ser proxiado                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `webmail`, `cpanel`, `whm`, `ftp`, `webdisk`, `cpcalendars`, `cpcontacts`, `autoconfig`, `autodiscover` | rodam em portas que o proxy HTTP da Cloudflare não repassa                                                              |
| `send.safecircle`, `rsend.safecircle`                                                                   | são do Resend; proxiar quebra a autenticação de envio                                                                   |
| raiz e `www`                                                                                            | o site atual é servido pelo HostGator; ligar o proxy muda o comportamento de TLS e pode causar laço de redirecionamento |

Ligar o proxy na raiz e no `www` é uma decisão separada, para depois que a
migração estiver estável.

#### Conferir antes de trocar

Dá para validar a zona nova **antes** de mexer no registrador, perguntando
direto aos nameservers que a Cloudflare atribuiu:

```bash
pnpm dns:check 108.162.192.85
```

Enquanto os nameservers não mudam, esse endereço responde pela zona da
Cloudflare e o resolvedor público ainda responde pela antiga. Rodar contra os
dois e obter o mesmo resultado é a prova de que a troca não vai derrubar nada.

Na migração real os 28 registros conferiram nos dois lados antes da troca.

#### Trocar os nameservers

Último passo, feito no registrador (Registro.br para `.com.br`):

| Substituir                | Por                        |
| ------------------------- | -------------------------- |
| `ns1132.hostgator.com.br` | `chloe.ns.cloudflare.com`  |
| `ns1133.hostgator.com.br` | `edward.ns.cloudflare.com` |

A Cloudflare verifica sozinha, normalmente em 1 a 2 horas.

#### Ligar o subdomínio ao Worker

Só depois da zona ativa: no Worker `safecircle-site`, **Settings > Domains &
Routes > Add > Custom domain**, e informe
`safecircle.softechconsulting.com.br`. A Cloudflare cria o registro e emite o
certificado sozinha.

### 3. Verificar que o e-mail não quebrou

Esta é a verificação que importa. O domínio recebe e envia e-mail por dois
caminhos independentes: as caixas `@softechconsulting.com.br` no Titan, e os
convites do SafeCircle pelo Resend. Os dois passam a depender da zona nova.

Depois que os nameservers propagarem, compare a resposta da Cloudflare com o
retrato da zona antiga:

```bash
pnpm dns:check
```

O script consulta um resolvedor público e confere nome por nome. Nenhum
registro pode estar ausente nem com valor diferente. Um `DKIM` que perdeu um
caractere não dá erro: os e-mails apenas passam a cair em spam, sem aviso.

### 4. Confirmar os cabeçalhos de segurança

O `apps/web/_headers` é lido pela mesma infraestrutura de assets do Workers,
então a CSP e os demais cabeçalhos continuam valendo. Depois do deploy:

```bash
curl -sI https://safecircle.softechconsulting.com.br | grep -i "content-security-policy\|x-frame-options\|strict-transport"
```

## Depois de publicar

1. Preencha os trechos `[preencher]` das páginas legais e remova os avisos de
   rascunho. A lista está em `apps/web/README.md`.
2. Cadastre as URLs no console das lojas:
   - Política de privacidade: `https://safecircle.softechconsulting.com.br/privacidade`
   - Suporte: `https://safecircle.softechconsulting.com.br/suporte`
3. O DMARC do domínio está em `p=none`, que só observa. Depois de algumas
   semanas com SPF e DKIM passando, vale endurecer para `p=quarantine`. Antes
   disso não: uma política rígida com autenticação incompleta faz os convites
   pararem de chegar.

## Manutenção

O conteúdo das páginas legais reflete o comportamento do código. Sempre que uma
mudança alterar o que o app coleta, por quanto tempo guarda ou com quem
compartilha, a política muda no mesmo pull request. Precedente: o ADR 0015
mudou a localização para funcionar com a tela bloqueada, e o texto deixou de
dizer "só em primeiro plano" na mesma entrega.
