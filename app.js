/* Insider — interactive market-move explorer.
   Data is supplied by data/insider-data.js as a plain global, and D3 is
   vendored locally, so the page makes no network requests at all. It runs
   identically from GitHub Pages, from any static server, or by opening
   index.html straight off disk. */

(function () {
  "use strict";

  const state = {
    market: null,
    dipsByIndex: null,
    meta: null,
    indexKey: "spx",
    minDepth: 2,
    direction: "all", // all | down | up
    span: "all",      // all | multi | single
    selectedId: null,
    domain: null, // [Date, Date] current zoom, null = full
  };

  // Assigned in boot(), once D3 is confirmed present — declaring them here
  // would throw before the missing-D3 check could report anything useful.
  let parseDay, fmtDay, fmtShortDay, fmtNum, fmtPct, tooltip;

  // ------------------------------------------------------------ data load

  function fail(heading, err) {
    console.error(err);
    document.querySelector("#focus-chart").innerHTML =
      `<div class="load-error"><strong>${heading}</strong><p>${
        String(err && err.message ? err.message : err)
      }</p></div>`;
  }

  /* Data arrives as a plain <script> tag (data/insider-data.js) that assigns
     window.INSIDER_DATA, rather than via fetch(). Script tags are not subject
     to the file:// origin restrictions that block fetch, so the page works
     when opened directly from disk — no web server required. */
  function boot() {
    const data = window.INSIDER_DATA;
    if (!data) {
      fail(
        "Data file missing.",
        new Error(
          'data/insider-data.js did not load, so window.INSIDER_DATA is undefined. ' +
            "Check that the file exists next to index.html — if not, generate it " +
            'with "python3 scripts/build_data.py".'
        )
      );
      return;
    }
    if (typeof d3 === "undefined") {
      fail(
        "D3 failed to load.",
        new Error("vendor/d3.v7.min.js did not load. Check that the file is present.")
      );
      return;
    }

    parseDay = d3.timeParse("%Y-%m-%d");
    fmtDay = d3.timeFormat("%b %-d, %Y");
    fmtShortDay = d3.timeFormat("%b %-d");
    fmtNum = d3.format(",.0f");
    fmtPct = d3.format("+.2f");
    tooltip = d3.select("body").append("div").attr("class", "tooltip");

    state.market = data.market;
    state.dipsByIndex = data.events.indices;
    state.meta = data.meta;
    state.indexKey = data.events.primary || "spx";

    try {
      init();
    } catch (err) {
      fail("Data loaded, but rendering failed.", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // ------------------------------------------------------------- helpers

  function series() {
    return state.market[state.indexKey].series;
  }

  /** Events for the active index, filtered by size, direction and span. */
  function activeDips() {
    return state.dipsByIndex[state.indexKey].filter(
      (d) =>
        d.move_pct >= state.minDepth &&
        (state.direction === "all" || d.direction === state.direction) &&
        (state.span === "all" || spanOf(d) === state.span)
    );
  }

  function spanOf(d) {
    return d.trading_days === 1 ? "single" : "multi";
  }

  /** Only multi-session legs get a shaded band. */
  function legs() {
    return activeDips().filter((d) => spanOf(d) === "multi");
  }

  const isUp = (d) => d.direction === "up";

  /** Signed percentage string, e.g. "+9.52%" / "−5.97%". */
  function signed(pct, digits) {
    const n = Math.abs(pct).toFixed(digits === undefined ? 2 : digits);
    return (pct < 0 ? "−" : "+") + n + "%";
  }

  /** A move's signed size, from its absolute magnitude plus direction. */
  function movePct(d) {
    return isUp(d) ? d.move_pct : -d.move_pct;
  }

  const KIND_LABEL = {
    drawdown: "Decline",
    rally: "Rally",
    shock: "One-day drop",
    surge: "One-day jump",
  };

  function selectedDip() {
    return activeDips().find((d) => d.id === state.selectedId) || null;
  }

  function showTip(html, event) {
    tooltip.html(html).classed("is-visible", true);
    const node = tooltip.node();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = event.clientX + 14;
    let y = event.clientY - h - 12;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - 14;
    if (y < 8) y = event.clientY + 18;
    tooltip.style("left", x + "px").style("top", y + "px");
  }

  function hideTip() {
    tooltip.classed("is-visible", false);
  }

  // ---------------------------------------------------------------- init

  function init() {
    const sel = d3.select("#index-select");
    sel
      .selectAll("option")
      .data(Object.keys(state.market))
      .join("option")
      .attr("value", (k) => k)
      .property("selected", (k) => k === state.indexKey)
      .text((k) => state.market[k].label);

    sel.on("change", function () {
      state.indexKey = this.value;
      state.selectedId = null;
      state.domain = null;
      renderAll();
    });

    d3.select("#depth-range").on("input", function () {
      state.minDepth = +this.value;
      d3.select("#depth-out").text(d3.format(".1f")(state.minDepth) + "%");
      if (selectedDip() === null) state.selectedId = null;
      renderAll();
    });

    d3.select("#reset-zoom").on("click", () => {
      state.domain = null;
      renderAll();
    });

    d3.selectAll("#dir-toggle button").on("click", function () {
      state.direction = this.dataset.dir;
      d3.selectAll("#dir-toggle button").classed("is-active", false);
      d3.select(this).classed("is-active", true);
      if (!selectedDip()) state.selectedId = null;
      renderAll();
    });

    d3.selectAll("#span-toggle button").on("click", function () {
      state.span = this.dataset.span;
      d3.selectAll("#span-toggle button").classed("is-active", false);
      d3.select(this).classed("is-active", true);
      if (!selectedDip()) state.selectedId = null;
      renderAll();
    });

    d3.selectAll("#view-toggle button").on("click", function () {
      const view = this.dataset.view;
      d3.selectAll("#view-toggle button").classed("is-active", false);
      d3.select(this).classed("is-active", true);
      d3.select("#chart-view").attr("hidden", view === "chart" ? null : true);
      d3.select("#table-view").attr("hidden", view === "table" ? null : true);
    });

    window.addEventListener("resize", debounce(renderAll, 160));

    renderHeadStats();
    d3.select("#build-stamp").text(
      "Data built " +
        new Date(state.meta.built_at).toLocaleString() +
        " · " +
        state.meta.post_count.toLocaleString() +
        " posts scanned · last session " +
        state.meta.last_session
    );

    renderAll();
  }

  function renderHeadStats() {
    const all = state.dipsByIndex[state.indexKey];
    const worstDay = d3.min(all, (d) => d.key_day_pct);
    const bestDay = d3.max(all, (d) => d.key_day_pct);
    const stats = [
      { k: "Moves tracked", v: all.length },
      { k: "Worst session", v: signed(worstDay, 1), cls: "neg" },
      { k: "Best session", v: signed(bestDay, 1), cls: "pos" },
      { k: "Posts scanned", v: state.meta.post_count.toLocaleString() },
    ];
    const sel = d3
      .select("#head-stats")
      .selectAll("div")
      .data(stats)
      .join("div");
    sel.selectAll("dt").data((d) => [d]).join("dt").text((d) => d.k);
    sel
      .selectAll("dd")
      .data((d) => [d])
      .join("dd")
      .attr("class", (d) => d.cls || null)
      .text((d) => d.v);
  }

  function renderAll() {
    d3.select("#fig-title").text(state.market[state.indexKey].label + " daily close");
    renderHeadStats();
    drawFocus();
    drawContext();
    renderDipList();
    renderTable();
    renderDetail();
  }

  // -------------------------------------------------------- focus chart

  function drawFocus() {
    const host = d3.select("#focus-chart");
    host.selectAll("*").remove();

    const data = series().map((r) => ({ date: parseDay(r.d), close: r.c, chg: r.chg }));
    const width = host.node().clientWidth || 900;
    const height = 380;
    const margin = { top: 12, right: 18, bottom: 26, left: 56 };
    const iw = width - margin.left - margin.right;
    const ih = height - margin.top - margin.bottom;

    const domain = state.domain || d3.extent(data, (d) => d.date);
    const inView = data.filter((d) => d.date >= domain[0] && d.date <= domain[1]);
    const view = inView.length > 1 ? inView : data;

    const x = d3.scaleUtc().domain(domain).range([0, iw]);
    const y = d3
      .scaleLinear()
      .domain(d3.extent(view, (d) => d.close))
      .nice()
      .range([ih, 0]);

    const svg = host
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("role", "img")
      .attr("aria-label", state.market[state.indexKey].label + " daily closing level with drawdown episodes highlighted");

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Everything data-bound is clipped to the plot area so a zoomed-in band or
    // marker never bleeds over the axes.
    svg
      .append("clipPath")
      .attr("id", "focus-clip")
      .append("rect")
      .attr("x", -1)
      .attr("y", -12)
      .attr("width", iw + 2)
      .attr("height", ih + 24);

    g.append("g")
      .attr("class", "grid")
      .call(d3.axisLeft(y).ticks(6).tickSize(-iw).tickFormat(""));

    const plot = g.append("g").attr("clip-path", "url(#focus-clip)");

    // Multi-session legs, drawn as bands under the line.
    const dips = activeDips();
    plot
      .append("g")
      .selectAll("rect")
      .data(legs())
      .join("rect")
      .attr("class", (d) => "dip-band band-" + d.direction)
      .attr("x", (d) => x(parseDay(d.start_date)))
      .attr("width", (d) => Math.max(1.5, x(parseDay(d.end_date)) - x(parseDay(d.start_date))))
      .attr("y", 0)
      .attr("height", ih)
      .on("mousemove", (event, d) => showTip(dipTip(d), event))
      .on("mouseleave", hideTip)
      .on("click", (event, d) => selectDip(d.id));

    const line = d3
      .line()
      .defined((d) => d.close != null)
      .x((d) => x(d.date))
      .y((d) => y(d.close));

    plot.append("path").datum(data).attr("class", "index-line").attr("d", line);

    // Crosshair capture area. This must sit BELOW the markers in document order
    // or it swallows their hover; the crosshair marks themselves are added after
    // and are pointer-transparent.
    const bisect = d3.bisector((d) => d.date).center;
    const capture = plot
      .append("rect")
      .attr("width", iw)
      .attr("height", ih)
      .attr("fill", "transparent");

    const cross = plot
      .append("line")
      .attr("class", "crosshair")
      .attr("y1", 0)
      .attr("y2", ih)
      .style("opacity", 0);
    const dot = plot
      .append("circle")
      .attr("class", "hover-dot")
      .attr("r", 4.5)
      .style("opacity", 0);

    capture
      .on("mousemove", function (event) {
        const mx = d3.pointer(event, this)[0];
        const d = data[bisect(data, x.invert(mx))];
        if (!d) return;
        cross.attr("x1", x(d.date)).attr("x2", x(d.date)).style("opacity", 1);
        dot.attr("cx", x(d.date)).attr("cy", y(d.close)).style("opacity", 1);
        const sign = d.chg >= 0 ? "pos" : "neg";
        showTip(
          `<div class="tt-date">${fmtDay(d.date)}</div>
           <div class="tt-value">${fmtNum(d.close)}</div>
           <div class="move ${sign}">${fmtPct(d.chg)}%</div>`,
          event
        );
      })
      .on("mouseleave", () => {
        cross.style("opacity", 0);
        dot.style("opacity", 0);
        hideTip();
      });

    // Event markers. Shape carries direction — triangles point up for rallies
    // and down for declines — so the up/down distinction never rests on color
    // alone (red/green is exactly the pair colorblind readers lose).
    // Added last so their hover wins over the crosshair capture area.
    const symbol = d3.symbol().type(d3.symbolTriangle);
    const markers = plot
      .append("g")
      .selectAll("g")
      .data(dips)
      .join("g")
      .attr("transform", (d) => `translate(${x(parseDay(d.end_date))},${y(d.end_close)})`)
      .on("mousemove", (event, d) => showTip(dipTip(d), event))
      .on("mouseleave", hideTip)
      .on("click", (event, d) => {
        event.stopPropagation();
        selectDip(d.id);
      });

    // Invisible hit target, always comfortably larger than the mark itself.
    markers
      .append("circle")
      .attr("class", "marker-hit")
      .attr("r", (d) => Math.max(13, markerRadius(d.move_pct) + 7));

    markers
      .append("path")
      .attr("class", (d) =>
        "trough-dot marker-" + d.direction +
        (spanOf(d) === "single" ? " marker-single" : "") +
        (d.id === state.selectedId ? " is-selected" : "")
      )
      // Triangles are drawn pointing up; flip them for declines.
      .attr("transform", (d) => (isUp(d) ? null : "rotate(180)"))
      .attr("d", (d) => symbol.size(markerArea(d.move_pct))());

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(iw / 110))));

    g.append("g")
      .attr("class", "axis")
      .call(d3.axisLeft(y).ticks(6).tickFormat(d3.format(",")));
  }

  /** Marker radius in px, scaled so a 2% and a 19% dip both stay legible. */
  function markerRadius(depth) {
    return Math.max(4.5, Math.min(11, 3 + depth * 0.7));
  }

  function markerArea(depth) {
    const r = markerRadius(depth);
    return Math.PI * r * r;
  }

  /** Escape text bound for innerHTML — post content is arbitrary. */
  function esc(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function dipTip(d) {
    const span =
      spanOf(d) === "single"
        ? fmtDay(parseDay(d.end_date)) + " · single session"
        : `${fmtShortDay(parseDay(d.start_date))} → ${fmtDay(parseDay(d.end_date))} · ${d.trading_days} sessions`;

    let html =
      `<div class="tt-date">${KIND_LABEL[d.kind]} · ${span}</div>` +
      `<div class="tt-value move ${isUp(d) ? "pos" : "neg"}">${signed(movePct(d))}</div>`;

    const top = d.posts[0];
    if (top) {
      const when = new Date(top.ts).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const rel =
        top.phase === "before"
          ? lead(top.lead_hours) + " before the key session"
          : top.phase === "during"
          ? "during the key session"
          : "after that session closed";
      html +=
        `<blockquote class="tt-quote">${esc(truncate(top.text, 180))}</blockquote>` +
        `<div class="tt-date">${esc(when)} · ${rel}</div>` +
        (d.posts.length > 1
          ? `<div class="tt-more">+${d.posts.length - 1} more · click to see all</div>`
          : `<div class="tt-more">Click to inspect</div>`);
    } else {
      html += `<div class="tt-date">No market-relevant posts in this window</div>`;
    }
    return html;
  }

  // ------------------------------------------------------ context/brush

  function drawContext() {
    const host = d3.select("#context-chart");
    host.selectAll("*").remove();

    const data = series().map((r) => ({ date: parseDay(r.d), close: r.c }));
    const width = host.node().clientWidth || 900;
    const height = 66;
    const margin = { top: 6, right: 18, bottom: 18, left: 56 };
    const iw = width - margin.left - margin.right;
    const ih = height - margin.top - margin.bottom;

    const full = d3.extent(data, (d) => d.date);
    const x = d3.scaleUtc().domain(full).range([0, iw]);
    const y = d3.scaleLinear().domain(d3.extent(data, (d) => d.close)).range([ih, 0]);

    const svg = host
      .append("svg")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("aria-hidden", "true");
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    g.append("g")
      .selectAll("rect")
      .data(legs())
      .join("rect")
      .attr("class", (d) => "dip-band band-" + d.direction)
      .style("pointer-events", "none")
      .attr("x", (d) => x(parseDay(d.start_date)))
      .attr("width", (d) => Math.max(1, x(parseDay(d.end_date)) - x(parseDay(d.start_date))))
      .attr("y", 0)
      .attr("height", ih);

    g.append("path")
      .datum(data)
      .attr("class", "context-line")
      .attr("d", d3.line().x((d) => x(d.date)).y((d) => y(d.close)));

    g.append("g")
      .attr("class", "axis")
      .attr("transform", `translate(0,${ih})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(iw / 110))));

    const brush = d3
      .brushX()
      .extent([[0, 0], [iw, ih]])
      .on("end", (event) => {
        if (!event.sourceEvent) return;
        state.domain = event.selection
          ? event.selection.map(x.invert)
          : null;
        drawFocus();
      });

    const bg = g.append("g").attr("class", "brush").call(brush);
    if (state.domain) bg.call(brush.move, state.domain.map(x));
  }

  // ------------------------------------------------------------ dip list

  function selectDip(id) {
    state.selectedId = id;
    drawFocus();
    renderDipList();
    renderDetail();
    document.querySelector("#dip-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderDipList() {
    const dips = activeDips().slice().sort((a, b) => b.move_pct - a.move_pct);
    d3.select("#dip-count").text(`(${dips.length})`);

    const items = d3
      .select("#dip-items")
      .selectAll("li")
      .data(dips, (d) => d.id)
      .join("li")
      .attr("class", (d) => (d.id === state.selectedId ? "is-selected" : null))
      .on("click", (event, d) => selectDip(d.id));

    items.selectAll("*").remove();
    const left = items.append("div");
    left
      .append("div")
      .attr("class", "li-date")
      .text((d) => fmtDay(parseDay(d.end_date)));
    left
      .append("div")
      .attr("class", "li-sub")
      .text(
        (d) =>
          KIND_LABEL[d.kind] +
          (spanOf(d) === "single" ? "" : ` · ${d.trading_days} sessions`) +
          ` · ${d.posts.length} post${d.posts.length === 1 ? "" : "s"}`
      );
    items
      .append("div")
      .attr("class", (d) => "li-depth " + (isUp(d) ? "pos" : "neg"))
      .text((d) => signed(movePct(d), 1));
  }

  // -------------------------------------------------------------- table

  function renderTable() {
    const dips = activeDips().slice().sort((a, b) => b.move_pct - a.move_pct);
    const rows = d3
      .select("#dip-table tbody")
      .selectAll("tr")
      .data(dips, (d) => d.id)
      .join("tr")
      .on("click", (event, d) => selectDip(d.id));

    rows.selectAll("td").remove();
    const cell = (fn, cls) =>
      rows.append("td").attr("class", cls || null).text(fn);

    cell((d) => KIND_LABEL[d.kind]);
    cell((d) => fmtDay(parseDay(d.start_date)));
    cell((d) => fmtDay(parseDay(d.end_date)));
    cell((d) => signed(movePct(d)), "num");
    cell((d) => signed(d.key_day_pct), "num");
    cell((d) => d.trading_days, "num");
    cell((d) => d.posts.length, "num");
    cell((d) => (d.posts[0] ? truncate(d.posts[0].text, 90) : "—"));
  }

  /** Human lead time — minutes under an hour, days past two. */
  function lead(hours) {
    if (hours < 1) return Math.round(hours * 60) + " min";
    if (hours < 48) return Math.round(hours) + "h";
    return Math.round(hours / 24) + " days";
  }

  function truncate(text, n) {
    return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
  }

  // ------------------------------------------------------------- detail

  function renderDetail() {
    const host = d3.select("#dip-detail");
    const dip = selectedDip();
    host.selectAll("*").remove();

    if (!dip) {
      host
        .append("p")
        .attr("class", "empty")
        .text("Select an event on the chart or in the list to see the posts that landed during it.");
      return;
    }

    const up = isUp(dip);
    const single = spanOf(dip) === "single";
    const sign = up ? "pos" : "neg";

    host
      .append("h2")
      .attr("class", "detail-head " + sign)
      .text(
        `${signed(movePct(dip))} ${single ? "on" : "into"} ${fmtDay(parseDay(dip.end_date))}`
      );

    const label = state.market[state.indexKey].label;
    host
      .append("p")
      .attr("class", "sub")
      .text(
        single
          ? `${label} closed at ${fmtNum(dip.end_close)}, ${up ? "up" : "down"} from ` +
            `${fmtNum(dip.start_close)} the session before — its ` +
            `#${dip.rank} biggest single-session ${up ? "gain" : "drop"} since 2024.`
          : `${label} ${up ? "rose" : "fell"} from ${fmtNum(dip.start_close)} on ` +
            `${fmtDay(parseDay(dip.start_date))} to ${fmtNum(dip.end_close)} on ` +
            `${fmtDay(parseDay(dip.end_date))} — ${dip.trading_days} sessions, ` +
            `the #${dip.rank} largest ${up ? "advance" : "decline"} since 2024.`
      );

    const stats = single
      ? [
          { k: "One-day move", v: signed(dip.key_day_pct), cls: sign },
          { k: "Rank by size", v: "#" + dip.rank },
          { k: "Posts in window", v: dip.posts_considered },
        ]
      : [
          { k: "Total move", v: signed(movePct(dip)), cls: sign },
          { k: "Key session", v: signed(dip.key_day_pct), cls: sign },
          { k: "Key day", v: fmtShortDay(parseDay(dip.key_day)) },
          { k: "Rank by size", v: "#" + dip.rank },
          { k: "Posts in window", v: dip.posts_considered },
        ];
    const row = host.append("div").attr("class", "stat-row");
    const stat = row.selectAll("div").data(stats).join("div").attr("class", "stat");
    stat.append("span").attr("class", (d) => "v " + (d.cls || "")).text((d) => d.v);
    stat.append("span").attr("class", "k").text((d) => d.k);

    const posts = host.append("section").attr("class", "posts");
    posts.append("h3").text("Candidate Truth Social posts");
    posts
      .append("p")
      .attr("class", "posts-note")
      .text(
        dip.posts.length
          ? `Top ${dip.posts.length} of ${dip.posts_considered} market-relevant posts published ` +
            (single
              ? "between the previous close and this one — the only posts that could have moved it. "
              : `between ${fmtShortDay(parseDay(dip.start_date))} and ${fmtShortDay(parseDay(dip.end_date))}. `) +
            "Ranked by subject relevance, proximity to the key session, and engagement."
          : "No market-relevant posts were published during this window."
      );

    const cards = posts.selectAll("article").data(dip.posts).join("article").attr("class", "post");

    const head = cards.append("div").attr("class", "post-head");
    head
      .append("span")
      .attr("class", "post-when")
      .text((p) => {
        const when = new Date(p.ts);
        const rel =
          p.phase === "before"
            ? `${lead(p.lead_hours)} before the key session opened`
            : p.phase === "during"
            ? "during the key session"
            : `${lead(Math.abs(p.lead_hours))} after that session closed — post-hoc`;
        return `${when.toLocaleString(undefined, {
          month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
        })} · ${rel}`;
      });
    head.append("span").attr("class", "post-score").text((p) => `match ${p.score.toFixed(1)}`);

    cards.append("p").attr("class", "post-text").text((p) => p.text);

    const foot = cards.append("div").attr("class", "post-foot");
    foot
      .append("span")
      .html((p) =>
        p.next_session_pct == null
          ? ""
          : `First session the post could reach (${fmtShortDay(parseDay(p.next_session))}): ` +
            `<span class="move ${p.next_session_pct < 0 ? "neg" : "pos"}">` +
            `${fmtPct(p.next_session_pct)}%</span>`
      );
    foot.append("span").text((p) => `${p.likes.toLocaleString()} likes`);
    foot
      .append("a")
      .attr("href", (p) => p.url)
      .attr("target", "_blank")
      .attr("rel", "noopener noreferrer")
      .text("View on Truth Social");

    cards
      .append("div")
      .attr("class", "post-foot")
      .selectAll("span.chip")
      .data((p) => p.terms)
      .join("span")
      .attr("class", "chip")
      .text((t) => t);
  }

  // -------------------------------------------------------------- utils

  function debounce(fn, ms) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }
})();
