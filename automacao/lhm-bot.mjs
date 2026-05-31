// =============================================================================
//  LHM Intelligence Bot — robô autônomo (GitHub Actions → WhatsApp)
// -----------------------------------------------------------------------------
//  Roda na nuvem do GitHub (internet liberada), puxa dados REAIS de marketing
//  (Instagram, Meta Ads e Google Analytics do site) e entrega um relatório
//  no WhatsApp do dono via CallMeBot. Funciona mesmo com o PC desligado.
//
//  Modos (variável de ambiente MODE):
//    briefing  → relatório matinal diário
//    radar     → cidades quentes & concorrência (semanal)
//    raiox     → raio-x de performance (semanal)
//
//  Segredos lidos do ambiente (GitHub Secrets):
//    WINDSOR_KEY_ADS    chave Windsor com Instagram + Meta Ads
//    WINDSOR_KEY_GA     chave Windsor com Google Analytics do site
//    ANTHROPIC_API_KEY  (OPCIONAL) liga a IA que escreve o texto
//  Entrega no WhatsApp (CallMeBot) já vem configurada por padrão.
// =============================================================================

const MODE = (process.env.MODE || "briefing").trim();

// Canal de entrega: "whatsapp" (padrão) ou "telegram".
const CHANNEL = (process.env.CHANNEL || "whatsapp").trim().toLowerCase();

// WhatsApp via CallMeBot (funciona no GitHub Actions, que tem internet liberada).
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE || "554195374510";
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY || "5122161";

// Telegram (opcional, só se CHANNEL=telegram).
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const WINDSOR_KEY_ADS = process.env.WINDSOR_KEY_ADS;
const WINDSOR_KEY_GA = process.env.WINDSOR_KEY_GA;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (CHANNEL === "telegram" && (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID)) {
  console.error("Canal telegram exige TELEGRAM_TOKEN e TELEGRAM_CHAT_ID. Abortando.");
  process.exit(1);
}
if (CHANNEL === "whatsapp" && (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY)) {
  console.error("Canal whatsapp exige CALLMEBOT_PHONE e CALLMEBOT_APIKEY. Abortando.");
  process.exit(1);
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const brl = (x) => "R$ " + num(x).toFixed(2).replace(".", ",");
const hoje = () =>
  new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

// Cidades que claramente são robôs/irrelevantes para a LHM.
const CIDADES_ROBO = new Set([
  "Hyderabad", "Kurnool", "Warsaw", "Buenos Aires", "Encarnacion",
  "(not set)", "", "Mountain View", "Ashburn",
]);

async function getJSON(url, label) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      console.error(`[${label}] HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    return Array.isArray(j) ? j : j.data || j.result || null;
  } catch (e) {
    console.error(`[${label}] erro: ${e.message}`);
    return null;
  }
}

// ---- Coleta de dados reais --------------------------------------------------

async function coletarInstagram() {
  if (!WINDSOR_KEY_ADS) return null;
  const url =
    `https://connectors.windsor.ai/instagram?api_key=${WINDSOR_KEY_ADS}` +
    `&date_preset=last_7d&fields=date,username,followers_count,reach,views,total_interactions,likes,comments,saves,shares`;
  const rows = await getJSON(url, "instagram");
  if (!rows || !rows.length) return null;
  const soma = (k) => rows.reduce((t, r) => t + num(r[k]), 0);
  const followers = rows.map((r) => num(r.followers_count)).filter(Boolean).pop() || 0;
  const melhorDia = rows.slice().sort((a, b) => num(b.reach) - num(a.reach))[0];
  return {
    username: rows[0]?.username || "lhmengenharia",
    followers,
    reach: soma("reach"),
    views: soma("views"),
    interacoes: soma("total_interactions"),
    melhorDia: melhorDia?.date || "—",
  };
}

async function coletarAds() {
  if (!WINDSOR_KEY_ADS) return null;
  const url =
    `https://connectors.windsor.ai/all?api_key=${WINDSOR_KEY_ADS}` +
    `&date_preset=last_7d&fields=date,source,campaign,clicks,spend`;
  const rows = await getJSON(url, "ads");
  if (!rows || !rows.length) return null;
  const onlyAds = rows.filter((r) => num(r.spend) > 0 || num(r.clicks) > 0);
  const base = onlyAds.length ? onlyAds : rows;
  const spend = base.reduce((t, r) => t + num(r.spend), 0);
  const clicks = base.reduce((t, r) => t + num(r.clicks), 0);
  const porCampanha = {};
  for (const r of base) {
    const c = r.campaign || "—";
    porCampanha[c] = (porCampanha[c] || 0) + num(r.clicks);
  }
  const topCampanha =
    Object.entries(porCampanha).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return { spend, clicks, cpc: clicks ? spend / clicks : 0, topCampanha };
}

async function coletarSite() {
  if (!WINDSOR_KEY_GA) return null;
  const url =
    `https://connectors.windsor.ai/googleanalytics4?api_key=${WINDSOR_KEY_GA}` +
    `&date_preset=last_7d&fields=date,city,totalusers,newusers,sessions,source`;
  const rows = await getJSON(url, "ga4");
  if (!rows || !rows.length) return null;
  const totalusers = rows.reduce((t, r) => t + num(r.totalusers), 0);
  const newusers = rows.reduce((t, r) => t + num(r.newusers), 0);
  const sessions = rows.reduce((t, r) => t + num(r.sessions), 0);
  const porCidade = {};
  const porFonte = {};
  for (const r of rows) {
    const cidade = (r.city || "").trim();
    if (!CIDADES_ROBO.has(cidade)) porCidade[cidade] = (porCidade[cidade] || 0) + num(r.totalusers);
    const f = (r.source || "—").trim();
    porFonte[f] = (porFonte[f] || 0) + num(r.sessions);
  }
  const topCidades = Object.entries(porCidade)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([c]) => c);
  const topFonte = Object.entries(porFonte).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  return { totalusers, newusers, sessions, topCidades, topFonte };
}

