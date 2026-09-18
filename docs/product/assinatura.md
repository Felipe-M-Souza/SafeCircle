# Assinatura: o que cobrar, e como construir cada coisa

Planejamento, não decisão tomada. Serve para a conversa, e cada item traz o
custo de construção e o risco junto com a ideia — sem isso a lista viraria só
uma carta de desejos.

## A regra que restringe todo o resto

**O caminho de emergência nunca é pago.** Acionar o SOS, avisar o grupo,
compartilhar localização durante um alerta e receber esse alerta continuam
gratuitos para sempre, para todo mundo.

Isso não é generosidade, é a única postura defensável. Um aplicativo que
promete socorro e hesita porque a assinatura venceu é pior que não existir: a
pessoa contou com ele. Além do risco jurídico, é o tipo de decisão que destrói
a confiança no produto inteiro no dia em que vier a público.

A consequência é incômoda e precisa ser encarada de frente: **quase tudo que é
genuinamente valioso num app de segurança é uma função de segurança**, e
portanto não pode ser paywall. A assinatura tem que se sustentar em
conveniência, capacidade, histórico e custo marginal real. Isso reduz o
cardápio, e é melhor saber disso agora.

## A segunda regra: quem paga é o círculo, não a pessoa

O SafeCircle só funciona se as pessoas próximas instalarem. Se cada uma
precisar assinar, o convite passa a pedir dinheiro de quem está fazendo um
favor, e a rede não se forma.

Então a assinatura pertence a **quem organiza** e o benefício se aplica aos
**grupos que essa pessoa administra**. Uma filha assina e a mãe, o pai e o
irmão recebem as funções pagas dentro daquele círculo, sem pagar nada.

Isso também resolve o problema comercial: a pessoa disposta a pagar por
segurança normalmente está pagando pela segurança de outra pessoa.

## As funções

### 1. Contato de confiança fora do aplicativo

**O que é.** Um número de telefone que recebe SMS e ligação quando o alerta
dispara, mesmo sem ter o aplicativo instalado.

**Por que alguém paga.** É a lacuna mais óbvia do produto hoje. A pessoa que
você mais quer avisar costuma ser a que menos instala aplicativo: mãe, avó,
vizinho. Enquanto o alerta só chega a quem tem conta, o círculo real fica
menor que o círculo pretendido.

**Como implementar.** Espelha o que já existe para e-mail:

| Peça                       | Detalhe                                                        |
| -------------------------- | -------------------------------------------------------------- |
| Tabela `external_contacts` | `userId`, telefone em E.164, rótulo, `verifiedAt`              |
| Verificação                | código por SMS antes de valer como destino                     |
| `SmsProvider`              | mesma forma do `EmailProvider`, com `Noop` e `Fake` para teste |
| Família `sms` na outbox    | política própria: poucas tentativas e TTL curto                |
| Payload                    | só ids; o handler carrega o telefone na entrega                |

O TTL curto é deliberado. Um e-mail atrasado ainda serve; um SMS de emergência
entregue quarenta minutos depois não serve para nada e ainda assusta.

**Custo.** SMS no Brasil sai entre R$ 0,08 e R$ 0,15. É a única função da lista
com custo marginal por uso, o que a torna a mais fácil de justificar cobrando.
Precisa de teto mensal por assinante, senão um alerta em laço vira prejuízo.

**Risco.** Telefone é dado pessoal novo, e hoje o sistema não guarda nenhum. O
inventário de dados e a política de privacidade mudam. É a maior alteração de
superfície de privacidade da lista.

### 2. Check-ins recorrentes

**O que é.** "Toda terça e quinta, às 18h30, confirme que chegou em casa." Hoje
todo check-in é criado à mão.

**Por que alguém paga.** A função só protege quem lembra de usá-la. Recorrência
transforma um hábito frágil em rotina automática, que é exatamente o que uma
mãe quer para a filha que volta tarde da faculdade.

**Como implementar.** É a mais barata da lista. Uma tabela
`checkin_schedules` com dias da semana, horário, fuso e grupo, e um agendador
que apenas **materializa a próxima ocorrência** como um `safety_checkin`
comum. Todo o caminho de vencimento e notificação já existe e não muda.

**Risco.** Baixo. Sem dado pessoal novo, sem dependência externa.

### 3. Histórico longo

**O que é.** Hoje toda localização morre em 30 dias. A assinatura estende para
12 meses e permite exportar um trajeto específico.

**Por que alguém paga.** Rever o caminho de um dia específico, ou ter o
registro de um trajeto para anexar a um boletim de ocorrência.

**Como implementar.** Mecanicamente simples: a retenção deixa de ser constante
e passa a ser resolvida pelo plano de quem é dono do dado. Os scripts de
limpeza já varrem por data; passam a consultar o direito vigente.

**Risco — e este é o item mais delicado da lista.** Guardar localização por
doze meses não é detalhe técnico, é decisão de privacidade. Exige:

- Consentimento específico, separado, e não embutido na assinatura.
- Texto claro na política sobre o que muda e por quê.
- Uma regra escrita para quando a assinatura vence: prazo de carência, e depois
  a redução automática da janela. Continuar guardando sem assinatura ativa é
  guardar sem base legal.

Vale construir, mas depois de conversar com quem cuida do jurídico, não antes.

### 4. Chegada automática

**O que é.** Locais marcados como casa, trabalho ou faculdade. Ao chegar, o
trajeto se encerra sozinho e o grupo é avisado, sem a pessoa precisar lembrar.

