#!/usr/bin/env python3
"""
Build the static datasets for the Insider market-move explorer.

Fetches:
  * Daily index prices from Yahoo Finance (no API key required)
  * Donald Trump's Truth Social post archive (stiles/trump-truth-social-archive,
    mirrored as JSON at ix.cnn.io, auto-updating every few minutes)

Emits into data/:
  market.json  - daily OHLC-ish closes for each tracked index
  events.json  - detected market moves, each with scored candidate posts
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
# Matched case-insensitively as whole words / phrases. The list is deliberately
# direction-neutral: the same subjects (tariffs, the Fed, China) drive both
# selloffs and rallies, and the market's own move supplies the sign. The 3.0
# tier also carries explicit market-action language — "time to buy", "pause",
# "record high" — which is how upside catalysts usually read.
KEYWORDS = {
    3.0: [
        "tariff", "tariffs", "trade war", "reciprocal", "powell",
        "federal reserve", "the fed", "interest rate", "interest rates",
        "rate cut", "stock market", "wall street",
        "time to buy", "great time to buy", "buy", "djt",
        "record high", "record highs", "all-time high", "pause", "paused",
        "boom", "booming", "greatest economy", "invest", "investment",
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


# ---------------------------------------------------------- event detection


def find_swings(series, min_move_pct: float):
    """
    Segment the series into alternating up and down legs (a zigzag).

    A leg runs from one turning point to the next: it extends while price keeps
    making new extremes, and closes once price reverses by at least
    `min_move_pct` off that extreme. The reversal point becomes the next leg's
    start, so the legs tile the whole period and up and down moves are found on
    identical terms.

    A one-sided definition does not work here. Tracking drawdowns against a
    running high is standard, but its mirror — advances off a running low —
    degenerates in a rising market, where the index almost never sets a new low
    and the entire period collapses into a single enormous "rally".
    """
    legs = []
    pivot = 0      # where the current leg started
    ext = 0        # the extreme reached so far in the current leg
    direction = None

    def make_leg(a, b, way):
        move = (series[b]["c"] - series[a]["c"]) / series[a]["c"] * 100
        up = way == "up"
        key_i, key_pct = a, 0.0
        for i in range(a + 1, b + 1):
            chg = (series[i]["c"] - series[i - 1]["c"]) / series[i - 1]["c"] * 100
            if (chg > key_pct) if up else (chg < key_pct):
                key_pct, key_i = chg, i
        kind = "rally" if up else "drawdown"
        return {
            "id": f"{kind}-{series[b]['d']}",
            "kind": kind,
            "direction": way,
            "start_date": series[a]["d"],
            "start_close": series[a]["c"],
            "end_date": series[b]["d"],
            "end_close": series[b]["c"],
            "move_pct": round(abs(move), 2),
            "trading_days": b - a,
            "key_day": series[key_i]["d"],
            "key_day_pct": round(key_pct, 2),
        }

    for i in range(1, len(series)):
        c = series[i]["c"]
        ext_c = series[ext]["c"]
        if direction == "up":
            if c >= ext_c:
                ext = i
            elif (ext_c - c) / ext_c * 100 >= min_move_pct:
                legs.append(make_leg(pivot, ext, "up"))
                pivot, ext, direction = ext, i, "down"
        elif direction == "down":
            if c <= ext_c:
                ext = i
            elif (c - ext_c) / ext_c * 100 >= min_move_pct:
                legs.append(make_leg(pivot, ext, "down"))
                pivot, ext, direction = ext, i, "up"
        else:
            # Opening leg: wait for the first move that clears the threshold.
            move = (c - series[pivot]["c"]) / series[pivot]["c"] * 100
            if abs(move) >= min_move_pct:
                direction = "up" if move > 0 else "down"
                ext = i

    # The final, still-running leg.
    if direction and ext > pivot:
        legs.append(make_leg(pivot, ext, direction))

    return rank_and_sort(legs)


def find_single_sessions(series, min_move_pct: float, direction: str):
    """
    One-day moves of at least `min_move_pct`. These are where a post and a move
    can actually be lined up — the scoring window is just the previous close to
    this one — and they are often buried inside a longer episode, so they are
    tracked as their own class.
    """
    down = direction == "down"
    kind = "shock" if down else "surge"
    events = []
    for i in range(1, len(series)):
        chg = (series[i]["c"] - series[i - 1]["c"]) / series[i - 1]["c"] * 100
        if (chg > -min_move_pct) if down else (chg < min_move_pct):
            continue
        events.append(
            {
                "id": f"{kind}-{series[i]['d']}",
                "kind": kind,
                "direction": direction,
                "start_date": series[i - 1]["d"],
                "start_close": series[i - 1]["c"],
                "end_date": series[i]["d"],
                "end_close": series[i]["c"],
                "move_pct": round(abs(chg), 2),
                "trading_days": 1,
                "key_day": series[i]["d"],
                "key_day_pct": round(chg, 2),
            }
        )
    return rank_and_sort(events)


def rank_and_sort(events):
    """Rank by size (largest = #1), then return in chronological order."""
    events.sort(key=lambda e: e["move_pct"], reverse=True)
    for rank, event in enumerate(events, 1):
        event["rank"] = rank
    events.sort(key=lambda e: e["end_date"])
    return events


# ------------------------------------------------------------- post handling

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def fix_mojibake(text: str) -> str:
    """
    Repair upstream double-encoding.

    Parts of the archive carry UTF-8 bytes that were decoded as Latin-1, so
    curly quotes and em dashes arrive as "â€œ" / "â€”". Round-tripping through
    Latin-1 restores them. Guarded and reversible: text without the telltale
    markers is returned untouched, and anything that fails to round-trip (real
    Latin-1 characters, for instance) falls back to the original.
    """
    if not any(marker in text for marker in ("Ã", "Â", "â\x80", "â€")):
        return text
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def clean(content: str) -> str:
    text = TAG_RE.sub(" ", content or "")
    text = html.unescape(text)
    text = fix_mojibake(text)
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


def sigma_by_day(series, window: int = 60):
    """
    How unusual each session was, in standard deviations of the preceding
    `window` sessions' daily returns. A +9.5% day against a 2%-vol backdrop is a
    different kind of event from a +9.5% day in a market that swings that much
    weekly, and the correlation score should know the difference.
    """
    out = {}
    for i in range(1, len(series)):
        lo = max(1, i - window)
        prior = [series[j]["chg"] for j in range(lo, i)]
        if len(prior) < 10:
            continue
        mean = sum(prior) / len(prior)
        var = sum((c - mean) ** 2 for c in prior) / len(prior)
        sd = math.sqrt(var)
        if sd > 0:
            out[series[i]["d"]] = abs(series[i]["chg"]) / sd
    return out


def correlation_score(phase, lead_hours, sigma, relevance, considered):
    """
    A 0–100 heuristic for how well a post lines up with a market move — a
    filtering aid, not evidence of cause. Four components, each capped:

      Timing (0–40)      Coverage × freshness. Coverage is the share of the
                         session still ahead of the post — 1.0 before the bell,
                         falling linearly to 0 at the close — so it measures how
                         much of the move the post could actually precede.
                         Freshness decays over ~24h, so a post three days early
                         is not treated as a trigger. Posts after the close score
                         zero; they cannot have caused anything.
      Magnitude (0–25)   The session's move in standard deviations, capped at 3σ.
      Relevance (0–20)   Market-subject weight, capped.
      Isolation (0–15)   Few competing posts in the window means less dilution.

    Coverage is deliberately continuous across the opening bell. A post six
    minutes before the open and one seven minutes after are near-identical
    evidence, and an earlier version that ranked all pre-open posts above all
    same-session ones inverted exactly that pair.

    The daily-close caveat still stands: within a single session these scores
    assume the move is spread evenly across the day. They cannot establish that
    the market actually turned after the post.
    """
    if phase == "after":
        timing = 0.0
    else:
        hours_in = min(max(-lead_hours, 0.0), 6.5)  # 0 if posted before the bell
        coverage = 1.0 - hours_in / 6.5
        freshness = math.exp(-max(lead_hours, 0.0) / 24.0)
        timing = 40.0 * coverage * freshness

    magnitude = 25.0 * min((sigma or 0.0) / 3.0, 1.0)
    topic = 20.0 * min(relevance / 12.0, 1.0)
    isolation = 15.0 * math.exp(-(max(considered, 1) - 1) / 10.0)

    return {
        "total": round(timing + magnitude + topic + isolation, 1),
        "timing": round(timing, 1),
        "magnitude": round(magnitude, 1),
        "relevance": round(topic, 1),
        "isolation": round(isolation, 1),
    }


def session_bounds(day: str):
    """(open, close) as ET datetimes for a 'YYYY-MM-DD' session."""
    base = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=ET)
    return base + timedelta(hours=9, minutes=30), base + timedelta(hours=16)


