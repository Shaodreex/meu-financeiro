# Meu Financeiro

Sistema financeiro pessoal em formato **PWA**, desenvolvido para controle diário de receitas, despesas, cartões, faturas, assinaturas, contas recorrentes e planejamento financeiro.

O sistema funciona em desktop e dispositivos móveis, incluindo iPhone, com possibilidade de instalação na tela inicial como aplicativo.

Os dados são sincronizados entre dispositivos utilizando **Supabase**.

---

## Funcionalidades

### Dashboard

* Resumo financeiro mensal
* Total de receitas
* Total de despesas
* Saldo do mês
* Contas pendentes
* Gastos por categoria
* Comparativo entre previsto e realizado
* Indicadores financeiros
* Visão consolidada do mês selecionado

### Lançamentos

Permite cadastrar receitas e despesas com informações como:

* Data
* Descrição
* Categoria
* Valor
* Forma de pagamento
* Situação
* Observações

Também é possível:

* Editar lançamentos
* Excluir lançamentos
* Pesquisar
* Filtrar registros
* Marcar contas como pagas ou pendentes

---

## Cartões e faturas

O sistema possui controle de cartões de crédito.

É possível cadastrar:

* Nome do cartão
* Limite
* Dia de fechamento
* Dia de vencimento

As compras realizadas no cartão são agrupadas por fatura.

O sistema permite acompanhar:

* Valor da fatura
* Limite utilizado
* Limite disponível
* Faturas abertas
* Faturas pagas

---

## Compras parceladas

Ao cadastrar uma compra parcelada, o sistema divide automaticamente o valor entre os meses.

Exemplo:

```text
Notebook
Valor total: R$ 4.800,00
Parcelamento: 12x
```

O sistema gera:

```text
Notebook (1/12)
Notebook (2/12)
Notebook (3/12)
...
Notebook (12/12)
```

Cada parcela é registrada na competência correspondente.

---

## Fixos e assinaturas

Área destinada a despesas e receitas recorrentes.

Pode ser utilizada para cadastrar:

* Internet
* Plano de celular
* Chip de internet
* Streaming
* Academia
* Softwares
* Serviços online
* Seguros
* Aluguéis
* Receitas recorrentes
* Outras despesas fixas

Cada recorrência pode conter:

* Descrição
* Tipo
* Empresa ou fornecedor
* Valor
* Dia de vencimento
* Forma de pagamento
* Cartão utilizado
* Status ativo ou inativo

Os lançamentos podem ser gerados automaticamente a cada mês.

---

## Categorias

As categorias podem ser personalizadas de acordo com a necessidade.

Exemplos:

* Alimentação
* Transporte
* Moradia
* Saúde
* Educação
* Lazer
* Assinaturas
* Internet
* Telefonia
* Compras
* Serviços
* Receitas
* Outros

---

## Recursos financeiros

O sistema também permite registrar valores disponíveis em diferentes recursos.

Exemplos:

* Conta corrente
* Conta digital
* Dinheiro
* Reserva
* Investimentos

---

## Sincronização

O sistema utiliza **Supabase** para manter os dados sincronizados.

Fluxo simplificado:

```text
iPhone
   ↘
   Supabase
   ↗
Desktop
```

Isso permite cadastrar um lançamento em um dispositivo e visualizar a mesma informação no outro.

---

## Autenticação

O acesso ao sistema é feito por:

* E-mail
* Senha

Cada usuário possui seus próprios dados.

A segurança do banco utiliza **Row Level Security — RLS** do Supabase.

Cada registro fica vinculado ao usuário autenticado.

---

## Tecnologias utilizadas

* HTML5
* CSS3
* JavaScript
* PWA
* Service Worker
* Local Storage
* Supabase
* PostgreSQL
* GitHub Pages

---

## Estrutura do projeto

```text
meu-financeiro/
│
├── index.html
├── app.js
├── styles.css
├── sw.js
├── manifest.webmanifest
├── supabase-config.js
├── README.md
│
└── assets/
    ├── icon.svg
    ├── icon-192.png
    ├── icon-512.png
    └── apple-touch-icon.png
```

