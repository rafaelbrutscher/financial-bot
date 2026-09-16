# financial-bot

Roda em **Cloudflare Workers**.

```
Telegram webhook → Worker → Gemini      (extrai o lançamento)
                          → Sheets API  (grava a linha)
                          → Drive API   (reescreve a nota do mês)
                          → KV          (categorias + trava da análise semanal)
```

## Como cada parte é feita

| Parte | Implementação |
|---|---|
| **Entrada** | O webhook do Telegram bate num `POST` no Worker. Se for áudio, o Worker baixa o `.ogg` e manda direto pro Gemini como `inlineData` — sem etapa de transcrição separada. |
| **Extração** | Uma chamada ao Gemini com `responseMimeType: application/json` e a lista de categorias no prompt, então o modelo não inventa categoria. Devolve `{data, tipo, categoria, descricao, valor, conta}`. |
| **Planilha** | Uma aba por mês (`2026-09`), criada sob demanda já com cabeçalho. A linha entra via `values:append`. |
| **Nota** | Os totais são relidos da planilha e a nota `resumo-2026-09.md` é reescrita inteira no Drive, com tabelas e blocos `chart` que o Obsidian renderiza como pizza e barras. |
| **Análise** | Uma vez por semana um segundo prompt resume os números em texto curto. O KV guarda a semana ISO já processada pra não repetir a cada lançamento. |
| **Categorias** | Ficam no KV, editáveis pelo `/categorias` no Telegram. O código carrega só o padrão inicial. |
| **Acesso** | `ALLOWED_CHAT_ID`: só o seu chat recebe resposta. O webhook é público por necessidade (o Telegram chama sem login), a trava é essa. |
| **Google** | OAuth com refresh token, trocado por access token a cada request. Nenhuma chave de service account no repositório. |

## Configurando

São 8 secrets. Os cinco primeiros você coleta clicando; os três do Google exigem o passo 3.

### 1. O que dá pra pegar direto

| Secret | Onde pegar | O que fazer |
|---|---|---|
| `TELEGRAM_TOKEN` | [@BotFather](https://t.me/botfather) | `/newbot`, escolha nome e username. Ele devolve o token. |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | *Create API key*. O free tier basta. |
| `SPREADSHEET_ID` | [sheets.new](https://sheets.new) | Cria uma planilha vazia. O id está na URL: `spreadsheets/d/`**`ESTE_PEDACO`**`/edit` |
| `VAULT_FOLDER_ID` | [drive.google.com](https://drive.google.com/drive/my-drive) | Crie a pasta dentro do vault do Obsidian, abra ela: `folders/`**`ESTE_PEDACO`** |
| `ALLOWED_CHAT_ID` | `api.telegram.org/bot<TOKEN>/getUpdates` | Mande qualquer mensagem pro bot primeiro, depois abra essa URL com seu token. É o `message.chat.id`. |

### 2. Credenciais OAuth no Google Cloud

Cada link abaixo já vai direto na tela certa do console — selecione seu projeto no topo da página.

1. Crie um projeto em [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate).
2. Ative as duas APIs: [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   e [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) — botão *Ativar* em cada uma.
3. Configure a tela de consentimento em [APIs e serviços → Tela de permissão OAuth](https://console.cloud.google.com/apis/credentials/consent).
4. Em [APIs e serviços → Credenciais](https://console.cloud.google.com/apis/credentials):
   *Criar credenciais* → *ID do cliente OAuth* → **Aplicativo da Web**. Em *URIs de redirecionamento
   autorizados*, adicione `http://localhost`.
5. A caixa que aparece traz o `GOOGLE_CLIENT_ID` e o `GOOGLE_CLIENT_SECRET`.

> ⚠️ **Deixe a tela de consentimento publicada ("In production").** Com o app em *Testing*, o Google
> expira o refresh token em **7 dias** e o bot para sem avisar. Se sua conta for Google Workspace,
> escolha o tipo **Internal** — não tem esse limite nem pede verificação. Em conta pessoal, publique
> mesmo assim: aparece um aviso de "app não verificado" na hora de autorizar, é só seguir em
> *Avançado*, e o token passa a durar.

### 3. Refresh token

Não tem jeito por linha de comando só — o Google exige o consentimento no navegador. São dois passos.

Abra esta URL no navegador, trocando `SEU_CLIENT_ID`:

```
https://accounts.google.com/o/oauth2/v2/auth?client_id=SEU_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/spreadsheets%20https://www.googleapis.com/auth/drive&access_type=offline&prompt=consent
```

Autorize. O navegador vai tentar abrir `http://localhost/?code=4%2F0A...` e **falhar** — é esperado,
não tem nada rodando ali. O que importa é o `code=` na barra de endereço. Copie ele e
**decodifique**: `%2F` vira `/`. Esse code vale uma vez só e expira em minutos.

Troque o code pelo refresh token:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d client_id=SEU_CLIENT_ID \
  -d client_secret=SEU_CLIENT_SECRET \
  -d code=O_CODE_DECODIFICADO \
  -d grant_type=authorization_code \
  -d redirect_uri=http://localhost
```

O `refresh_token` da resposta é o seu `GOOGLE_REFRESH_TOKEN`.

> Os parâmetros `access_type=offline` e `prompt=consent` são o motivo de tudo isso funcionar. Sem
> eles a resposta vem só com `access_token` e você recomeça do zero. Se mesmo assim não vier
> `refresh_token`, revogue o acesso em
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions) e refaça.
>
> O escopo `drive` dá acesso amplo ao seu Drive. `drive.file` é bem mais estreito e provavelmente
> basta aqui, já que o bot só mexe em arquivos que ele mesmo cria — se quiser apertar, teste.

### 4. Deploy

```bash
npm install
npx wrangler kv namespace create GASTOS_KV   # cole o id retornado no wrangler.toml
npx wrangler deploy
```

Cadastre os secrets, um por vez:

```bash
npx wrangler secret put TELEGRAM_TOKEN
```

Repita para `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`,
`SPREADSHEET_ID`, `VAULT_FOLDER_ID` e `ALLOWED_CHAT_ID`.

Para rodar local, os mesmos nomes vão num `.dev.vars` (`cp .dev.vars.example .dev.vars`). Ele está
no `.gitignore`.

### 5. Webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://gastos-bot.<seu-subdominio>.workers.dev"
```

Manda "gastei 10 no café" pro bot. Se voltar a confirmação, está de pé.

## Comandos

- Qualquer texto ou áudio descrevendo um gasto ou receita → registra.
- `/analise` → regera a análise do mês na hora.
- `/categorias` → mostra as categorias atuais.
- `/categorias despesa Alimentação, Carro, Pets` → troca a lista de despesa (idem `receita`).
- `/categorias reset` → volta ao padrão do código.

As categorias vivem no KV, então você ajusta as suas pelo próprio bot, sem editar código nem fazer
deploy. O relatório mensal monta as tabelas a partir do que está na planilha, não da lista
configurada — categoria removida depois de já ter lançamento continua aparecendo no resumo, em vez
do gasto sumir.

## Teste

```bash
npm test
```

Cobre o parser do `/categorias` com um fake do KV. Sem framework, sem dependência.

## Custo

Cloudflare Workers (free tier) + Gemini Flash (free tier) + Sheets/Drive. Para uso pessoal, R$ 0.

## Licença

MIT