def score_posts_for_event(event, posts, index_by_day, session_days, sigmas, limit=6):
    """
    Score posts inside an event's window.

    For a multi-session episode the window spans the run-up to the start through
    the end session's close; for a single-session move it is the tight span from
    the previous close to that session's close — the only posts that could have
    moved it. Scores decay with distance from the key session's opening bell.
    """
    key_open, key_close = session_bounds(event["key_day"])

    if event["trading_days"] == 1:
        window_start = session_bounds(event["start_date"])[1]  # previous close
        window_end = key_close
    else:
        window_start = datetime.strptime(event["start_date"], "%Y-%m-%d").replace(tzinfo=ET)
        window_start -= timedelta(days=2)
        window_end = session_bounds(event["end_date"])[1]

    scored = []
    for post in posts:
        if not (window_start <= post["ts"] <= window_end):
            continue
        relevance, hits = keyword_hits(post["text"])
        if relevance <= 0:
            continue
        relevance += shout_bonus(post["text"])

        # Proximity to the key session's open, and which side of it the post fell.
        lead_hours = (key_open - post["ts"]).total_seconds() / 3600.0
        if lead_hours > 0:
            phase = "before"
        elif post["ts"] <= key_close:
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

    # Correlation needs the final candidate count, so it is a second pass.
    sigma = sigmas.get(event["key_day"])
    for p in scored:
        parts = correlation_score(
            p["phase"], p["lead_hours"], sigma, p["relevance"], len(scored)
        )
        p["corr"] = parts.pop("total")
        p["corr_parts"] = parts

    scored.sort(key=lambda p: p["corr"], reverse=True)
    top = scored[:limit]
    return top, len(scored)


