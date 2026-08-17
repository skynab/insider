# insider

https://skynab.github.io/insider/

An interactive chart of US stock-index moves since January 2024 — **declines and
rallies alike** — with the Donald Trump Truth Social posts that landed during each
one surfaced alongside.

**The pairings are temporal, not causal.** A post appears next to a move because it
was published while the index was moving and mentions a market-relevant subject —
not because anything establishes that it moved the market. This cuts both ways: a
post before a rally is no more proof of cause than one before a selloff. The app
shows its scoring inputs so you can judge each pairing.

## What it does

Four classes of market move are detected in the S&P 500, Nasdaq Composite and Dow,
from 2024-01-01 to the last completed session:

| Class | What it is |
|---|---|
| **Decline** | A multi-session down leg of ≥2% |
| **Rally** | A multi-session up leg of ≥2% |
| **One-day drop** | A single session of ≤−1.5% |
| **One-day jump** | A single session of ≥+1.5% |

Multi-session legs come from a **zigzag swing detector**: a leg runs from one
turning point to the next, closing once price reverses off its extreme by the
threshold. Legs therefore tile the period and up and down moves are found on
identical terms. (A one-sided definition does not work — tracking drawdowns
against a running high is standard, but its mirror degenerates in a rising
market, collapsing two and a half years into one enormous "rally".)

For each move, every Truth Social post inside its window is scored, and the top
candidates are kept. Rendered as a D3 line chart with shaded legs, direction
triangles, a brush-to-zoom strip, hover quotes, a table view, and a detail panel.

### The correlation score

Every candidate post carries a **0–100 correlation score** — the field to sort and
filter on. It answers "how well does this post line up with this move?", and its
four components are shown on every card so the number is never a black box:

| Component | Max | What it measures |
|---|---|---|
| **Timing** | 40 | Coverage × freshness. Coverage is the share of the session still ahead of the post — 1.0 before the opening bell, falling linearly to 0 at the close. Freshness decays over ~24h so a post three days early isn't treated as a trigger. Posts after the close score **zero**. |
| **Move size** | 25 | The session's move in standard deviations of the prior 60 sessions' returns, capped at 3σ. A +9.5% day against 2% vol is not the same event as +9.5% in a wild market. |
| **Relevance** | 20 | Weighted market-subject keyword match. |
| **Isolation** | 15 | How few posts competed in the window. Three candidates is far more informative than three hundred. |

Bands: **Strong ≥80** (about the top 8%), **Moderate 60–79**, **Weak <60**.

Sort by **Correlation** and drag **Min correlation** to 80, and the S&P's 71 events
collapse to 6. Top of that list, at **92**:

> THIS IS A GREAT TIME TO BUY!!! DJT — 9 April 2025, +9.52% (6.8σ)

**What the score cannot do.** It runs on daily closes, so within a single session
it assumes the move is spread evenly across the day. It cannot show that the market
actually turned *after* a post. Coverage is deliberately continuous across the
opening bell — a post six minutes before the open and one seven minutes after are
near-identical evidence — but "during the key session" always means the ordering is
assumed, not observed. Intraday prices would settle it; free history for 2024–25 at
that resolution is not available.

### How the shortlist is built

Before correlation ranks them, posts must survive relevance filtering:

| Input | Effect |
|---|---|
| **Subject relevance** | Weighted keyword match — tariffs, the Fed, China, rates, "stock market" and explicit market-action language ("time to buy", "pause", "record high") weigh most; trade partners and sectors weigh least. Posts matching nothing are dropped entirely. |
| **Shouting** | A small bump for mostly-caps posts, which track Trump's higher-intensity output. |
| **Proximity** | Exponential decay by distance from the move's single strongest session; posts *after* that session are heavily discounted. |
| **Engagement** | Log-scaled favourite count. |

The vocabulary is deliberately direction-neutral: the same subjects drive both
selloffs and rallies, and the market's own move supplies the sign. Posts matching
nothing are dropped before correlation is computed.

Each surfaced post also shows **what the index actually did on the first session
after it was posted** — a plain, checkable number, independent of every score.

## Running it

**Double-click `index.html`.** That is the whole procedure — no server, no build
step, no install.

The page makes zero network requests. D3 is vendored at `vendor/d3.v7.min.js`, and
the data is delivered by `data/insider-data.js`, a plain `<script>` tag that
assigns `window.INSIDER_DATA`. Script tags are not subject to the `file://` origin
restrictions that block `fetch()`, so opening the file straight off disk works
exactly like serving it.

If you would rather serve it, any static server works and nothing changes:

```bash
python3 -m http.server 8000
```

## Rebuilding the data

```bash
python3 scripts/build_data.py
```

Python 3.9+, standard library only. Options:

```bash
python3 scripts/build_data.py --start 2024-01-01 --min-depth 2.0 --min-shock 1.5
```

This writes:

- `data/insider-data.js` — **what the page actually loads.** The full payload
  wrapped as a global assignment so it works without a server.
- `data/market.json`, `data/events.json`, `data/meta.json` — the same data as plain
  JSON, for reuse elsewhere. The page does not read these.

All of it is committed to the repo — that is the "database." The Python script is
only a data fetcher, run occasionally to refresh; it is never needed to *view* the
site.

Sources:

- **Prices** — [FRED](https://fred.stlouisfed.org) (`SP500`, `NASDAQCOM`, `DJIA`),
  with Yahoo Finance as an automatic fallback. Both are keyless.
- **Posts** — [stiles/trump-truth-social-archive](https://github.com/stiles/trump-truth-social-archive),
  an auto-updating mirror of `@realDonaldTrump`'s Truth Social output. Parts of it
  arrive double-encoded (`â€œ` for a curly quote); the build repairs that.

## Deploying to GitHub Pages

Push to `main` and enable Pages → *Deploy from a branch* → `main` / `/ (root)`.
Everything the page needs is committed, including `vendor/d3.v7.min.js`, so there
is nothing to install.

`.github/workflows/refresh-data.yml` re-runs the build weekly and commits any
changes, so a deployed copy keeps up with new sessions and new posts.

## Layout

```
index.html              markup and controls
styles.css              tokens + layout (light/dark aware)
app.js                  D3 chart, brush, table and detail panel
vendor/d3.v7.min.js     vendored, no CDN
data/insider-data.js    generated — the data the page loads
data/*.json             generated — same data, for reuse
scripts/build_data.py   fetch → detect moves → score posts → write data/
```
