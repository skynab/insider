#!/usr/bin/env python3
"""
Build the static datasets for the Insider dip explorer.

Fetches:
  * Daily index prices from Yahoo Finance (no API key required)
  * Donald Trump's Truth Social post archive (stiles/trump-truth-social-archive,
    mirrored as JSON at ix.cnn.io, auto-updating every few minutes)

Emits into data/:
  market.json  - daily OHLC-ish closes for each tracked index
  dips.json    - detected drawdown episodes, each with scored candidate posts
  meta.json    - build provenance

Everything the web app needs is committed to the repo. No server, no database.

Usage:  python3 scripts/build_data.py [--start 2024-01-01] [--min-depth 2.0]
"""

import argparse
import html
import json
import math
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

TRUTH_ARCHIVE_URL = "https://ix.cnn.io/data/truth-social/truth_archive.json"
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={start}"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# FRED is the primary price source: official, keyless and not rate-limited.
# Yahoo is the fallback — same daily closes, but it throttles bursty clients.
INDICES = [
    {"key": "spx", "fred": "SP500", "symbol": "^GSPC", "label": "S&P 500"},
    {"key": "ndx", "fred": "NASDAQCOM", "symbol": "^IXIC", "label": "Nasdaq Composite"},
    {"key": "dji", "fred": "DJIA", "symbol": "^DJI", "label": "Dow Jones Industrial"},
]
PRIMARY = "spx"

ET = ZoneInfo("America/New_York")

# FRED's edge rejects spoofed browser user-agents (it resets the HTTP/2 stream),
# while Yahoo's chart API rejects non-browser ones. Pick per host.
UA = "insider-data-build/1.0 (+https://github.com/skynab/insider)"
UA_BROWSER = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Terms that plausibly move equity markets, weighted by how directly they do.
# Matched case-insensitively as whole words / phrases.
KEYWORDS = {
    3.0: [
        "tariff", "tariffs", "trade war", "reciprocal", "powell",
        "federal reserve", "the fed", "interest rate", "interest rates",
        "rate cut", "stock market", "wall street",
    ],
    2.0: [
        "china", "chinese", "trade deal", "trade agreement", "sanction",
        "sanctions", "semiconductor", "semiconductors", "chips", "taiwan",
        "oil", "opec", "inflation", "recession", "economy", "economic",
        "dollar", "deficit", "debt ceiling", "shutdown", "iran", "russia",
        "ukraine", "nato", "war", "strike", "strikes", "nuclear",
        "central bank", "treasury", "bond", "bonds", "crypto", "bitcoin",
    ],
    1.0: [
        "mexico", "canada", "europe", "european union", "japan", "korea",
        "india", "brazil", "border", "immigration", "deportation", "energy",
        "drill", "pharma", "pharmaceutical", "auto", "steel", "aluminum",
        "boeing", "apple", "tesla", "deal", "negotiat", "billion", "trillion",
    ],
}


def _fetch_once(url: str, agent: str) -> bytes:
    """GET a URL. Falls back to curl when Python's SSL trust store is unusable
    (common on macOS installs that never ran Install Certificates.command)."""
    req = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except (urllib.error.URLError, ssl.SSLError):
        proc = subprocess.run(
            ["curl", "-sSL", "--fail", "--max-time", "180", "-A", agent, url],
            capture_output=True,
        )
        if proc.returncode:
            raise RuntimeError(
                f"curl exit {proc.returncode}: {proc.stderr.decode().strip()}"
            )
        return proc.stdout