// ---- Montagem do "dossiê" de dados pra IA ou pro template -------------------

function dossie({ ig, ads, site }) {
  const linhas = [];
  if (ig) {
    linhas.push(
      `Instagram @${ig.username} (7d): ${ig.reach} de alcance, ${ig.views} views, ` +
        `${ig.interacoes} interações, ${ig.followers} seguidores. Melhor dia: ${ig.melhorDia}.`
    );
  } else linhas.push("Instagram: dados indisponíveis.");
  if (ads) {
    linhas.push(
      `Meta Ads (7d): investido ${brl(ads.spend)}, ${ads.clicks} cliques, ` +
        `CPC ${brl(ads.cpc)}. Campanha destaque: ${ads.topCampanha}.`
    );
  } else linhas.push("Meta Ads: dados indisponíveis.");
  if (site) {
    linhas.push(
      `Site lhmsteelframe.com.br (7d): ${site.totalusers} visitantes ` +
        `(${site.newusers} novos), ${site.sessions} sessões. ` +
        `Top cidades: ${site.topCidades.join(", ") || "—"}. Maior origem: ${site.topFonte}.`
    );
  } else linhas.push("Site (Google Analytics): dados indisponíveis.");
  return linhas.join("\n");
}

// ---- Camada de IA (opcional, via Anthropic API) -----------------------------

const SYSTEM = `Você é o estrategista de marketing da LHM Engenharia — construtora premium de Curitiba e do Litoral do Paraná (Caiobá, Guaratuba, Matinhos), especializada em Steel Frame e residências de alto padrão. Site: lhmsteelframe.com.br. Instagram: @lhmengenharia. Vende via WhatsApp.
Tom de voz: premium, técnico, sóbrio, confiante. NUNCA apelo a preço baixo nem promessas infantis. Diferenciais reais: engenheiro na obra todo dia, escopo fechado sem aditivos, ART por obra, conformidade ABNT, perfis de aço normatizados (0,95–1,20mm), memorial técnico.
Escreva mensagens curtas para WhatsApp (texto puro, com emojis e quebras de linha, sem markdown de asteriscos). Seja direto e 100% acionável. NUNCA invente números — use apenas os dados fornecidos; se algo estiver "indisponível", diga isso.`;

const INSTRUCOES = {
  briefing: `Monte o BRIEFING MATINAL de hoje (${hoje()}) com estas seções, cada uma curta:
☀️ BRIEFING MATINAL — LHM Engenharia (${hoje()})
📊 Seus números (7 dias): resuma Instagram, Meta Ads e Site a partir dos dados; termine com 1 frase interpretando.
📈 Oportunidade do dia: 1 ângulo acionável do mercado de Steel Frame/alto padrão + ação sugerida.
📝 Post recomendado: tema + formato (Carrossel ou Reels) + CTA premium que leva ao WhatsApp.
🔎 Insight de concorrência: 1 diferencial real da LHM.
✅ Checklist de hoje: 3 itens práticos.`,
  radar: `Monte o RADAR SEMANAL de crescimento (semana de ${hoje()}):
🛰️ RADAR SEMANAL — LHM Engenharia
🔥 Cidades quentes pra crescer: a partir das cidades dos visitantes do site e do seu conhecimento do mercado PR/litoral, aponte 2-3 cidades/regiões com potencial + ação para cada.
🎯 Onde focar esta semana: recomendação de foco geográfico e de tema para anúncios e conteúdo. Observe se o LITORAL está sub-representado vs Curitiba/RMC.
🥷 Concorrência: 1 movimento típico de concorrentes e o diferencial da LHM a destacar.
📌 A aposta da semana: a recomendação estratégica nº1.`,
  raiox: `Monte o RAIO-X DA SEMANA (até ${hoje()}):
📊 RAIO-X DA SEMANA — LHM
📈 Instagram: números + leitura.
💸 Meta Ads: números + eficiência (CPC).
🌐 Site: visitantes, sessões, top cidades, origens.
🧭 3 ações pra próxima semana baseadas nos números (escalar/pausar/ajustar). Inclua ação sobre cidades se o litoral estiver sub-representado.`,
};

