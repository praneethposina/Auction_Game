# Game design

This is the rulebook the code implements, with the numbers used by default. The engine lives in
`server/game/`, the shared formulas in `shared/economy.ts`, and all content (companies, combos,
events) in `shared/data/`.

## Setup

The host picks:

| Setting | Default | Notes |
|---|---|---|
| Companies to auction | 20 | Drawn from 200 real companies |
| Starting budget | $1,000M | Same for everyone |
| Turnover range | $20M–$200M per round | Hidden turnovers are drawn inside this range |
| Auction style | Open | Open (live ascending) or sealed bid |
| Win condition | Net worth | Net worth, return on spend, cash, or portfolio value |
| Running costs | On | |
| Market events | On | |
| Intel tips per player | 2 | 0–5 |
| Catch-up intel | On | Last place gets an extra tip each round |
| Bid timer | 10 s | 5–600 s |
| Intro before each round | 6 s | How long the round intro with the market news stays up before bidding (2–600 s) |
| Round summary | 8 s | How long the end-of-round payday screen stays up (2–600 s) |
| Sold reveal | 4 s | How long the "Sold to…" screen stays up after each lot (1–600 s) |
| Time added after each bid | 6 s | Open bidding: a bid tops the countdown back up to at least this (2–600 s) |
| AI reasoning | Live | Shown after each sale, or only at the end |

**Rounds.** One company per player per round. 5 players and 20 companies means 4 rounds.

**The pool.** Each game draws a fresh pool. The draw seeds a few named combos and clusters
companies by sector, so synergies are actually reachable instead of 20 unrelated names. Everyone
can see which companies are in the pool, but not the order they come up in.

## Hidden turnover

Every company has a visible **tier** (Mega, Large, Mid) and **sector**, and a hidden turnover:

```
turnover = min + (max − min) × X / 20,   X ~ Binomial(20, p)
p = tier base + hidden sector heat
```

| Tier | Base p | Typical range at $20–200M |
|---|---|---|
| Mega | 0.72 | $128M–$173M (avg $150M) |
| Large | 0.52 | $92M–$137M (avg $114M) |
| Mid | 0.32 | $56M–$101M (avg $78M) |

**Sector heat** is rolled once per game per sector from {−0.14, −0.07, 0, 0, 0, +0.07, +0.14}.
Nobody is told the heat, but intel can reveal it, and it's revealed at the end.

The winner of an auction learns the turnover. Everyone else only sees who bought the company and
for how much.

## Round payouts

At the end of every round (including the round of purchase), every owned company pays:

```
net = turnover × (1 + synergy) × news demand multiplier − running cost × news cost multiplier
```

- **Running cost** is public: the tier's expected turnover × the sector's cost ratio. It reflects
  real margins: software 25%, fabless chips 32%, luxury 35%, … retail 60%. A weak draw in a
  thin-margin sector can lose money every round.
- A company bought in round 1 of 4 pays 4 times; one bought in round 4 pays once. Early companies
  are worth more.

## Synergies

- **Sector bonus.** Own 2 / 3 / 4+ companies in one sector: +10% / +20% / +35% on each of them.
- **Named combos (75).** Real-world ties such as partnerships, supply chains, shared owners,
  duopolies and country blocs. Examples: Microsoft × OpenAI, Claude Coalition, Stargate, Ad
  Duopoly, Chip Supply Chain, Memory Makers, Musk Empire, Buffett's Portfolio, GLP-1 Boom, Cola
  Wars, Robotaxi Race, Nuclear-Powered AI, India Rising, French Touch. Each has one or more
  thresholds (for example "3 of 7 → +25%, 5 of 7 → +45%"). Some have an **anchor** company that
  must be one of the members you own.
- A company's total synergy is capped at +100%.

## Market events (36)

One headline is drawn per round and **announced before that round's auctions**, so players can
react. Each event has demand effects (turnover) and cost effects by sector, plus company-specific
effects, all grounded in real economics:

- **Rate hike.** Banks' margins widen; car loans and debt-heavy, capital-intensive businesses suffer.
- **Oil spike.** Producers win. Airlines and shippers pay for fuel. EV makers gain, and renewables
  lose their price edge.
- **AI capex supercycle.** Chips, fabs, power and grid gear boom, while AI labs pay steep compute bills.
- **Also:** recession, pandemic, tariffs, chip export controls, ransomware wave, GLP-1 mania, drug
  price caps, shipping crisis, wage inflation, crypto cycles, strong dollar, China stimulus, and more.

## Private intel

Tips are always true and only cover companies still to be auctioned:

| Kind | Example |
|---|---|
| Band | "Boeing turns over between $55M and $100M per round." |
| Above / below | "NVIDIA turns over more than $140M per round." |
| Compare | "RTX turns over more than Delta Air Lines." |
| Rank | "Snap is one of the 5 weakest earners in this game." |
| Sector heat | "🔥 Cloud & Software is running warm this game." |
| Next event | "Round 3's market headline will be 'Oil glut: crude crashes to $45'." |

