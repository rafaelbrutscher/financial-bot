const GEMINI_MODEL = 'gemini-2.5-flash';

// Categorias iniciais. Podem ser trocadas com /categorias no bot do Telegram.
export const CATEGORIAS_PADRAO = {
  Despesa: ['Alimentação', 'Carro', 'Saúde', 'Educação', 'Compras gerais', 'Moradia', 'Lazer', 'Gatos', 'Trabalho'],
  Receita: ['Salário', 'VA', 'Outros'],
};

export async function getCategorias(env) {
  const salvas = await env.GASTOS_KV.get('categorias', 'json');
  return salvas?.Despesa?.length && salvas?.Receita?.length ? salvas : CATEGORIAS_PADRAO;
}

export async function comandoCategorias(env, arg) {
  const cats = await getCategorias(env);
  if (!arg) {
    return (
      `<b>Despesa:</b> ${cats.Despesa.join(', ')}\n<b>Receita:</b> ${cats.Receita.join(', ')}\n\n` +
      'Trocar: <code>/categorias despesa Alimentação, Carro, Pets</code>\n' +
      'Voltar ao padrão: <code>/categorias reset</code>'
    );
  }
  if (arg.toLowerCase() === 'reset') {
    await env.GASTOS_KV.delete('categorias');
    return 'Categorias voltaram ao padrão.';
  }
  const m = arg.match(/^(despesa|receita)\s+(.+)$/is);
  if (!m) return 'Não entendi. Use <code>/categorias despesa Alimentação, Carro</code> ou <code>/categorias reset</code>.';
  const tipo = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const lista = [...new Set(m[2].split(',').map((c) => c.trim()).filter(Boolean))];
  if (!lista.length) return 'Preciso de pelo menos uma categoria.';
  if (lista.length > 30 || lista.some((c) => c.length > 40)) return 'Limite: 30 categorias, 40 caracteres cada.';
  await env.GASTOS_KV.put('categorias', JSON.stringify({ ...cats, [tipo]: lista }));
  return `<b>${tipo}</b> agora: ${lista.join(', ')}`;
}

const CONTAS = {
  Despesa: ['Banco', 'VA', 'Crédito', 'Dinheiro'],
  Receita: ['Salário', 'VA', 'Outros'],
};
const HEADER = ['Data', 'Tipo', 'Categoria', 'Descrição', 'Valor', 'Conta'];

function range(nomeAba, celulas) {
  const escapado = nomeAba.replace(/'/g, "''");
  return `'${escapado}'!${celulas}`;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('ok', { status: 200 });
    }
    let update;
    try {
      update = await request.json();
      await handleUpdate(update, env);
    } catch (err) {
      console.error('Erro:', err);
      const chatId = update?.message?.chat?.id;
      if (chatId) {
        try {
          await enviarMensagem(env, chatId, 'Deu um erro ao registrar. Tenta de novo daqui a pouco.');
        } catch (_) {}
      }
    }
    return new Response('ok', { status: 200 });
  },
};

async function handleUpdate(update, env) {
  const msg = update?.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  if (env.ALLOWED_CHAT_ID && chatId !== env.ALLOWED_CHAT_ID) {
    await enviarMensagem(env, chatId, 'Este bot é privado.');
    return;
  }

  let lancamento;
  let comandoAnalise = false;

  if (msg.voice || msg.audio) {
    const file = msg.voice || msg.audio;
    const { base64, mimeType } = await baixarArquivoTelegram(env, file.file_id, file.mime_type);
    lancamento = await extrairComGemini(env, [
      { text: 'Extraia o lançamento financeiro deste áudio.' },
      { inlineData: { mimeType, data: base64 } },
    ]);
  } else if (msg.text) {
    const texto = msg.text.trim();
    if (texto === '/analise') {
      comandoAnalise = true;
    } else if (texto.startsWith('/categorias')) {
      await enviarMensagem(env, chatId, await comandoCategorias(env, texto.slice('/categorias'.length).trim()));
      return;
    } else if (texto.startsWith('/')) {
      await enviarMensagem(env, chatId, 'Manda um gasto por texto ou áudio, tipo: "gastei 40 no mercado" ou "recebi 1200 de VA". Use /analise pra ver a análise do mês e /categorias pra ver ou trocar as categorias.');
      return;
    } else {
      lancamento = await extrairComGemini(env, [{ text: texto }]);
    }
  } else {
    return;
  }

  const token = await getGoogleAccessToken(env);

  if (comandoAnalise) {
    const nomeAba = new Date().toISOString().slice(0, 7);
    const analise = await gerarAnalise(env, token, nomeAba);
    await atualizarNotaResumo(env, token, nomeAba, analise);
    await enviarMensagem(env, chatId, `📊 Análise atualizada na nota.\n\n${analise || 'Sem dados suficientes ainda.'}`);
    return;
  }

  if (lancamento?.erro) {
    await enviarMensagem(env, chatId, 'Não entendi isso como um gasto ou receita. Pode reformular?');
    return;
  }

  const nomeAba = await inserirLancamento(env, token, lancamento);

  let analise = null;
  const semanaAtual = getSemanaISO(new Date());
  const ultimaSemana = await env.GASTOS_KV.get('ultima_semana_analise');
  if (ultimaSemana !== semanaAtual) {
    analise = await gerarAnalise(env, token, nomeAba);
    await env.GASTOS_KV.put('ultima_semana_analise', semanaAtual);
    await env.GASTOS_KV.put('ultima_analise_texto', analise || '');
  } else {
    analise = (await env.GASTOS_KV.get('ultima_analise_texto')) || null;
  }

  await atualizarNotaResumo(env, token, nomeAba, analise);

  const emoji = lancamento.tipo === 'Despesa' ? '💸' : '💰';
  let resposta =
    `${emoji} <b>${lancamento.tipo}</b> registrada\n` +
    `R$ ${fmt(lancamento.valor)} · ${lancamento.categoria}\n` +
    `${lancamento.descricao} · ${lancamento.conta} · ${lancamento.data}`;
  if (ultimaSemana !== semanaAtual && analise) {
    resposta += `\n\n📊 <b>Análise da semana:</b>\n${analise}`;
  }
  await enviarMensagem(env, chatId, resposta);
}

