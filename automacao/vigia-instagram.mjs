// =============================================================================
//  LHM — Vigia de Instagram (degrau 1: "Vigia")
// -----------------------------------------------------------------------------
//  Plantão dos COMENTÁRIOS do @lhmengenharia. Roda de hora em hora na nuvem do
//  GitHub. Quando aparece um comentário NOVO num post recente, ele:
//    1. escreve uma SUGESTÃO de resposta no tom premium da LHM (via IA), e
//    2. te avisa no Telegram com o comentário + a sugestão pronta pra copiar.
//  NÃO responde sozinho — você decide e responde no Instagram. Risco zero.
//
//  Segredos lidos do ambiente (GitHub Secrets):
//    INSTAGRAM_TOKEN        token de acesso longo (60 dias) da API do Instagram
//    INSTAGRAM_API_VER      (opcional) versão da API, ex.: v21.0 (padrão abaixo)
//    TELEGRAM_TOKEN         bot do Telegram
//    TELEGRAM_CHAT_ID       seu chat
//    ANTHROPIC_API_KEY      (opcional) liga a IA que escreve a sugestão
//
//  Estado (pra não avisar o mesmo comentário 2x): arquivo .vigia-estado.json,
//  restaurado/salvo pelo cache do GitHub Actions (ver o .yml).
// =============================================================================

import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.INSTAGRAM_TOKEN;
const API = process.env.INSTAGRAM_API_VER || "v21.0";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ESTADO_PATH = process.env.VIGIA_ESTADO || ".vigia-estado.json";
const MAX_POSTS = 8;     // quantos posts recentes vigiar
const MAX_IDS = 500;     // quantos IDs de comentário guardar no histórico

// Se ainda não há token (você está criando o app), não faz nada — sai limpo,
// sem erro, pra não disparar alarme de falha enquanto o app não está pronto.
if (!TOKEN) {
  console.log("Vigia: INSTAGRAM_TOKEN ainda não configurado. Nada a fazer (saindo OK).");
  process.exit(0);
}
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Vigia: faltam TELEGRAM_TOKEN/TELEGRAM_CHAT_ID. Abortando.");
  process.exit(1);
}

const GRAPH = `https://graph.instagram.com/${API}`;