def fetch(url: str, attempts: int = 5, agent: str = UA) -> bytes:
    """Fetch with exponential backoff; Yahoo rate-limits bursty clients with 429."""
    for attempt in range(attempts):
        try:
            return _fetch_once(url, agent)
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            if attempt == attempts - 1:
                raise
            wait = 2 ** attempt * 3
            print(f"  fetch failed ({exc}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


# ---------------------------------------------------------------- market data


def fetch_fred(series_id: str, start: datetime):
    """Daily closes from FRED's CSV endpoint. Holidays come through as blanks."""
    url = FRED_CSV.format(series=series_id, start=start.strftime("%Y-%m-%d"))
    text = fetch(url).decode("utf-8")
    series = []
    for line in text.splitlines()[1:]:
        day, _, value = line.partition(",")
        value = value.strip()
        if not value or value == ".":
            continue
        series.append({"d": day.strip(), "c": round(float(value), 2)})
    if len(series) < 100:
        raise RuntimeError(f"FRED returned only {len(series)} rows for {series_id}")
    return series


def fetch_yahoo(symbol: str, start: datetime, end: datetime):
    """Return [{d: 'YYYY-MM-DD', c: close}, ...] of daily closes."""
    url = "{}?period1={}&period2={}&interval=1d".format(
        YAHOO_CHART.format(symbol=urllib.parse.quote(symbol)),
        int(start.timestamp()),
        int(end.timestamp()),
    )
    payload = json.loads(fetch(url, agent=UA_BROWSER))
    result = payload["chart"]["result"][0]
    stamps = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]

    series = []
    for ts, close in zip(stamps, closes):
        if close is None:
            continue
        day = datetime.fromtimestamp(ts, ET).strftime("%Y-%m-%d")
        series.append({"d": day, "c": round(float(close), 2)})
    # Yahoo occasionally repeats the live bar; keep the last value per day.
    deduped = {row["d"]: row for row in series}
    return [deduped[d] for d in sorted(deduped)]


# ------------------------------------------------------------ dip detection


def find_dips(series, min_depth_pct: float):
    """
    Identify non-overlapping peak-to-trough drawdown episodes.

    A running high is tracked; whenever price falls at least `min_depth_pct`
    below that high before reclaiming it, the stretch is recorded as an episode
    with its peak, trough and (if it happened) recovery date.
    """
    dips = []
    peak_i = 0
    trough_i = 0

    def close_episode(recovery_i):
        depth = (series[peak_i]["c"] - series[trough_i]["c"]) / series[peak_i]["c"] * 100
        if depth < min_depth_pct:
            return
        window = series[peak_i : trough_i + 1]
        worst_i, worst_pct = peak_i, 0.0
        for i in range(max(peak_i, 1), trough_i + 1):
            chg = (series[i]["c"] - series[i - 1]["c"]) / series[i - 1]["c"] * 100
            if chg < worst_pct:
                worst_pct, worst_i = chg, i
        dips.append(
            {
                "id": "dip-" + series[trough_i]["d"],
                "kind": "drawdown",
                "peak_date": series[peak_i]["d"],
                "peak_close": series[peak_i]["c"],
                "trough_date": series[trough_i]["d"],
                "trough_close": series[trough_i]["c"],
                "depth_pct": round(depth, 2),
                "trading_days": trough_i - peak_i,
                "worst_day": series[worst_i]["d"],
                "worst_day_pct": round(worst_pct, 2),
                "recovery_date": series[recovery_i]["d"] if recovery_i is not None else None,
                "recovery_days": (recovery_i - trough_i) if recovery_i is not None else None,
                "sessions": [
                    {"d": r["d"], "c": r["c"]} for r in window
                ],
            }
        )

    for i in range(1, len(series)):
        if series[i]["c"] >= series[peak_i]["c"]:
            close_episode(i)
            peak_i = trough_i = i
        elif series[i]["c"] < series[trough_i]["c"]:
            trough_i = i
    if trough_i > peak_i:
        close_episode(None)

    return rank_and_sort(dips)


def find_shocks(series, min_drop_pct: float):
    """
    Single-session shocks: one day, a big drop. These are the cases where a post
    and a move can actually be lined up, and they are often buried inside a long
    drawdown episode, so they are tracked as their own event class.
    """
    shocks = []
    for i in range(1, len(series)):
        chg = (series[i]["c"] - series[i - 1]["c"]) / series[i - 1]["c"] * 100
        if chg > -min_drop_pct:
            continue
        shocks.append(
            {
                "id": "shock-" + series[i]["d"],
                "kind": "shock",
                "peak_date": series[i - 1]["d"],
                "peak_close": series[i - 1]["c"],
                "trough_date": series[i]["d"],
                "trough_close": series[i]["c"],
                "depth_pct": round(-chg, 2),
                "trading_days": 1,
                "worst_day": series[i]["d"],
                "worst_day_pct": round(chg, 2),
                "recovery_date": None,
                "recovery_days": None,
                "sessions": [
                    {"d": series[j]["d"], "c": series[j]["c"]}
                    for j in range(i - 1, i + 1)
                ],
            }
        )
    return rank_and_sort(shocks)


