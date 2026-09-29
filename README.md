# 🔨 Company Auction

A fast multiplayer auction game for laptops and phones. Bid on the world's top companies (NVIDIA,
Anthropic, Google, TSMC, Visa, …), read the market, and build the most valuable empire, with
friends or against AI players powered by free, open-weight LLMs.

- **Hidden turnovers.** Each company shows its tier and sector. Its real turnover is secret, and
  only the buyer learns it.
- **Private intel.** Secret tips only you can see. Whoever is trailing gets extra tips.
- **Sector bonuses and 75 named combos.** Microsoft × OpenAI, Chip Supply Chain, Musk Empire,
  Buffett's Portfolio, India Rising, …
- **36 real-world market events.** Rate hikes, oil shocks, AI capex booms, tariffs and more. Each
  hits demand and costs sector by sector.
- **Running costs.** Thin-margin businesses can lose money.
- **Open or sealed-bid auctions** and **4 win conditions**: net worth, return on spend, cash, or
  portfolio value.
- **AI players.** Built-in bots, or LLMs via Groq, OpenRouter free models, Hugging Face, Ollama or
  any OpenAI-compatible endpoint. Watch their reasoning after each sale.

Full rules and numbers: [GAME_DESIGN.md](GAME_DESIGN.md).

## Quick start

Requires Node.js 20.19+.

```bash
npm install
npm run dev
```

Open http://localhost:5173, enter your name, click **Host a new game**, and share the room code
or invite link.

- **Friends on the same Wi-Fi:** the dev server listens on your network. Share
  `http://<your-computer's-IP>:5173/?room=CODE`.
- **Only you?** Click **Add bot** a few times and start.

## AI players (free LLMs)

Built-in bots need nothing. For LLM players, copy `.env.example` to `.env`, add at least one key,
and restart the server:

| Provider | Env var | Free tier | Suggested models |
|---|---|---|---|
| [Groq](https://console.groq.com/keys) (recommended) | `GROQ_API_KEY` | Free, no card, very fast | GPT-OSS 120B, Llama 3.3 70B, Qwen 3.8 27B |
| [OpenRouter](https://openrouter.ai/keys) | `OPENROUTER_API_KEY` | `:free` models: 20 req/min, 50 req/day (1,000/day after a one-time $10 top-up) | Nemotron 3 Ultra, Inkling, Qwen 3.8 27B, Gemma 4 31B |
| [Hugging Face](https://huggingface.co/settings/tokens) | `HF_TOKEN` | Small monthly credits | DeepSeek V4.1 Flash, Kimi K3, GLM 5.3 Flash |
| [Ollama](https://ollama.com) (local) | `OLLAMA_BASE_URL` | Unlimited, runs on your machine | Whatever you've pulled |
| Any OpenAI-compatible API | `CUSTOM_LLM_*` | — | Cerebras, Gemini, LM Studio, vLLM… |

The OpenRouter list is fetched live, so newly added `:free` models show up automatically.

In the lobby, the host picks **Add AI players → LLM model**, then a provider, model and
personality.

- **Calls per game.** Each LLM is called once per company, so a 20-company game costs about 20
  requests per LLM player. On OpenRouter's free tier without credits, that's roughly two games a
  day per LLM seat, which is why Groq is recommended.
- **Failures.** If a call fails or is rate-limited, a built-in brain bids instead and the
  reasoning is tagged "backup".

## Deploying (play over the internet)

Any Node host that supports WebSockets works (Render, Railway, Fly.io, a VPS):

```bash
npm install
npm run build   # builds the client into dist/
npm start       # serves the game and client on $PORT (default 3001)
```

Set your API keys as environment variables on the host instead of using a `.env` file.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Game server (port 3001) + Vite client (port 5173) with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Engine and AI unit tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run simulate -- 200 5 20 open` | Plays 200 bot-only games and prints balance stats |

## Project layout

```
shared/            Types, economy formulas, and game data (used by server and client)
  data/            200 companies, 22 sectors, 75 combos, 36 market events
server/
  game/            Engine: setup, auctions, payouts, intel, scoring, per-player views
  ai/              Bots, LLM prompt/client, provider catalog, AI director
  rooms.ts         Lobby, settings, join codes, reconnection
  index.ts         Express + Socket.IO server
client/src/        React UI (home, lobby, auction stage, panels, results)
scripts/           Balance simulator
```

The server is authoritative. Each client only ever receives its own view, so other players'
cash and turnovers never reach the browser.
