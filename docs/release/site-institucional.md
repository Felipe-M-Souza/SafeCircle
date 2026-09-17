# Site institucional — publicação no Cloudflare Pages

Como publicar `apps/web` em `safecircle.softechconsulting.com.br`. Nada aqui é
segredo.

## Por que o site é um bloqueador de release

Google Play e App Store **exigem** uma URL pública de política de privacidade
no cadastro do aplicativo. Sem o site no ar, o app não é publicado. Por isso o
site entra antes da publicação, não depois.

## Por que Cloudflare Pages

|                         | Cloudflare Pages                  | HostGator (já contratado)        |
| ----------------------- | --------------------------------- | -------------------------------- |
| Custo                   | gratuito                          | já pago                          |
| Publicação              | automática a cada push no GitHub  | manual, por FTP ou cPanel        |
| Conteúdo versionado     | sim, é o próprio repositório      | só se alguém lembrar de reenviar |
| HTTPS                   | automático                        | disponível                       |
| Cabeçalhos de segurança | arquivo `_headers` no repositório | configuração no servidor         |

O que decidiu foi a publicação automática: a política de privacidade precisa
acompanhar mudanças de comportamento do app, e um processo manual acaba
esquecido. Com o Pages, atualizar o texto é abrir um pull request.

## Passo a passo

### 1. Criar o projeto no Cloudflare

1. Acesse o painel do Cloudflare e vá em **Workers & Pages**, **Create**,
   aba **Pages**, opção **Connect to Git**.
2. Autorize o acesso ao repositório `Felipe-M-Souza/SafeCircle`.
3. Configure assim:

| Campo                  | Valor           |
| ---------------------- | --------------- |
| Production branch      | `main`          |
| Framework preset       | None            |
| Build command          | deixe **vazio** |
| Build output directory | `apps/web`      |

Não há etapa de build: o site é estático e é publicado como está.

### 2. Apontar o domínio

1. No projeto criado, vá em **Custom domains**, **Set up a custom domain**.
2. Informe `safecircle.softechconsulting.com.br`.
3. O Cloudflare mostra um registro `CNAME` para adicionar.
4. No HostGator, em **Editar Zona Avançada de DNS** da zona
   `softechconsulting.com.br`, adicione esse `CNAME`.

Cuidado conhecido do cPanel: ele completa o domínio sozinho. Confira o nome
final depois de salvar, para não virar
`safecircle.softechconsulting.com.br.softechconsulting.com.br`.

### 3. Verificar que o e-mail não quebrou

O mesmo subdomínio já é usado pelo Resend para enviar convites. Site e e-mail
convivem sem conflito, mas confirme depois da mudança:

```bash
nslookup -type=TXT resend._domainkey.safecircle.softechconsulting.com.br 8.8.8.8
nslookup -type=CNAME send.safecircle.softechconsulting.com.br 8.8.8.8
nslookup -type=MX softechconsulting.com.br 8.8.8.8
```

Os dois primeiros devem continuar respondendo, e o terceiro deve continuar
apontando para `titan.email`. Se algum falhar, um registro foi sobrescrito.

## Depois de publicar

1. Preencha os trechos `[preencher]` das páginas legais e remova os avisos de
   rascunho. A lista está em `apps/web/README.md`.
2. Cadastre as URLs no console das lojas:
   - Política de privacidade: `https://safecircle.softechconsulting.com.br/privacidade.html`
   - Suporte: `https://safecircle.softechconsulting.com.br/suporte.html`
3. Considere adicionar o registro DMARC que falta em `softechconsulting.com.br`,
   com `p=none` para começar monitorando. Melhora a entrega dos convites.

## Manutenção

O conteúdo das páginas legais reflete o comportamento do código. Sempre que uma
mudança alterar o que o app coleta, por quanto tempo guarda ou com quem
compartilha, a política muda no mesmo pull request. Precedente: o ADR 0015
mudou a localização para funcionar com a tela bloqueada, e o texto deixou de
dizer "só em primeiro plano" na mesma entrega.