def rank_and_sort(events):
    """Rank by depth (deepest = #1), then return in chronological order."""
    events.sort(key=lambda e: e["depth_pct"], reverse=True)
    for rank, event in enumerate(events, 1):
        event["rank"] = rank
    events.sort(key=lambda e: e["trough_date"])
    return events


# ------------------------------------------------------------- post handling

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean(content: str) -> str:
    text = TAG_RE.sub(" ", content or "")
    text = html.unescape(text)
    return WS_RE.sub(" ", text).strip()


def load_posts(start: datetime):
    raw = json.loads(fetch(TRUTH_ARCHIVE_URL))
    posts = []
    for item in raw:
        created = item.get("created_at")
        if not created:
            continue
        when = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if when < start:
            continue
        text = clean(item.get("content"))
        if not text or text.startswith("RT: https://"):
            continue
        posts.append(
            {
                "id": str(item.get("id")),
                "ts": when,
                "text": text,
                "url": item.get("url"),
                "likes": int(item.get("favourites_count") or 0),
            }
        )
    posts.sort(key=lambda p: p["ts"])
    return posts


def keyword_hits(text: str):
    lowered = text.lower()
    hits, score = [], 0.0
    for weight, terms in KEYWORDS.items():
        for term in terms:
            if term in lowered:
                hits.append(term)
                score += weight
    return score, hits


def shout_bonus(text: str) -> float:
    letters = [ch for ch in text if ch.isalpha()]
    if len(letters) < 20:
        return 0.0
    caps_ratio = sum(1 for ch in letters if ch.isupper()) / len(letters)
    return 1.5 if caps_ratio > 0.7 else (0.75 if caps_ratio > 0.4 else 0.0)


def trading_day_for(post_ts: datetime, session_days):
    """
    The first session a post could plausibly move: same day if posted before the
    4pm ET close, otherwise the next session. Returns a 'YYYY-MM-DD' or None.
    """
    local = post_ts.astimezone(ET)
    cutoff = local.strftime("%Y-%m-%d") if local.hour < 16 else (
        (local + timedelta(days=1)).strftime("%Y-%m-%d")
    )
    for day in session_days:
        if day >= cutoff:
            return day
    return None


def session_bounds(day: str):
    """(open, close) as ET datetimes for a 'YYYY-MM-DD' session."""
    base = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=ET)
    return base + timedelta(hours=9, minutes=30), base + timedelta(hours=16)


def score_posts_for_event(event, posts, index_by_day, session_days, limit=6):
    """
    Score posts inside an event's window.

    For a drawdown the window spans the run-up to the peak through the trough's
    close; for a single-session shock it is the tight span from the previous
    close to that session's close — the only posts that could have moved it.
    Scores decay with distance from the worst session's opening bell.
    """
    worst_open, worst_close = session_bounds(event["worst_day"])

    if event["kind"] == "shock":
        window_start = session_bounds(event["peak_date"])[1]  # previous close
        window_end = worst_close
    else:
        window_start = datetime.strptime(event["peak_date"], "%Y-%m-%d").replace(tzinfo=ET)
        window_start -= timedelta(days=2)
        window_end = session_bounds(event["trough_date"])[1]

    scored = []
    for post in posts:
        if not (window_start <= post["ts"] <= window_end):
            continue
        relevance, hits = keyword_hits(post["text"])
        if relevance <= 0:
            continue
        relevance += shout_bonus(post["text"])

        # Proximity to the worst session's open, and which side of it the post fell.
        lead_hours = (worst_open - post["ts"]).total_seconds() / 3600.0
        if lead_hours > 0:
            phase = "before"
        elif post["ts"] <= worst_close:
            phase = "during"
        else:
            phase = "after"

        proximity = math.exp(-abs(lead_hours) / 72.0)
        if phase == "after":
            # Posted after the damage was done — kept for context, ranked down.
            proximity *= 0.35

        engagement = math.log10(1 + post["likes"]) / 5.0
        score = relevance * (0.55 + 0.45 * min(engagement, 1.0)) * (0.25 + 0.75 * proximity)

        # What the index actually did on the first session the post could reach.
        session = trading_day_for(post["ts"], session_days)
        next_move = index_by_day.get(session, {}).get("chg") if session else None

        scored.append(
            {
                "id": post["id"],
                "ts": post["ts"].isoformat().replace("+00:00", "Z"),
                "text": post["text"][:900],
                "url": post["url"],
                "likes": post["likes"],
                "score": round(score, 2),
                "relevance": round(relevance, 1),
                "terms": sorted(set(hits))[:8],
                "phase": phase,
                "lead_hours": round(lead_hours, 1),
                "next_session": session,
                "next_session_pct": next_move,
            }
        )

    scored.sort(key=lambda p: p["score"], reverse=True)
    return scored[:limit], len(scored)


