# 🤖 Como ligar o LHM Intelligence Bot (GitHub Actions)

Robô grátis na nuvem que roda 24/7 (mesmo com o PC desligado), puxa dados reais
(Instagram, Meta Ads, Site) e entrega no Telegram.

## Arquivos do robô (já prontos neste projeto)
- `automacao/lhm-bot.mjs` — o cérebro (busca dados + escreve + envia)
- `.github/workflows/lhm-intelligence.yml` — o agendador (horários)

## Passo 1 — Criar conta no GitHub (grátis)
1. Acesse https://github.com/signup e crie sua conta.

## Passo 2 — Criar o repositório
1. Acesse https://github.com/new
2. Nome: `lhm-intelligence`
3. Marque **Private** (privado).
4. Marque "Add a README file".
5. Clique em **Create repository**.

## Passo 3 — Subir os 2 arquivos
No repositório, clique em **Add file → Create new file** e crie cada um:

- Arquivo 1: no nome do arquivo digite exatamente `automacao/lhm-bot.mjs`
  e cole o conteúdo do arquivo local de mesmo nome. Commit.
- Arquivo 2: no nome digite exatamente `.github/workflows/lhm-intelligence.yml`
  e cole o conteúdo do arquivo local de mesmo nome. Commit.

(Ao digitar a barra `/` no nome, o GitHub cria as pastas sozinho.)

## Passo 4 — Adicionar os segredos (senhas)
No repositório: **Settings → Secrets and variables → Actions → New repository secret**.
Crie um por um (Name = exatamente como abaixo, Secret = o valor):

| Name | Secret (valor) |
|------|----------------|
| `TELEGRAM_TOKEN` | (o token do bot @Lhm_intelligence_bot) |
| `TELEGRAM_CHAT_ID` | `6489863128` |
| `WINDSOR_KEY_ADS` | `d7b23246f56a510ff87995659e5e4bc38d70` |
| `WINDSOR_KEY_GA` | `6783b75f2262b63e238be312d65cd02cef7e` |
| `ANTHROPIC_API_KEY` | (OPCIONAL — liga a IA que escreve e pesquisa) |

## Passo 5 — Testar
1. Aba **Actions** do repositório.
2. Se pedir, clique em "I understand my workflows, enable them".
3. Clique em **LHM Intelligence Bot → Run workflow → Run workflow**.
4. Em ~1 min você recebe a mensagem no Telegram. ✅

Pronto: a partir daí roda sozinho nos horários (briefing diário 08:00,
radar segunda 07:00, raio-x sexta 17:00).