function getSemanaISO(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function enviarMensagem(env, chatId, texto) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
  });
}

async function baixarArquivoTelegram(env, fileId, mimeType) {
  const info = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`)).json();
  if (!info.ok) throw new Error('Não consegui obter o arquivo do Telegram.');
  const filePath = info.result.file_path;
  const fileResp = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  const buf = await fileResp.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  return { base64, mimeType: mimeType || 'audio/ogg' };
}

function buildPrompt(hojeISO, categorias) {
  return `Você é um extrator de lançamentos financeiros. Recebe uma mensagem (texto ou áudio) relatando um gasto ou receita e devolve APENAS um objeto JSON, sem texto ao redor, sem markdown, sem crases.

Campos do JSON:
- "data": YYYY-MM-DD. Sem data informada, use hoje (${hojeISO}). Interprete "ontem", "dia 5" etc. relativo a hoje.
- "tipo": "Despesa" ou "Receita".
- "categoria": uma das categorias válidas para o tipo.
- "descricao": descrição curta (ex: "mercado passarela", "gasolina").
- "valor": número decimal com ponto (ex: 52.76). Sem símbolo de moeda.
- "conta": de qual conta saiu (despesa) ou de onde veio (receita).

Despesa - categorias: ${categorias.Despesa.join(', ')}.
Receita - categorias: ${categorias.Receita.join(', ')}.
Despesa - contas: ${CONTAS.Despesa.join(', ')}.
Receita - contas: ${CONTAS.Receita.join(', ')}.

Regras:
- Despesa sem conta informada: use "Banco".
- Receita sem conta: deduza pela categoria (Salário->Salário, VA->VA, senão Outros).
- Escolha sempre a categoria da lista que melhor descreve o gasto. Se nenhuma encaixar bem, use a mais genérica da lista.
- Se não for um lançamento financeiro, devolva {"erro": "não é um lançamento"}.

Responda somente com o JSON.`;
}

async function extrairComGemini(env, parts) {
  const hojeISO = new Date().toISOString().slice(0, 10);
  const categorias = await getCategorias(env);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: buildPrompt(hojeISO, categorias) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gemini falhou (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini não retornou texto.');
  return JSON.parse(text);
}

async function gerarAnalise(env, token, nomeAba) {
  const totais = await lerTotais(env, token, nomeAba);
  if (totais.totalDespesa === 0) return null;

  const resumoTexto =
    `Mês: ${nomeAba}. ` +
    `Receitas por categoria: ${JSON.stringify(totais.totaisReceita)}. ` +
    `Despesas por categoria: ${JSON.stringify(totais.totaisDespesa)}. ` +
    `Total receita: ${totais.totalReceita.toFixed(2)}. Total despesa: ${totais.totalDespesa.toFixed(2)}. ` +
    `Saldo: ${(totais.totalReceita - totais.totalDespesa).toFixed(2)}.`;

  const prompt = `Você é um assistente financeiro pessoal, direto e honesto. Recebe o resumo de gastos do mês de uma pessoa e escreve uma análise curta (máximo 5 frases) em português brasileiro.

Regras:
- Aponte a categoria onde ela mais gasta e se algo parece desproporcional.
- Se o saldo estiver negativo, diga isso claramente.
- Dê no máximo 1 sugestão prática de economia, específica ao padrão dos dados.
- Não invente contexto que não está nos dados. Não seja genérico ("gaste menos"). Seja específico aos números.
- Não use markdown nem bullets. Texto corrido, curto.

Dados: ${resumoTexto}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function getGoogleAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`OAuth falhou (${resp.status}): ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

async function inserirLancamento(env, token, l) {
  const nomeAba = l.data.slice(0, 7);
  await garantirAba(env, token, nomeAba);
  const linha = [l.data, l.tipo, l.categoria, l.descricao, l.valor, l.conta];
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range(nomeAba, 'A:F'))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [linha] }),
  });
  if (!resp.ok) throw new Error(`Sheets append falhou (${resp.status}): ${await resp.text()}`);
  return nomeAba;
}

async function garantirAba(env, token, nomeAba) {
  const metaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaResp.json();
  const existe = (meta.sheets || []).some((s) => s.properties.title === nomeAba);

  if (!existe) {
    const criaResp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: nomeAba } } }] }),
    });
    if (!criaResp.ok) throw new Error(`Falha ao criar aba (${criaResp.status}): ${await criaResp.text()}`);
    await escreverCabecalho(env, token, nomeAba);
  } else {
    const headResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range(nomeAba, 'A1:F1'))}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const head = await headResp.json();
    if (!head.values || head.values.length === 0) {
      await escreverCabecalho(env, token, nomeAba);
    }
  }
}

async function escreverCabecalho(env, token, nomeAba) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range(nomeAba, 'A1'))}?valueInputOption=USER_ENTERED`;
  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [HEADER] }),
  });
}