# --------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--min-depth", type=float, default=2.0,
                    help="minimum peak-to-trough %% decline to count as a drawdown")
    ap.add_argument("--min-shock", type=float, default=1.5,
                    help="minimum single-session %% drop to count as a shock")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = datetime.now(timezone.utc) + timedelta(days=1)

    DATA.mkdir(exist_ok=True)

    market = {}
    for spec in INDICES:
        print(f"fetching {spec['label']}…", file=sys.stderr)
        try:
            series = fetch_fred(spec["fred"], start)
            source = "FRED " + spec["fred"]
        except Exception as exc:  # noqa: BLE001 - fall back to the other source
            print(f"  FRED failed ({exc}); falling back to Yahoo", file=sys.stderr)
            series = fetch_yahoo(spec["symbol"], start, end)
            source = "Yahoo " + spec["symbol"]
        # Attach daily % change.
        for i, row in enumerate(series):
            prev = series[i - 1]["c"] if i else row["c"]
            row["chg"] = round((row["c"] - prev) / prev * 100, 2) if i else 0.0
        market[spec["key"]] = {"label": spec["label"], "source": source, "series": series}
        print(f"  {len(series)} sessions {series[0]['d']} → {series[-1]['d']}  [{source}]",
              file=sys.stderr)

    print("fetching Truth Social archive…", file=sys.stderr)
    posts = load_posts(start)
    print(f"  {len(posts)} posts since {args.start}", file=sys.stderr)

    # Events are detected per index so the app can switch indices without a rebuild.
    dips_by_index = {}
    for key, entry in market.items():
        series = entry["series"]
        index_by_day = {row["d"]: row for row in series}
        session_days = [row["d"] for row in series]

        drawdowns = find_dips(series, args.min_depth)
        shocks = find_shocks(series, args.min_shock)
        events = drawdowns + shocks
        for event in events:
            matches, considered = score_posts_for_event(
                event, posts, index_by_day, session_days
            )
            event["posts"] = matches
            event["posts_considered"] = considered

        events.sort(key=lambda e: e["trough_date"])
        dips_by_index[key] = events
        print(f"  {entry['label']}: {len(drawdowns)} drawdowns ≥{args.min_depth}%, "
              f"{len(shocks)} single-session shocks ≥{args.min_shock}%", file=sys.stderr)

    primary = market[PRIMARY]["series"]

    # A small daily posting-volume series for the context strip under the chart.
    volume = {}
    for post in posts:
        day = post["ts"].astimezone(ET).strftime("%Y-%m-%d")
        volume[day] = volume.get(day, 0) + 1

    (DATA / "market.json").write_text(json.dumps(market, separators=(",", ":")))
    (DATA / "dips.json").write_text(json.dumps(
        {
            "primary": PRIMARY,
            "min_depth_pct": args.min_depth,
            "min_shock_pct": args.min_shock,
            "indices": dips_by_index,
        },
        separators=(",", ":")))
    (DATA / "post_volume.json").write_text(json.dumps(volume, separators=(",", ":")))
    (DATA / "meta.json").write_text(json.dumps({
        "built_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "start": args.start,
        "min_depth_pct": args.min_depth,
        "dip_count": {k: len(v) for k, v in dips_by_index.items()},
        "post_count": len(posts),
        "last_session": primary[-1]["d"],
        "sources": {
            "prices": {k: v["source"] for k, v in market.items()},
            "posts": "stiles/trump-truth-social-archive via ix.cnn.io",
        },
    }, indent=2))

    for name in ("market.json", "dips.json", "post_volume.json", "meta.json"):
        size = (DATA / name).stat().st_size
        print(f"wrote data/{name}  ({size/1024:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
