// =============================================================================
//  LHM Intelligence Bot — robô autônomo (GitHub Actions → WhatsApp)
// -----------------------------------------------------------------------------
//  Roda na nuvem do GitHub (internet liberada), puxa dados REAIS de marketing
//  (Instagram, Google Ads e Google Analytics do site) e entrega um relatório
//  no WhatsApp do dono via CallMeBot. Funciona mesmo com o PC desligado.
//
//  Modos (variável de ambiente MODE):
//    briefing  → relatório matinal diário
//    radar     → cidades quentes & concorrência (semanal)
//    raiox     → raio-x de performance (semanal)
//
//  Segredos lidos do ambiente (GitHub Secrets):
//    WINDSOR_KEY_ADS    chave Windsor com Instagram + Google Ads
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

// Data de hoje em formato AAAA-MM-DD no fuso de Brasília (pra comparar com as datas dos dados).
const hojeISO = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

// Quantos dias atrás foi a data informada (string AAAA-MM-DD). null se inválida.
function diasDesde(dataISO) {
  if (!dataISO) return null;
  const a = new Date(hojeISO() + "T00:00:00Z").getTime();
  const b = new Date(String(dataISO).slice(0, 10) + "T00:00:00Z").getTime();
  if (Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

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
  const datas = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    username: rows[0]?.username || "lhmengenharia",
    followers,
    reach: soma("reach"),
    views: soma("views"),
    interacoes: soma("total_interactions"),
    melhorDia: melhorDia?.date || "—",
    ultimaData: datas[datas.length - 1] || null,
  };
}

// Nomes amigáveis por plataforma de anúncio (datasource do Windsor).
const NOMES_ADS = {
  google_ads: "Google Ads",
  facebook: "Meta Ads (Facebook/Instagram)",
  facebook_ads: "Meta Ads (Facebook/Instagram)",
  instagram: "Meta Ads (Instagram)",
  tiktok: "TikTok Ads",
  bing: "Microsoft Ads",
  linkedin: "LinkedIn Ads",
};

async function coletarAds() {
  if (!WINDSOR_KEY_ADS) return null;
  // O endpoint /all traz TODAS as plataformas de anúncio conectadas nessa conta
  // Windsor. Hoje só Google Ads; quando o Meta for conectado, aparece sozinho.
  const url =
    `https://connectors.windsor.ai/all?api_key=${WINDSOR_KEY_ADS}` +
    `&date_preset=last_7d&fields=date,datasource,account_name,source,campaign,clicks,spend`;
  const rows = await getJSON(url, "ads");
  if (!rows || !rows.length) return null;
  // Fontes ORGÂNICAS que o endpoint /all às vezes devolve junto NÃO são mídia
  // paga e não podem entrar no total de anúncios (o Search Console aparecia como
  // "anúncio" de R$ 0,00, inflando os cliques). Filtramos por datasource.
  const ORGANICO = new Set([
    "searchconsole", "instagram", "instagram_public", "facebook_organic",
    "google_my_business", "youtube", "linkedin_organic",
  ]);
  // só linhas de anúncio PAGO: datasource não-orgânico e com gasto ou cliques.
  const base = rows.filter(
    (r) =>
      !ORGANICO.has(String(r.datasource || "").toLowerCase()) &&
      (num(r.spend) > 0 || num(r.clicks) > 0)
  );
  if (!base.length) return null;

  const porPlat = {};
  for (const r of base) {
    const ds = r.datasource || "ads";
    if (!porPlat[ds]) porPlat[ds] = { spend: 0, clicks: 0, camp: {} };
    porPlat[ds].spend += num(r.spend);
    porPlat[ds].clicks += num(r.clicks);
    const c = r.campaign || "—";
    porPlat[ds].camp[c] = (porPlat[ds].camp[c] || 0) + num(r.clicks);
  }

  const plataformas = Object.entries(porPlat).map(([ds, v]) => ({
    nome: NOMES_ADS[ds] || ds,
    spend: v.spend,
    clicks: v.clicks,
    cpc: v.clicks ? v.spend / v.clicks : 0,
    topCampanha: Object.entries(v.camp).sort((a, b) => b[1] - a[1])[0]?.[0] || "—",
  }));
  const totalSpend = plataformas.reduce((t, p) => t + p.spend, 0);
  const totalClicks = plataformas.reduce((t, p) => t + p.clicks, 0);
  // Frescor e cobertura: só contam dias que de fato tiveram gasto/cliques.
  const datasComGasto = base
    .filter((r) => num(r.spend) > 0 || num(r.clicks) > 0)
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  const ultimaData = datasComGasto[datasComGasto.length - 1] || null;
  const diasComDados = new Set(datasComGasto).size;
  return { plataformas, totalSpend, totalClicks, ultimaData, diasComDados };
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
  const datas = rows.map((r) => r.date).filter(Boolean).sort();
  return { totalusers, newusers, sessions, topCidades, topFonte, ultimaData: datas[datas.length - 1] || null };
}