async function lerTotais(env, token, nomeAba) {
  const valsResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/${encodeURIComponent(range(nomeAba, 'A2:F'))}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const vals = await valsResp.json();
  const linhas = vals.values || [];

  const totaisDespesa = {}, totaisReceita = {};
  let totalDespesa = 0, totalReceita = 0;
  for (const row of linhas) {
    const [, tipo, categoria, , valorStr] = row;
    const valor = parseFloat(String(valorStr).replace(',', '.')) || 0;
    if (tipo === 'Despesa') { totaisDespesa[categoria] = (totaisDespesa[categoria] || 0) + valor; totalDespesa += valor; }
    else if (tipo === 'Receita') { totaisReceita[categoria] = (totaisReceita[categoria] || 0) + valor; totalReceita += valor; }
  }
  return { totaisDespesa, totaisReceita, totalDespesa, totalReceita };
}

async function atualizarNotaResumo(env, token, nomeAba, analise) {
  const t = await lerTotais(env, token, nomeAba);
  const conteudo = montarNota(nomeAba, t, analise);
  const nomeArquivo = `resumo-${nomeAba}.md`;

  const q = encodeURIComponent(`name='${nomeArquivo}' and '${env.VAULT_FOLDER_ID}' in parents and trashed=false`);
  const buscaResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const busca = await buscaResp.json();

  if (busca.files && busca.files.length > 0) {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${busca.files[0].id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
      body: conteudo,
    });
  } else {
    const boundary = '-------314159265358979323846';
    const metadata = { name: nomeArquivo, parents: [env.VAULT_FOLDER_ID], mimeType: 'text/markdown' };
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n` +
      conteudo +
      `\r\n--${boundary}--`;
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: multipart,
    });
  }
}

function montarNota(nomeAba, t, analise) {
  const porValor = (totais) => Object.entries(totais).filter(([, v]) => v).sort((a, b) => b[1] - a[1]);
  const linhasD = porValor(t.totaisDespesa).map(([c, v]) => `| ${c} | R$ ${fmt(v)} |`).join('\n');
  const linhasR = porValor(t.totaisReceita).map(([c, v]) => `| ${c} | R$ ${fmt(v)} |`).join('\n');
  const saldo = t.totalReceita - t.totalDespesa;
  const atualizado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const catsDespesa = porValor(t.totaisDespesa);
  const graficoPizza = catsDespesa.length
    ? "```chart\ntype: pie\nlabels: [" + catsDespesa.map(([c]) => `"${c}"`).join(', ') + "]\nseries:\n  - data: [" + catsDespesa.map(([, v]) => v.toFixed(2)).join(', ') + "]\n```"
    : '_Sem despesas ainda._';

  const graficoBarras = "```chart\ntype: bar\nlabels: [\"Receita\", \"Despesa\"]\nseries:\n  - title: Total\n    data: [" + t.totalReceita.toFixed(2) + ", " + t.totalDespesa.toFixed(2) + "]\n```";

  const blocoAnalise = analise
    ? `## Análise da IA\n> Observações automáticas sobre seus gastos. Não é consultoria financeira.\n\n${analise}\n`
    : '';

  return `---
tags: [financeiro, resumo]
mes: ${nomeAba}
atualizado: ${atualizado}
---

# Resumo financeiro — ${nomeAba}

> Nota gerada automaticamente. Não edite à mão — os dados brutos ficam na planilha.

## Despesas por categoria
${graficoPizza}

## Receita vs Despesa
${graficoBarras}

## Receitas
| Categoria | Valor |
|-----------|-------|
${linhasR || '| — | R$ 0,00 |'}
| **Total** | **R$ ${fmt(t.totalReceita)}** |

## Despesas
| Categoria | Valor |
|-----------|-------|
${linhasD || '| — | R$ 0,00 |'}
| **Total** | **R$ ${fmt(t.totalDespesa)}** |

## Saldo
**R$ ${fmt(saldo)}** ${saldo >= 0 ? '🟢' : '🔴'}

${blocoAnalise}`;
}

function fmt(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