# --------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-01-01")
    ap.add_argument("--min-depth", type=float, default=2.0,
                    help="minimum multi-session %% move to count (either direction)")
    ap.add_argument("--min-shock", type=float, default=1.5,
                    help="minimum single-session %% move to count (either direction)")
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
    events_by_index = {}
    for key, entry in market.items():
        series = entry["series"]
        index_by_day = {row["d"]: row for row in series}
        session_days = [row["d"] for row in series]
        sigmas = sigma_by_day(series)

        # A swing leg can be a single session, which would duplicate the
        # shock/surge for that same day — and the single-session class is the
        # better record of it, since its scoring window is far tighter. Drop
        # those legs and re-rank so "#1 biggest" means what it says.
        swings = [e for e in find_swings(series, args.min_depth) if e["trading_days"] > 1]
        # Ranked within each class, so "#1" reads as "biggest decline" /
        # "biggest one-day gain" rather than a position in a mixed pile.
        groups = {
            "drawdown": rank_and_sort([e for e in swings if e["direction"] == "down"]),
            "rally": rank_and_sort([e for e in swings if e["direction"] == "up"]),
            "shock": find_single_sessions(series, args.min_shock, "down"),
            "surge": find_single_sessions(series, args.min_shock, "up"),
        }
        events = [e for group in groups.values() for e in group]
        for event in events:
            matches, considered = score_posts_for_event(
                event, posts, index_by_day, session_days, sigmas
            )
            event["posts"] = matches
            event["posts_considered"] = considered
            event["corr"] = matches[0]["corr"] if matches else 0.0
            event["sigma"] = round(sigmas.get(event["key_day"], 0.0), 2)

        events.sort(key=lambda e: e["end_date"])
        events_by_index[key] = events
        print(
            f"  {entry['label']}: "
            + ", ".join(f"{len(v)} {k}s" for k, v in groups.items()),
            file=sys.stderr,
        )

    primary = market[PRIMARY]["series"]

    events_out = {
        "primary": PRIMARY,
        "min_depth_pct": args.min_depth,
        "min_shock_pct": args.min_shock,
        "indices": events_by_index,
    }
    meta = {
        "built_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "start": args.start,
        "min_depth_pct": args.min_depth,
        "event_count": {k: len(v) for k, v in events_by_index.items()},
        "post_count": len(posts),
        "last_session": primary[-1]["d"],
        "sources": {
            "prices": {k: v["source"] for k, v in market.items()},
            "posts": "stiles/trump-truth-social-archive via ix.cnn.io",
        },
    }

    # The page loads this via a plain <script> tag rather than fetch(), so the
    # site works from file:// with no web server. The JSON files are the same
    # payload, emitted for anyone who wants to reuse the data directly.
    (DATA / "insider-data.js").write_text(
        "/* Generated by scripts/build_data.py — do not edit by hand. */\n"
        "window.INSIDER_DATA = "
        + json.dumps({"market": market, "events": events_out, "meta": meta},
                     separators=(",", ":"))
        + ";\n"
    )
    (DATA / "market.json").write_text(json.dumps(market, separators=(",", ":")))
    (DATA / "events.json").write_text(json.dumps(events_out, separators=(",", ":")))
    (DATA / "meta.json").write_text(json.dumps(meta, indent=2))

    for name in ("insider-data.js", "market.json", "events.json", "meta.json"):
        size = (DATA / name).stat().st_size
        print(f"wrote data/{name}  ({size/1024:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