// ---- Search Console: palavras-chave reais (SEO) -----------------------------
// ATENÇÃO: o Search Console está conectado na MESMA key dos anúncios (d7b2),
// NÃO na key do Google Analytics (6783). Por isso usa WINDSOR_KEY_ADS.

async function coletarSEO() {
  if (!WINDSOR_KEY_ADS) return null;
  const url =
    `https://connectors.windsor.ai/searchconsole?api_key=${WINDSOR_KEY_ADS}` +
    `&date_preset=last_28d&fields=date,query,page,clicks,impressions,ctr,position`;
  const rows = await getJSON(url, "searchconsole");
  if (!rows || !rows.length) return null;
  const m = {};
  for (const r of rows) {
    const q = (r.query || "(sem termo)").trim();
    if (!m[q]) m[q] = { cl: 0, im: 0, pos: [] };
    m[q].cl += num(r.clicks);
    m[q].im += num(r.impressions);
    if (num(r.position)) m[q].pos.push(num(r.position));
  }
  const termos = Object.entries(m).map(([q, v]) => ({
    q,
    clicks: v.cl,
    impr: v.im,
    ctr: v.im ? (v.cl / v.im) * 100 : 0,
    pos: v.pos.length ? v.pos.reduce((a, b) => a + b, 0) / v.pos.length : null,
  }));
  const top = termos.slice().sort((a, b) => b.impr - a.impr).slice(0, 12);
  // Oportunidade = gente buscando (impressões) mas você mal aparece (posição > 10).
  const oportunidades = termos
    .filter((t) => t.impr >= 5 && t.pos != null && t.pos > 10)
    .sort((a, b) => b.impr - a.impr)
    .slice(0, 6);
  return {
    top,
    oportunidades,
    totalClicks: termos.reduce((t, x) => t + x.clicks, 0),
    totalImpr: termos.reduce((t, x) => t + x.impr, 0),
  };
}

function dossieSEO(seo) {
  if (!seo) return "Search Console: dados indisponíveis (verifique a conexão no Windsor).";
  const l = [];
  l.push(`Search Console (28 dias): ${seo.totalImpr} impressões e ${seo.totalClicks} cliques no site.`);
  l.push("Termos que mais aparecem (termo | impressões | cliques | CTR | posição média):");
  for (const t of seo.top)
    l.push(`- "${t.q}": ${t.impr} | ${t.clicks} | ${t.ctr.toFixed(1)}% | pos ${t.pos != null ? t.pos.toFixed(1) : "—"}`);
  if (seo.oportunidades.length) {
    l.push("OPORTUNIDADES (gente buscando e você mal aparece — posição pior que 10):");
    for (const t of seo.oportunidades)
      l.push(`- "${t.q}": ${t.impr} impressões na posição ${t.pos.toFixed(1)}`);
  }
  return l.join("\n");
}

// ---- Camada "Diretor": controle de qualidade ANTES de enviar ----------------
// Não confia nos dados de olhos fechados: confere frescor (dado velho?) e
// cobertura (semana incompleta?) e levanta avisos honestos. É o que impede
// o robô de mandar um número parcial/desatualizado como se fosse a verdade.