---

## Configuração do Supabase

O projeto utiliza um arquivo:

```text
supabase-config.js
```

Estrutura:

```javascript
window.MF_SUPABASE = {
  url: 'PROJECT_URL',
  publishableKey: 'PUBLISHABLE_KEY'
};
```

Utilizar somente a chave pública destinada ao frontend.

Nunca utilizar no código:

```text
service_role
```

ou qualquer chave secreta administrativa.

---

## Banco de dados

A estrutura inicial do banco pode ser criada utilizando:

```text
setup_supabase.sql
```

O script configura:

* Tabelas
* Relacionamento com usuários
* Políticas RLS
* Permissões
* Estrutura necessária para sincronização

---

## GitHub Pages

O sistema pode ser hospedado gratuitamente utilizando GitHub Pages.

Configuração:

```text
Settings
→ Pages
→ Deploy from a branch
→ main
→ / (root)
```

O endereço normalmente ficará no formato:

```text
https://usuario.github.io/meu-financeiro/
```

---

## Instalação no iPhone

Abra o endereço do sistema utilizando o Safari.

Depois:

```text
Compartilhar
→ Adicionar à Tela de Início
→ Abrir como App da Web
→ Adicionar
```

O sistema passará a aparecer na tela inicial do iPhone como um aplicativo.

---

## Atualização do sistema

Após modificar arquivos no GitHub:

1. Fazer commit das alterações.
2. Aguardar o GitHub Pages finalizar o deploy.
3. Abrir o sistema novamente.

O Service Worker utiliza versionamento de cache.

Sempre que houver uma atualização estrutural importante, recomenda-se alterar a versão do cache em:

```text
sw.js
```

Exemplo:

```javascript
const CACHE_NAME = 'meu-financeiro-v4';
```

Isso ajuda a evitar que celulares continuem utilizando arquivos antigos.

---

## Backup

Mesmo com sincronização online, o sistema possui opção de backup.

É recomendado realizar backups periodicamente.

O backup pode ser utilizado para:

* Segurança adicional
* Migração
* Recuperação de dados
* Arquivamento

Nunca publicar arquivos de backup no repositório público.

Exemplo de arquivo que não deve ser enviado ao GitHub:

```text
meu-financeiro-backup.json
```

---

## Segurança

O repositório pode conter o código frontend do projeto.

Não devem ser publicados:

* Senhas
* Secret Keys
* Service Role Key
* Backups financeiros
* Arquivos pessoais
* Planilhas com dados financeiros
* Tokens administrativos

A Publishable Key do Supabase é destinada ao frontend e deve sempre ser utilizada em conjunto com políticas RLS corretamente configuradas.

---

## Objetivo do projeto

O objetivo do Meu Financeiro é oferecer um controle financeiro simples e rápido para uso cotidiano.

O fluxo principal foi pensado para ser:

```text
Abrir
→ Novo lançamento
→ Preencher
→ Salvar
```

Sem necessidade de manipulação manual de planilhas ou fórmulas.

---

## Status

Projeto em evolução.

Funcionalidades atuais:

* [x] Dashboard
* [x] Receitas
* [x] Despesas
* [x] Contas pendentes
* [x] Categorias
* [x] Recursos financeiros
* [x] Assinaturas
* [x] Contas recorrentes
* [x] Cartões de crédito
* [x] Faturas
* [x] Compras parceladas
* [x] Login
* [x] Sincronização Supabase
* [x] PWA
* [x] Instalação no iPhone
* [x] Backup e restauração

Possíveis evoluções:

* [ ] Fechamento mensal
* [ ] Comparativo mensal avançado
* [ ] Metas financeiras
* [ ] Controle de investimentos
* [ ] Alertas de vencimento
* [ ] Notificações
* [ ] Melhorias nos relatórios
* [ ] Importação de extratos
* [ ] Dashboard anual

---

## Licença

Projeto de uso pessoal.