**Por que alguém paga.** Remove o único passo que depende de memória justamente
no momento em que a pessoa está cansada e distraída.

**Como implementar.** Tabela `places` com rótulo, coordenada e raio. No
aplicativo, o cercamento virtual do `expo-location` com `expo-task-manager`,
seguindo o mesmo padrão da tarefa de segundo plano que já existe.

**Risco — maior do que parece.** O cercamento virtual no Android é
notoriamente irregular: vários fabricantes matam processos em segundo plano de
forma agressiva, e a chegada pode não ser detectada. Prometer automação e
entregar intermitência é pior que não prometer. Se for feito, precisa de
confirmação manual como caminho principal e a automação como conveniência.

Além disso, a coordenada de casa é o dado mais sensível que o sistema passaria
a guardar de forma permanente, e não com expiração de 30 dias como o resto.

### 5. Mais grupos e mais pessoas

**O que é.** Gratuito com um grupo e um número confortável de pessoas; pago com
vários grupos e mais gente.

**Por que alguém paga.** Quem separa família, amigas e trabalho quer grupos
distintos.

**Como implementar.** Verificação de direito na criação de grupo e no aceite de
convite. É a mais simples de todas.

**Risco.** É também a que mais me preocupa. Um limite baixo faz alguém deixar
de adicionar justamente a pessoa que ajudaria. O limite gratuito precisa ser
generoso a ponto de nunca ser o motivo de um círculo ficar incompleto.

### 6. Painel web para quem organiza

**O que é.** Ver o círculo, os trajetos em andamento e o histórico num
computador.

**Por que alguém paga.** Quem cuida de mais de uma pessoa, ou de pessoas
idosas, acompanha melhor numa tela grande.

**Como implementar.** Aplicação autenticada separada, consumindo a mesma API. A
infraestrutura necessária já existe: lista de origens permitidas no CORS,
verificação de origem no WebSocket e o próprio site já publicado na Cloudflare.

**Risco.** É a maior construção da lista. Vale depois que houver gente usando.

## Sobre o chat

Você levantou, e a resposta honesta tem duas partes.

**Chat geral dentro do app: não vale a pena.** Seu grupo de confiança já
conversa no WhatsApp, e um mensageiro pior que o WhatsApp não é usado. Pior:
mensagem é conteúdo pessoal denso, e hoje o SafeCircle quase não guarda nada
sensível além de localização com prazo. Um chat geral inverteria a proposta do
produto e traria moderação, denúncia, anexos e retenção de conteúdo alheio.

**Conversa presa ao alerta: sim, e é boa ideia.** Não é um mensageiro, é o
registro de um socorro. Existe enquanto o alerta existe, ao lado do mapa e das
confirmações que já temos, com todo mundo que importa já ali dentro. Numa
emergência, ninguém quer trocar de aplicativo para perguntar "você está onde
exatamente?".

Como implementar: tabela de mensagens com `alertId`, autor e texto; entrega
pelo hub de tempo real que já existe; notificação pelo caminho de push que já
existe. Some com o alerta, na mesma janela de 30 dias da localização.

**Mas ela não pode ser paga.** Durante uma emergência, coordenar é socorrer.
Cobrar por isso é a mesma coisa que cobrar pelo SOS.

Então eu construiria a conversa do alerta como função **gratuita**. Ela não
sustenta a assinatura, e mesmo assim vale: é o que faz o aplicativo ser aberto
no pior momento, e é aí que as pessoas decidem se confiam nele. O gancho pago
ao redor dela é o histórico: manter e exportar a conversa depois dos 30 dias,
junto com o trajeto, para quem precisa registrar o que aconteceu.

## O que a assinatura exige antes de qualquer função

| Peça                         | Por quê                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| Tabela de assinaturas        | plano, situação, origem, fim do período, carência                     |
| Resolvedor único de direitos | uma função, não `if` espalhado pelo código                            |
| Cobrança pelas lojas         | Google Play Billing e StoreKit são obrigatórios para conteúdo digital |
| Validação no servidor        | o direito vem do banco, nunca do que o aplicativo afirma              |

Para a cobrança, a escolha pragmática é um intermediário como o RevenueCat: ele
cobre as duas lojas, valida recibo e avisa por webhook. Sem ele, é preciso
implementar validação de recibo duas vezes e lidar com renovação, reembolso e
período de carência à mão, que é onde mora a maior parte dos erros.

O ponto inegociável é o último da tabela. O aplicativo informa que comprou; o
servidor só acredita no que o webhook confirmou.

## Ordem que eu recomendo

1. **Esqueleto de planos e direitos**, sem travar nada ainda. Adicionar isso
   depois, com gente usando, é muito mais caro.
2. **Check-ins recorrentes.** Valor real pelo menor custo de construção.
3. **Contato externo por SMS.** O maior valor, e o único com custo marginal que
   justifica cobrança sem desconforto.
4. **Conversa do alerta**, gratuita.
5. **Histórico longo**, depois da revisão jurídica.
6. **Chegada automática** e **painel web**, quando houver uso que justifique.

## A ressalva mais importante

O aplicativo ainda não está nas lojas e não tem usuários. Nenhuma das funções
acima vale mais, hoje, do que colocar o produto na mão de pessoas e descobrir o
que elas realmente usam.

Minha recomendação é construir só o item 1 agora, porque ele é caro de
retrofitar, e lançar tudo gratuito. As funções pagas ganham forma quando houver
alguém para dizer por qual delas pagaria — e essa resposta quase nunca é a que
a gente previu.