Everyone gets `intelPerPlayer` tips at the start. With catch-up intel on, the player in last place
under the chosen win condition gets one more tip after each round. Next-event tips are favoured
for catch-up, and the tip is private.

## Auctions

- **Open.** Live ascending bids. Minimum opening bid is 1% of the budget and the minimum raise is
  0.5%. After each bid the countdown is topped back up to at least the "time added after each
  bid" setting. Players can press
  *I'm out*; once everyone but the leader is out, the lot closes in about a second. If nobody bids,
  the company is withdrawn.
- **Sealed.** Everyone submits one secret bid or passes. The lot resolves as soon as everyone has
  submitted. The highest bid wins and pays its own bid; ties go to the earliest submission. Only
  the winner and price are announced.

## Host controls

During a game the host can:
- **Skip** the intro, sale reveal or round summary.
- **Pause / Resume.** Every countdown freezes and bids are refused until the host resumes; the
  clock then carries on from where it stopped.
- **End game.** Stops immediately and shows final standings from current cash and companies. The
  round in progress does not pay out.

If the host leaves mid-game, the host role passes to another human player, preferring one who is
online.

## Information rules

- You see your own cash, turnovers, synergies and payouts.
- For other players you see only their names and which companies they own. Their cash,
  turnovers and values stay hidden until the final results.

## Winning

At the end each company is valued at `2 × max(0, net turnover per round)`.

| Win condition | Score |
|---|---|
| Net worth (default) | cash + company value |
| Return on spend | (all payouts received + company value) ÷ total spent (0 if you bought nothing) |
| Cash in purse | cash |
| Portfolio value | company value |

Ties are broken by net worth.

## AI players

- **Built-in bots** need no API key. They only use what a human in their seat would know: public
  game state, their own companies' turnovers, and their own intel. Tests check that changing a
  rival's hidden cash or turnovers never changes a bot's bid. Their "analyst":
  - **Infers hidden sector heat** with Bayes' rule. Every company a bot owns reveals its true
    turnover, which is evidence about its sector's heat (a heat tip settles it exactly). The next
    company in that sector is valued with the updated odds.
  - **Values the whole turnover distribution**, narrowed by intel, instead of one average. The end
    value is floored at zero, so this also prices in the chance of a money-loser.
  - **Looks ahead:** "next round's headline" tips, synergies a company could unlock with partners
    still to come, and combos it would complete for a rival (a spoiler value).
  - **Sets the price by win condition:** net worth uses payouts + end value; cash uses payouts
    only; return on spend demands a margin; portfolio value splits the whole budget by value share.
  - **Paces its budget** using expected future income and the number of rivals who can still
    afford to bid (estimated from public prices, never their real cash). Spending early costs
    future bargains, a cost that shrinks to zero by the final lot.
  - **Sealed bids:** shades to about (n−1)/n of value with n estimated bidders, the equilibrium
    for first-price auctions.

  14 personalities tune this analyst: Strategist, Quant, Tycoon, Value Investor, Empire Builder,
  Sector Specialist, Blue-Chip Collector, Mid-Cap Hunter, Late Sniper, Cash Hoarder, Momentum
  Trader, Contrarian, Spoiler and Gambler. `npm run simulate` plays mixed bot games. Every
  personality wins some games, and which ones do best depends on the auction style and win
  condition.
- **LLM players** run on the host's own saved API key (or a key shared by the server owner) and
  get the same private view a human has (rules, cash, portfolio, intel, news,
  opponents' holdings, relevant combos) and answer with `{"max_bid", "reason"}`.
  - Each LLM is called **once per company**, which keeps free-tier usage low.
  - In open auctions the server then raises on its behalf, in human-like steps, up to that limit.
  - If a call fails or times out, the bot brain steps in and the reasoning is tagged "backup".
- The auction waits for AI players that are still thinking, for at most 12 seconds past the timer.
- After each sale, every AI's maximum and reasoning for that lot can be shown (the "AI minds" feed).
  During the game that reasoning is **public-safe**. Bots describe only public facts (synergy with
  companies everyone can see, the news, combos in play, payouts left). LLMs are told their reason
  is read out to everyone, and a server filter holds back any LLM reason that mentions intel,
  sector heat, its cash or its own turnovers. Full reasoning is revealed on the results screen.
- **Personalities** show under each AI's name. The host can turn "Show AI personalities" off to
  keep strategies secret from other players (the host still sees them) until the game ends.
- **LLM reliability:**
  - JSON mode is used where the provider supports it, and the parser also accepts loose JSON,
    `$1.2B`-style amounts and plain-text answers.
  - A thinking model that runs out of tokens is retried with more room.
  - An unreadable answer gets a one-line "restate as JSON" follow-up.
  - Rate limits get one short retry, and at most 3 requests run at once per provider key.
  - A key that is out of credits or rejected is not called again that game; the backup brain
    plays for it and says why.

## Ideas parked for later

- One-time power cards (Right to Match, Insider Tip, Hostile Takeover, Veto, …)
- Anti-degenerate rules (minimum and maximum companies per player, purse reserve)
- Nomination mode (players choose the next company)
- Loans and selling companies back to the bank
