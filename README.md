# insider

An interactive chart of US stock-index drawdowns since January 2024, with the
Donald Trump Truth Social posts that landed during each slide surfaced alongside.

**The pairings are temporal, not causal.** A post appears next to a dip because it
was published while the index was falling and mentions a market-relevant subject —
not because anything establishes that it moved the market. Markets move on many
things at once. The app shows its scoring inputs so you can judge each pairing.

## What it does

- Detects every **peak-to-trough drawdown** of ≥2% in the S&P 500, Nasdaq Composite
  and Dow, from 2024-01-01 to the last completed session.
- For each drawdown, scans every Truth Social post published between the prior peak
  and the trough, scores them, and keeps the top candidates.
- Renders it as a D3 line chart with shaded drawdown bands, a brush-to-zoom strip,
  a crosshair tooltip, a sortable table view, and a detail panel per dip.

### How posts are scored

Each post in a dip's window gets:

| Input | Effect |
|---|---|
| **Subject relevance** | Weighted keyword match — tariffs, the Fed, China, rates and "stock market" weigh most; trade partners and sectors weigh least. Posts matching nothing are dropped entirely. |
| **Shouting** | A small bump for mostly-caps posts, which track Trump's higher-intensity output. |
| **Proximity** | Exponential decay by distance from the drawdown's single worst session; posts *after* that session are heavily discounted. |
| **Engagement** | Log-scaled favourite count. |

Each surfaced post also shows **what the index actually did on the first session
after it was posted** — a plain, checkable number that is independent of the score.

## Running it

It is a static site. No build step, no database, no server-side code.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (It must be served over HTTP — `file://` blocks
the `fetch` calls that load `data/`.)

## Rebuilding the data

```bash
python3 scripts/build_data.py
```

Python 3.9+, standard library only. Options:

```bash
python3 scripts/build_data.py --start 2024-01-01 --min-depth 2.0
```

This writes `data/market.json`, `data/dips.json` and `data/meta.json`, all of
which are committed to the repo — that is the "database."

Sources:

- **Prices** — [FRED](https://fred.stlouisfed.org) (`SP500`, `NASDAQCOM`, `DJIA`),
  with Yahoo Finance as an automatic fallback. Both are keyless.
- **Posts** — [stiles/trump-truth-social-archive](https://github.com/stiles/trump-truth-social-archive),
  an auto-updating mirror of `@realDonaldTrump`'s Truth Social output.

## Deploying to GitHub Pages

Push to `main` and enable Pages → *Deploy from a branch* → `main` / `/ (root)`.
Everything the page needs is committed, including `vendor/d3.v7.min.js`, so there
is nothing to install.

`.github/workflows/refresh-data.yml` re-runs the build weekly and commits any
changes, so a deployed copy keeps up with new sessions and new posts.

## Layout

```
index.html            markup and controls
styles.css            tokens + layout (light/dark aware)
app.js                D3 chart, brush, table and detail panel
vendor/d3.v7.min.js   vendored, no CDN
scripts/build_data.py fetch → detect dips → score posts → write data/
data/*.json           generated, committed
```