function controleQualidade({ ig, ads, site }) {
  const avisos = [];

  if (!ads) {
    avisos.push("Anúncios: sem dados no período — NÃO afirmar desempenho de mídia paga.");
  } else {
    const d = diasDesde(ads.ultimaData);
    if (d != null && d >= 2) {
      avisos.push(
        `Anúncios: o dado mais recente é de ${ads.ultimaData} (${d} dias atrás). ` +
          `O conector pode estar atrasado OU a campanha pode estar pausada — os números NÃO refletem os últimos dias. Conferir no Google Ads.`
      );
    }
    if (ads.diasComDados != null && ads.diasComDados < 5) {
      avisos.push(
        `Anúncios: apenas ${ads.diasComDados} dos últimos 7 dias têm gasto registrado. ` +
          `O total é de uma semana INCOMPLETA — não comparar como se fosse 7 dias cheios.`
      );
    }
  }

  if (ig) {
    const d = diasDesde(ig.ultimaData);
    if (d != null && d >= 2)
      avisos.push(`Instagram: dado mais recente de ${ig.ultimaData} (${d} dias atrás); pode estar desatualizado.`);
  }

  if (site) {
    const d = diasDesde(site.ultimaData);
    if (d != null && d >= 2)
      avisos.push(`Site: dado mais recente de ${site.ultimaData} (${d} dias atrás); pode estar desatualizado.`);
  }

  return avisos;
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
  if (ads && ads.plataformas.length) {
    for (const p of ads.plataformas) {
      linhas.push(
        `${p.nome} (7d): investido ${brl(p.spend)}, ${p.clicks} cliques, ` +
          `CPC ${brl(p.cpc)}. Campanha destaque: ${p.topCampanha}.`
      );
    }
    if (ads.plataformas.length > 1) {
      linhas.push(
        `Total em anúncios (7d): ${brl(ads.totalSpend)} investidos, ${ads.totalClicks} cliques.`
      );
    }
  } else linhas.push("Anúncios: dados indisponíveis (nenhuma campanha ativa).");
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
Escreva mensagens curtas para Telegram (texto puro, com emojis e quebras de linha, sem markdown de asteriscos). Seja direto e 100% acionável. NUNCA invente números — use apenas os dados fornecidos; se algo estiver "indisponível", diga isso.`;

const INSTRUCOES = {
  briefing: `Monte o BRIEFING MATINAL de hoje (${hoje()}) com estas seções, cada uma curta:
☀️ BRIEFING MATINAL — LHM Engenharia (${hoje()})
📊 Seus números (7 dias): resuma Instagram, anúncios (Google Ads e Meta Ads, se houver) e Site a partir dos dados; termine com 1 frase interpretando.
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
💸 Anúncios (Google Ads e Meta Ads, se houver): números por plataforma + eficiência (CPC).
🌐 Site: visitantes, sessões, top cidades, origens.
🧭 3 ações pra próxima semana baseadas nos números (escalar/pausar/ajustar). Inclua ação sobre cidades se o litoral estiver sub-representado.`,
  seo: `Monte o RAIO-X DE PALAVRAS-CHAVE (Search Console, até ${hoje()}). Objetivo: preparar a PRÓXIMA campanha sabendo o que já funciona.
🔑 RAIO-X DE PALAVRAS — LHM (SEO)
📊 Resumo: total de impressões e cliques no site no período.
🏆 Onde você já ganha: 2-3 termos com boa posição (top 5) — reforce com conteúdo.
🎯 Oportunidades de ouro: termos com MUITA impressão e posição RUIM (página 2-3) — são clientes te procurando sem te achar. Priorize os de intenção local/compra (ex.: "casas steel frame curitiba"). Para cada um, diga o que fazer (página/conteúdo otimizado e/ou comprar a palavra na campanha paga).
🏖️ Litoral: avalie se aparece algum termo de Guaratuba/Matinhos/Caiobá; se não, registre que o Litoral está invisível no orgânico.
🧭 3 palavras que a PRÓXIMA campanha deveria comprar, com base no que já tem intenção e você ainda não domina.`,
  chefe: `Você é o DIRETOR DE INTELIGÊNCIA da LHM — o chefe acima de todos os agentes. Recebeu os dados da semana inteira (Instagram, anúncios, site e palavras-chave do Google). Sua missão NÃO é repetir relatório: é CONSOLIDAR tudo em UMA mensagem estratégica curta e dar DIREÇÃO.
🎩 DIREÇÃO DA SEMANA — LHM (${hoje()})
📍 Onde você está: 2-3 linhas honestas sobre a situação real (o que está bom, o que está parado ou preocupa). Use os números reais; respeite os avisos de qualidade (NÃO trate dado velho/parcial como atual; NÃO invente).
🎯 As 3 prioridades da semana: as 3 ações de MAIOR impacto pra LHM agora, EM ORDEM. Concretas e possíveis — lembre que NÃO há verba de anúncio no momento, então priorize o que é grátis/orgânico e preparação. Para cada uma, 1 linha de porquê.
⚠️ O alerta: a coisa mais importante que o dono não pode ignorar esta semana.
Seja direto, premium, sem enrolação. É a ÚNICA mensagem que o dono vai ler pra saber o que priorizar na semana.`,
};

async function escreverComIA(dados) {
  // Pesquisa na web ao vivo nos modos que dependem de mercado/tendências.
  const usarWeb = MODE === "radar" || MODE === "briefing" || MODE === "seo" || MODE === "chefe";
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 1600,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `DADOS REAIS DE HOJE:\n${dados}\n\n` +
          `${INSTRUCOES[MODE] || INSTRUCOES.briefing}\n\n` +
          (usarWeb
            ? `Use a ferramenta de busca na web para trazer informações ATUAIS antes de escrever: ` +
              `tendências de Steel Frame/alto padrão, o que concorrentes de Curitiba e litoral do PR estão comunicando, ` +
              `e sinais de demanda por região. Priorize fontes recentes do Brasil/Paraná. `
            : "") +
          `Responda APENAS com a mensagem final pronta para envio (texto puro, sem citações no formato [1], sem comentários extras).`,
      },
    ],
  };
  if (usarWeb) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    console.error(`Anthropic HTTP ${r.status}: ${await r.text()}`);
    return null;
  }
  const j = await r.json();
  // Com busca na web, a resposta vem em vários blocos; junta só os de texto.
  const texto = (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return texto || null;
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
  const limite = 3900; // limite seguro do Telegram (máx 4096)
  const partes = [];
  for (let i = 0; i < texto.length; i += limite) partes.push(texto.slice(i, i + limite));
  for (const parte of partes) {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: parte }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const j = await r.json();
    if (!j.ok) throw new Error("Telegram falhou: " + JSON.stringify(j));
  }
  console.log(`Telegram enviado com sucesso (${partes.length} parte(s)).`);
}

async function entregar(texto) {
  if (CHANNEL === "telegram") return enviarTelegram(texto);
  return enviarWhatsApp(texto);
}

// ---- Main -------------------------------------------------------------------

(async () => {
  console.log(`== LHM Bot — modo: ${MODE} ==`);

  // Modo SEO: raio-x de palavras-chave do Search Console (prepara a próxima campanha).
  if (MODE === "seo") {
    const seo = await coletarSEO();
    const dados = dossieSEO(seo);
    console.log("Dados SEO:\n" + dados);
    let texto = null;
    if (ANTHROPIC_API_KEY) {
      console.log("IA ligada — analisando palavras com Claude…");
      texto = await escreverComIA(dados);
    }
    if (!texto) {
      console.log("Usando template SEO (sem IA ou IA falhou).");
      texto = `🔑 RAIO-X DE PALAVRAS — LHM (SEO)\n(${hoje()})\n\n${dados}\n\n— LHM Intelligence 🤖`;
    }
    await entregar(texto);
    return;
  }

  // Modo CHEFE: o Diretor consolida a semana inteira em UMA direção estratégica.
  if (MODE === "chefe") {
    const [ig, ads, site, seo] = await Promise.all([
      coletarInstagram(),
      coletarAds(),
      coletarSite(),
      coletarSEO(),
    ]);
    const avisos = controleQualidade({ ig, ads, site });
    const base = dossie({ ig, ads, site });
    const seoTxt = dossieSEO(seo);
    let dados = base + "\n\n" + seoTxt;
    if (avisos.length)
      dados +=
        "\n\nCONTROLE DE QUALIDADE (avisos do Diretor — respeite, não trate dado velho como atual, não invente):\n- " +
        avisos.join("\n- ");
    console.log("Dados (chefe):\n" + dados);

    let texto = null;
    if (ANTHROPIC_API_KEY) {
      console.log("IA ligada — Diretor consolidando a semana…");
      texto = await escreverComIA(dados);
    }
    if (!texto) {
      console.log("Usando template chefe (sem IA ou IA falhou).");
      texto = `🎩 DIREÇÃO DA SEMANA — LHM\n(${hoje()})\n\n${base}\n\n${seoTxt}\n\n— LHM Intelligence 🤖`;
    }
    if (avisos.length)
      texto += "\n\n🛡️ CONFERIDO PELO DIRETOR:\n" + avisos.map((a) => "• " + a).join("\n");
    await entregar(texto);
    return;
  }

  const [ig, ads, site] = await Promise.all([
    coletarInstagram(),
    coletarAds(),
    coletarSite(),
  ]);
  const dados = dossie({ ig, ads, site });
  console.log("Dados coletados:\n" + dados);

  // Diretor confere ANTES de escrever.
  const avisos = controleQualidade({ ig, ads, site });
  if (avisos.length) console.log("⚠️ Avisos do Diretor:\n- " + avisos.join("\n- "));

  // A IA recebe os avisos junto com os dados e é obrigada a respeitá-los.
  const dadosParaIA = avisos.length
    ? dados +
      "\n\nCONTROLE DE QUALIDADE (avisos do Diretor — INCORPORE com honestidade, " +
      "NÃO esconda e NÃO apresente dado velho/parcial como se fosse atual):\n- " +
      avisos.join("\n- ")
    : dados;

  let texto = null;
  if (ANTHROPIC_API_KEY) {
    console.log("IA ligada — escrevendo com Claude…");
    texto = await escreverComIA(dadosParaIA);
  }
  if (!texto) {
    console.log("Usando template (sem IA ou IA falhou).");
    texto = escreverTemplate(dados, { ig, ads, site });
  }

  // Selo final do Diretor: garante que os avisos cheguem ao dono, mesmo que a
  // IA os tenha resumido demais ou o template não os tenha incluído.
  if (avisos.length) {
    texto +=
      "\n\n🛡️ CONFERIDO PELO DIRETOR — atenção:\n" +
      avisos.map((a) => "• " + a).join("\n");
  }

  await entregar(texto);
})().catch((e) => {
  console.error("ERRO FATAL:", e.message);
  process.exit(1);
});