async function escreverComIA(dados) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `DADOS REAIS DE HOJE:\n${dados}\n\n` +
          `${INSTRUCOES[MODE] || INSTRUCOES.briefing}\n\n` +
          `Responda APENAS com a mensagem final pronta para envio, sem comentários extras.`,
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
    console.error(`Anthropic HTTP ${r.status}: ${await r.text()}`);
    return null;
  }
  const j = await r.json();
  return j?.content?.[0]?.text?.trim() || null;
}

// ---- Template (fallback sem IA) ---------------------------------------------

function escreverTemplate(dados, { ig, ads, site }) {
  const cab = {
    briefing: `☀️ BRIEFING MATINAL — LHM Engenharia\n(${hoje()})`,
    radar: `🛰️ RADAR SEMANAL — LHM Engenharia\n(semana de ${hoje()})`,
    raiox: `📊 RAIO-X DA SEMANA — LHM\n(até ${hoje()})`,
  }[MODE];
  const partes = [cab, "", "📊 Seus números (7 dias)", dados];
  if (site && site.topCidades.length) {
    const litoral = ["Guaratuba", "Matinhos", "Pontal do Parana", "Caioba"];
    const temLitoral = site.topCidades.some((c) =>
      litoral.some((l) => c.toLowerCase().includes(l.toLowerCase().slice(0, 6)))
    );
    partes.push("");
    partes.push(
      temLitoral
        ? "🎯 Litoral aparecendo nas visitas — bom momento pra conteúdo de casa de praia em Steel Frame (resistência à maresia)."
        : "🎯 Oportunidade: o Litoral quase não aparece nas visitas. Vale uma campanha/conteúdo focado em Guaratuba, Matinhos e Pontal."
    );
  }
  partes.push("");
  partes.push("✅ Ação de hoje: escolha 1 obra entregue e poste os bastidores (engenheiro na obra, escopo fechado). CTA → WhatsApp.");
  partes.push("");
  partes.push("— LHM Intelligence 🤖");
  return partes.join("\n");
}

// ---- Envio (WhatsApp via CallMeBot ou Telegram) -----------------------------

async function enviarWhatsApp(texto) {
  const msg = texto.length > 3500 ? texto.slice(0, 3490) + "\n…" : texto;
  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}` +
    `&text=${encodeURIComponent(msg)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(40000) });
  const body = await r.text();
  if (/Message queued|Message Sent/i.test(body)) {
    console.log("WhatsApp enviado com sucesso via CallMeBot.");
  } else {
    throw new Error("CallMeBot não confirmou envio. Resposta: " + body.slice(0, 300));
  }
}

async function enviarTelegram(texto) {
  const msg = texto.length > 4000 ? texto.slice(0, 3990) + "\n…" : texto;
  const r = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg }),
      signal: AbortSignal.timeout(30000),
    }
  );
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram falhou: " + JSON.stringify(j));
  console.log("Telegram enviado com sucesso (message_id " + j.result.message_id + ").");
}

async function entregar(texto) {
  if (CHANNEL === "telegram") return enviarTelegram(texto);
  return enviarWhatsApp(texto);
}

// ---- Main -------------------------------------------------------------------

(async () => {
  console.log(`== LHM Bot — modo: ${MODE} ==`);
  const [ig, ads, site] = await Promise.all([
    coletarInstagram(),
    coletarAds(),
    coletarSite(),
  ]);
  const dados = dossie({ ig, ads, site });
  console.log("Dados coletados:\n" + dados);

  let texto = null;
  if (ANTHROPIC_API_KEY) {
    console.log("IA ligada — escrevendo com Claude…");
    texto = await escreverComIA(dados);
  }
  if (!texto) {
    console.log("Usando template (sem IA ou IA falhou).");
    texto = escreverTemplate(dados, { ig, ads, site });
  }

  await entregar(texto);
})().catch((e) => {
  console.error("ERRO FATAL:", e.message);
  process.exit(1);
});