async function getJSON(url, label) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!r.ok) {
      console.error(`[${label}] HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
      return null;
    }
    return j;
  } catch (e) {
    console.error(`[${label}] erro: ${e.message}`);
    return null;
  }
}

// ---- Estado (comentários já avisados) ---------------------------------------

async function lerEstado() {
  try {
    const raw = await readFile(ESTADO_PATH, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j.vistos) ? j.vistos : [];
  } catch {
    return []; // primeira vez
  }
}

async function salvarEstado(vistos) {
  const corte = vistos.slice(-MAX_IDS); // só os mais recentes
  await writeFile(ESTADO_PATH, JSON.stringify({ vistos: corte }, null, 2), "utf8");
}

// ---- Coleta dos comentários recentes ----------------------------------------

async function buscarPostsRecentes() {
  const url =
    `${GRAPH}/me/media?fields=id,caption,permalink,timestamp&limit=${MAX_POSTS}` +
    `&access_token=${encodeURIComponent(TOKEN)}`;
  const j = await getJSON(url, "media");
  return j?.data || [];
}

async function buscarComentarios(mediaId) {
  const url =
    `${GRAPH}/${mediaId}/comments?fields=id,text,username,timestamp` +
    `&access_token=${encodeURIComponent(TOKEN)}`;
  const j = await getJSON(url, "comments");
  return j?.data || [];
}

// ---- IA: sugestão de resposta no tom da LHM ---------------------------------

const SYSTEM = `Você é o atendimento da LHM Engenharia — construtora premium de Curitiba e do Litoral do Paraná (Caiobá, Guaratuba, Matinhos), especializada em Steel Frame e residências de alto padrão. Site: lhmsteelframe.com.br. Instagram: @lhmengenharia. Vende via WhatsApp.
Tom: premium, técnico, cordial e sóbrio. NUNCA apela a preço baixo nem faz promessas infantis. Diferenciais reais: engenheiro na obra todo dia, escopo fechado sem aditivos, ART por obra, conformidade ABNT, aço galvanizado normatizado.
Você escreve a SUGESTÃO de resposta a um comentário no Instagram. Regras: 1-3 frases, calorosa e útil, sem emojis exagerados (no máximo 1). Se houver interesse de obra/orçamento, convide gentilmente para o WhatsApp. Se for elogio, agradeça com classe e reforce 1 diferencial. Se for crítica/dúvida técnica, responda com segurança e sem arrogância. Responda APENAS com o texto da resposta sugerida, nada mais.`;

async function sugerirResposta(comentario, legendaPost) {
  if (!ANTHROPIC_API_KEY) {
    return "Obrigado pelo contato! Se quiser, me chame no WhatsApp (link no perfil) que eu te explico em detalhes. — LHM Engenharia";
  }
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Post (contexto): "${(legendaPost || "").slice(0, 300)}"\n` +
          `Comentário de @${comentario.username}: "${comentario.text}"\n\n` +
          `Escreva a melhor resposta sugerida.`,
      },
    ],
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    console.error(`Anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return "(IA indisponível agora — responda à mão. Sugestão: agradeça e convide para o WhatsApp.)";
  }
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
}

// ---- Telegram ---------------------------------------------------------------

async function avisarTelegram(texto) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram falhou: " + JSON.stringify(j));
}

// ---- Main -------------------------------------------------------------------

(async () => {
  console.log("== LHM Vigia de Instagram ==");

  // Confere quem é a conta (e valida o token de cara).
  const eu = await getJSON(`${GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(TOKEN)}`, "me");
  if (!eu) {
    console.error("Não consegui validar o token do Instagram. Verifique INSTAGRAM_TOKEN/INSTAGRAM_API_VER.");
    process.exit(1);
  }
  console.log(`Conta: @${eu.username || "?"} (id ${eu.id || "?"})`);

  const vistos = await lerEstado();
  const setVistos = new Set(vistos);
  const primeiraVez = vistos.length === 0;

  const posts = await buscarPostsRecentes();
  console.log(`Posts recentes vigiados: ${posts.length}`);

  const novos = [];
  for (const post of posts) {
    const comentarios = await buscarComentarios(post.id);
    for (const c of comentarios) {
      if (setVistos.has(c.id)) continue;
      setVistos.add(c.id);
      // ignora comentários do próprio perfil (respostas suas)
      if ((c.username || "").toLowerCase() === (eu.username || "").toLowerCase()) continue;
      novos.push({ post, c });
    }
  }

  // Na PRIMEIRA execução, só registra o que já existe (não dispara um monte de
  // aviso retroativo). A partir daí, só avisa o que for realmente novo.
  if (primeiraVez) {
    await salvarEstado([...setVistos]);
    console.log(`Primeira execução: registrei ${setVistos.size} comentários existentes sem avisar (baseline).`);
    return;
  }

  console.log(`Comentários NOVOS para avisar: ${novos.length}`);
  for (const { post, c } of novos) {
    const sugestao = await sugerirResposta(c, post.caption);
    const msg =
      `💬 NOVO COMENTÁRIO no Instagram\n\n` +
      `De: @${c.username}\n` +
      `Comentário: "${c.text}"\n\n` +
      `✍️ Resposta sugerida (copie e cole se gostar):\n${sugestao}\n\n` +
      `🔗 Abrir o post: ${post.permalink || "—"}\n` +
      `— Vigia LHM 🤖 (você decide; ele não responde sozinho)`;
    await avisarTelegram(msg);
    console.log(`Avisado: comentário ${c.id} de @${c.username}`);
  }

  await salvarEstado([...setVistos]);
  console.log("Vigia concluído.");
})().catch((e) => {
  console.error("ERRO FATAL:", e.message);
  process.exit(1);
});
