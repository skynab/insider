/* Insider — interactive drawdown explorer.
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
    kind: "all", // all | drawdown | shock
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
    state.dipsByIndex = data.dips.indices;
    state.meta = data.meta;
    state.indexKey = data.dips.primary || "spx";

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

  /** Events for the active index, filtered by size and type. */
  function activeDips() {
    return state.dipsByIndex[state.indexKey].filter(
      (d) =>
        d.depth_pct >= state.minDepth &&
        (state.kind === "all" || d.kind === state.kind)
    );
  }

  function drawdowns() {
    return activeDips().filter((d) => d.kind === "drawdown");
  }

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

    d3.selectAll("#kind-toggle button").on("click", function () {
      state.kind = this.dataset.kind;
      d3.selectAll("#kind-toggle button").classed("is-active", false);
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
    const deepest = d3.max(all.filter((d) => d.kind === "drawdown"), (d) => d.depth_pct);
    const worstDay = d3.min(all, (d) => d.worst_day_pct);
    const stats = [
      { k: "Events tracked", v: all.length },
      { k: "Deepest drawdown", v: "−" + deepest.toFixed(1) + "%" },
      { k: "Worst session", v: "−" + Math.abs(worstDay).toFixed(1) + "%" },
      { k: "Posts scanned", v: state.meta.post_count.toLocaleString() },
    ];
    const sel = d3
      .select("#head-stats")
      .selectAll("div")
      .data(stats)
      .join("div");
    sel.selectAll("dt").data((d) => [d]).join("dt").text((d) => d.k);
    sel.selectAll("dd").data((d) => [d]).join("dd").text((d) => d.v);
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

    // Drawdown bands, drawn under the line.
    const dips = activeDips();
    plot
      .append("g")
      .selectAll("rect")
      .data(drawdowns())
      .join("rect")
      .attr("class", "dip-band")
      .attr("x", (d) => x(parseDay(d.peak_date)))
      .attr("width", (d) => Math.max(1.5, x(parseDay(d.trough_date)) - x(parseDay(d.peak_date))))
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

    // Event markers: circles for drawdown troughs, diamonds for single-session
    // shocks, so the two classes stay distinguishable without relying on color.
    // Added last so their hover wins over the crosshair capture area.
    const symbol = d3.symbol();
    const markers = plot
      .append("g")
      .selectAll("g")
      .data(dips)
      .join("g")
      .attr("transform", (d) => `translate(${x(parseDay(d.trough_date))},${y(d.trough_close)})`)
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
      .attr("r", (d) => Math.max(13, markerRadius(d.depth_pct) + 7));

    markers
      .append("path")
      .attr("class", (d) =>
        "trough-dot marker-" + d.kind + (d.id === state.selectedId ? " is-selected" : "")
      )
      .attr("d", (d) =>
        symbol
          .type(d.kind === "shock" ? d3.symbolDiamond : d3.symbolCircle)
          .size(markerArea(d.depth_pct))()
      );

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
      d.kind === "shock"
        ? fmtDay(parseDay(d.trough_date)) + " · single session"
        : `${fmtShortDay(parseDay(d.peak_date))} → ${fmtDay(parseDay(d.trough_date))} · ${d.trading_days} sessions`;

    let html =
      `<div class="tt-date">${span}</div>` +
      `<div class="tt-value move neg">−${d.depth_pct.toFixed(2)}%</div>`;

    const top = d.posts[0];
    if (top) {
      const when = new Date(top.ts).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      });
      const rel =
        top.phase === "before"
          ? lead(top.lead_hours) + " before the worst session"
          : top.phase === "during"
          ? "during the worst session"
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
      .data(drawdowns())
      .join("rect")
      .attr("class", "dip-band")
      .style("pointer-events", "none")
      .attr("x", (d) => x(parseDay(d.peak_date)))
      .attr("width", (d) => Math.max(1, x(parseDay(d.trough_date)) - x(parseDay(d.peak_date))))
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
    const dips = activeDips().slice().sort((a, b) => b.depth_pct - a.depth_pct);
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
      .text((d) => fmtDay(parseDay(d.trough_date)));
    left
      .append("div")
      .attr("class", "li-sub")
      .text(
        (d) =>
          (d.kind === "shock" ? "Single session" : `${d.trading_days} sessions`) +
          ` · ${d.posts.length} post${d.posts.length === 1 ? "" : "s"}`
      );
    items
      .append("div")
      .attr("class", "li-depth")
      .text((d) => "−" + d.depth_pct.toFixed(1) + "%");
  }

  // -------------------------------------------------------------- table

  function renderTable() {
    const dips = activeDips().slice().sort((a, b) => b.depth_pct - a.depth_pct);
    const rows = d3
      .select("#dip-table tbody")
      .selectAll("tr")
      .data(dips, (d) => d.id)
      .join("tr")
      .on("click", (event, d) => selectDip(d.id));

    rows.selectAll("td").remove();
    const cell = (fn, cls) =>
      rows.append("td").attr("class", cls || null).text(fn);

    cell((d) => (d.kind === "shock" ? "Shock" : "Drawdown"));
    cell((d) => fmtDay(parseDay(d.peak_date)));
    cell((d) => fmtDay(parseDay(d.trough_date)));
    cell((d) => "−" + d.depth_pct.toFixed(2) + "%", "num");
    cell((d) => "−" + Math.abs(d.worst_day_pct).toFixed(2) + "%", "num");
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
        .text("Select a dip on the chart or in the list to see the posts that landed during it.");
      return;
    }

    host
      .append("h2")
      .text(`−${dip.depth_pct.toFixed(2)}% into ${fmtDay(parseDay(dip.trough_date))}`);

    const label = state.market[state.indexKey].label;
    host
      .append("p")
      .attr("class", "sub")
      .text(
        dip.kind === "shock"
          ? `${label} closed at ${fmtNum(dip.trough_close)}, down from ` +
            `${fmtNum(dip.peak_close)} the session before — its ` +
            `#${dip.rank} worst single session since 2024.`
          : `${label} fell from ${fmtNum(dip.peak_close)} on ` +
            `${fmtDay(parseDay(dip.peak_date))} to ${fmtNum(dip.trough_close)} over ` +
            `${dip.trading_days} sessions` +
            (dip.recovery_date
              ? `, and reclaimed the old high on ${fmtDay(parseDay(dip.recovery_date))} ` +
                `(${dip.recovery_days} sessions later).`
              : ", and has not yet reclaimed that high.")
      );

    const stats =
      dip.kind === "shock"
        ? [
            { k: "One-day move", v: "−" + Math.abs(dip.worst_day_pct).toFixed(2) + "%", cls: "neg" },
            { k: "Rank by size", v: "#" + dip.rank },
            { k: "Posts in window", v: dip.posts_considered },
          ]
        : [
            { k: "Depth", v: "−" + dip.depth_pct.toFixed(2) + "%", cls: "neg" },
            { k: "Worst session", v: "−" + Math.abs(dip.worst_day_pct).toFixed(2) + "%", cls: "neg" },
            { k: "Worst day", v: fmtShortDay(parseDay(dip.worst_day)) },
            { k: "Rank by depth", v: "#" + dip.rank },
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
            (dip.kind === "shock"
              ? `between the previous close and this one — the only posts that could have moved it. `
              : `between ${fmtShortDay(parseDay(dip.peak_date))} and ${fmtShortDay(parseDay(dip.trough_date))}. `) +
            "Ranked by subject relevance, proximity to the worst session, and engagement."
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
            ? `${lead(p.lead_hours)} before the worst session opened`
            : p.phase === "during"
            ? "during the worst session"
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
