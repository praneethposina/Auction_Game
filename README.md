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
- **AI players.** Built-in bots, or LLMs via Groq, OpenRouter free models, Cerebras, Google Gemini
  or Hugging Face. Watch their reasoning after each sale.
- **Quick accounts.** Username and password only, no email. Save your free API keys once
  (encrypted on the server) and add LLM players to any game you host, with no server setup.

Full rules and numbers: [GAME_DESIGN.md](GAME_DESIGN.md).

## Quick start

Requires Node.js 22.13+.

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

Built-in bots need nothing. For LLM players:

1. Click **Sign in → Create account**. It's just a username and password.
2. In **Your account → AI API keys**, click **Get free key ↗** next to a provider, then paste
   the key and click **Save**. The server checks it with the provider right away.
3. As host, go to **Add AI players → LLM model**, pick a model and a personality, and add as many
   AI players as you like.

| Provider | Free tier | Suggested models |
|---|---|---|
| [Groq](https://console.groq.com/keys) (recommended) | Free, no card, very fast | GPT-OSS 120B, Llama 3.3 70B, Qwen 3.8 27B |
| [OpenRouter](https://openrouter.ai/keys) | `:free` models: 20 req/min, 50 req/day (1,000/day after a one-time $10 top-up) | Nemotron 3 Ultra, Inkling, Qwen 3.8 27B, Gemma 4 31B |
| [Cerebras](https://cloud.cerebras.ai) | Free daily token allowance | Listed live from your key |
| [Google Gemini](https://aistudio.google.com/apikey) | Free tier | Listed live from your key |
| [Hugging Face](https://huggingface.co/settings/tokens) | Small monthly credits | DeepSeek V4.1 Flash, Kimi K3, GLM 5.3 Flash |

How keys are handled:

- Keys are encrypted at rest (AES-256-GCM with `APP_SECRET`).
- They're only ever shown back masked (e.g. `gsk_…a1b2`).
- They're only used for AI players that the key's owner adds to a game.
- Other players never see them.

Each LLM is called once per company (about 20 requests per LLM player per game). If a call fails
or is rate-limited, a built-in brain bids instead and its reasoning is tagged "backup".

The server owner can also set shared keys in env vars (see `.env.example`). Every host on the
server can use those, so leave them empty on a public deployment.

## Deploy on Railway

The repo includes `railway.json`, which sets the build, start command and health check.

1. On [railway.com](https://railway.com), click **New Project → Deploy from GitHub repo** and pick
   this repository. Allow Railway's GitHub app to access it if asked.
2. If the code isn't on `main` yet, open the service's **Settings → Source** and set the branch
   to the one that has it.
3. In the project, click **+ New → Database → Add PostgreSQL**.
4. In the game service's **Variables**, add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SECRET` = a long random string. Generate one with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

     Never change it later: changing it makes saved keys unreadable.
5. Open **Settings → Networking → Generate Domain**. Your game is live at that URL.

Railway sets `PORT` itself. Rooms live in memory on a single instance, so keep replicas at 1.
Without `DATABASE_URL` the server falls back to SQLite, which needs a Railway volume mounted at
`/data` plus `DATA_DIR=/data`, or accounts are lost on each deploy.

### Other hosts

Any Node 22.13+ host with WebSockets works:

```bash
npm install
npm run build   # builds the client into dist/
npm start       # serves the game and client on $PORT (default 3001)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Game server (port 3001) + Vite client (port 5173) with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Engine, AI and account tests (set `TEST_DATABASE_URL` to also test Postgres) |
| `npm run typecheck` | TypeScript check |
| `npm run simulate -- 200 5 20 open` | Plays 200 bot-only games and prints balance stats |

## Project layout

```
shared/            Types, economy formulas, and game data (used by server and client)
  data/            200 companies, 22 sectors, 75 combos, 36 market events
server/
  game/            Engine: setup, auctions, payouts, intel, scoring, per-player views
  ai/              Bots, LLM prompt/client, provider catalog, AI director
  db/              Accounts, sessions and saved keys (Postgres or SQLite)
  app.ts           HTTP API (auth, keys) + Socket.IO game server
  security.ts      Password hashing, sessions, key encryption, rate limits
  rooms.ts         Lobby, settings, join codes, reconnection
  index.ts         Startup
client/src/        React UI (home, lobby, auction stage, panels, results)
scripts/           Balance simulator
```

The server is authoritative. Each client only ever receives its own view, so other players'
cash and turnovers never reach the browser.
