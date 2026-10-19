/* Bay of Bengal grid · GIBS sampling · hilsha HSI */

const state = {
  map: null,
  overlays: {},
  labels: null,
  gridLayer: null,
  hsiLayer: null,
  renderer: null,
  cells: [],
  raw: [],
  computed: false,
  computing: false,
  ready: false,
  gridStep: CONFIG.grid.step,
  params: JSON.parse(JSON.stringify(CONFIG.hsi.params)),
  colormapsOk: false
};

const $ = (id) => document.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ================= boot ================= */

async function boot() {
  initMap();
  buildNotes();
  buildParamsUI();
  buildHSILegend();
  wireUI();
  setSwitchesDisabled(true);

  const offline = navigator.onLine === false;
  if (!offline) {
    try {
      await Data.ensureDates((m) => ($("dates").textContent = m));
    } catch (e) { /* keep defaults */ }
  }
  buildOverlays();
  updateDateLabels();
  updateGridInfo();
  setSwitchesDisabled(false);
  state.ready = true;

  ensureColormaps()
    .then(buildLayerLegends)
    .catch((err) =>
      showBanner(
        "Could not read the GIBS colour scales (" + err.message +
        "). If you opened index.html directly from disk, serve the folder over HTTP instead, e.g.  python -m http.server 8000"
      )
    );

  // optional deep links:  ?layers=sst,sss,chl&grid=1&hsi=1
  const qs = new URLSearchParams(location.search);
  if (qs.get("layers")) {
    qs.get("layers").split(",").forEach((k) => {
      const cb = $("tgl-" + k.trim());
      if (cb && state.overlays[k]) { cb.checked = true; state.overlays[k].addTo(state.map); }
    });
  }
  if (qs.get("grid")) { $("tgl-grid").checked = true; state.gridLayer = makeGridLayer().addTo(state.map); }
  if (qs.get("hsi") || qs.get("debug")) {
    $("tgl-hsi").checked = true;
    await computeHSI();
    if (state.computed) renderHSI();
  }
  if (qs.get("debug") && state.computed) setTimeout(async () => {
    const ev = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    const set = (el, v) => { el.checked = v; ev(el, "change"); };
    const inter = {};
    const sst = $("tgl-sst");
    set(sst, false); inter.sstOff = !state.map.hasLayer(state.overlays.sst);
    set(sst, true); inter.sstOn = state.map.hasLayer(state.overlays.sst);
    const g = $("tgl-grid");
    set(g, false); inter.gridOff = !state.map.hasLayer(state.gridLayer);
    set(g, true); inter.gridOn = state.map.hasLayer(state.gridLayer);
    const h = $("tgl-hsi");
    set(h, false);
    await new Promise((r) => setTimeout(r, 600));
    inter.hsiOff = !state.map.hasLayer(state.hsiLayer);
    set(h, true);
    await new Promise((r) => setTimeout(r, 1200));
    inter.hsiOn = state.map.hasLayer(state.hsiLayer);

    const before = JSON.stringify(state.cells.map((c) => c.hsi));
    const inp = $("params").querySelector('input[data-k="sst"][data-f="opt"]');
    inp.value = "26";
    $("btn-params").click();
    await new Promise((r) => setTimeout(r, 400));
    inter.paramsApplied = state.params.sst.opt === 26;
    inter.hsiRecalculated = JSON.stringify(state.cells.map((c) => c.hsi)) !== before;
    inp.value = "28";
    $("btn-params").click();

    const summary = {};
    for (const k of ["sst", "sss", "chl"]) {
      const v = state.raw.map((r) => r[k]).filter((x) => x !== null && isFinite(x));
      summary[k] = v.length
        ? { n: v.length, min: +Math.min(...v).toFixed(3), max: +Math.max(...v).toFixed(3),
            mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) }
        : { n: 0 };
    }
    const hist = (arr, edges) => {
      const h = {};
      edges.forEach((e) => (h[e] = 0));
      arr.forEach((v) => {
        for (let i = edges.length - 1; i >= 0; i--) if (v >= edges[i]) { h[edges[i]]++; return; }
      });
      return h;
    };
    const sv = state.raw.map((r) => r.sss).filter((x) => x !== null);
    const hv = state.cells.map((c) => c.hsi).filter((x) => x !== null);
    const transect = state.cells
      .filter((c) => Math.abs(c.clon - 90) < 0.26 && c.row % 2 === 0)
      .map((c) => ({ lat: c.clat, sss: c.raw.sss, sst: c.raw.sst, hsi: c.hsi }));
    let canvasCheck = "no canvas";
    const cv = document.querySelector(".leaflet-overlay-pane canvas");
    if (cv) {
      const img = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0, total = 0, hsiLike = 0;
      const freq = {};
      for (let i = 3; i < img.length; i += 4 * 97) {
        total++;
        if (img[i] > 0) {
          painted++;
          const r = img[i - 3], g = img[i - 2], b = img[i - 1];
          if (Math.max(r, g, b) - Math.min(r, g, b) > 45) hsiLike++;
          const k = r + "," + g + "," + b;
          freq[k] = (freq[k] || 0) + 1;
        }
      }
      const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([c, n]) => `${c}×${n}`).join(" | ");
      canvasCheck = `zoom=${state.map.getZoom()} canvas ${cv.width}x${cv.height} painted ${(100 * painted / total).toFixed(1)}% saturated ${(100 * hsiLike / total).toFixed(1)}% top: ${top}`;
    }
    const pre = document.createElement("pre");
    pre.id = "debugdump";
    pre.textContent = JSON.stringify(
      { inter, canvasCheck, summary,
        sss_hist: hist(sv, [25, 28, 30, 31, 32, 33, 34, 35]),
        hsi_hist: hist(hv, [0, 0.2, 0.4, 0.6, 0.8, 1]), transect,
        sample: state.cells.slice(0, 12).map((c) => ({
          lat: +c.clat.toFixed(2), lon: +c.clon.toFixed(2),
          sst: c.raw.sst, sss: c.raw.sss, chl: c.raw.chl, hsi: c.hsi, st: c.status })) },
      null, 1
    );
    document.body.appendChild(pre);
  }, 2000);
}

/* ================= map ================= */

function initMap() {
  state.map = L.map("map", {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 12
  });
  state.renderer = L.canvas({ padding: 0.4 });

  const b = CONFIG.bounds;
  state.map.fitBounds([[b.latMin, b.lonMin], [b.latMax, b.lonMax]]);
  state.map.setMaxBounds([[b.latMin - 8, b.lonMin - 10], [b.latMax + 8, b.lonMax + 10]]);

  tileUrl(CONFIG.base.bathymetry).addTo(state.map);
  tileUrl(CONFIG.base.coast).addTo(state.map);
}

function tileUrl(cfg) {
  const time = cfg.time ? `${cfg.time}/` : "";
  return L.tileLayer(
    `${CONFIG.gibs}/${cfg.id}/default/${time}${cfg.set}/{z}/{y}/{x}.${cfg.ext}`,
    {
      maxNativeZoom: cfg.maxNativeZoom,
      maxZoom: 12,
      attribution: 'NASA <a href="https://worldview.earthdata.nasa.gov/">Worldview</a> / GIBS'
    }
  );
}

function buildOverlays() {
  for (const cfg of Object.values(CONFIG.layers)) {
    const url =
      `${CONFIG.gibs}/${cfg.id}/default/${Data.dates[cfg.key]}/${cfg.set}/{z}/{y}/{x}.png`;
    state.overlays[cfg.key] = L.tileLayer(url, {
      maxNativeZoom: cfg.maxNativeZoom,
      maxZoom: 12,
      opacity: 0.85,
      attribution: cfg.source
    });
  }
  state.labels = tileUrl(CONFIG.base.labels);
}

/* ================= UI wiring ================= */

function wireUI() {
  for (const cfg of Object.values(CONFIG.layers)) {
    $("tgl-" + cfg.key).addEventListener("change", (e) => {
      if (!state.ready) return;
      if (e.target.checked) state.overlays[cfg.key].addTo(state.map);
      else state.map.removeLayer(state.overlays[cfg.key]);
    });
  }

  $("tgl-labels").addEventListener("change", (e) => {
    if (e.target.checked) state.labels.addTo(state.map);
    else state.map.removeLayer(state.labels);
  });

  $("tgl-grid").addEventListener("change", (e) => {
    if (e.target.checked) {
      if (!state.gridLayer) state.gridLayer = makeGridLayer();
      state.gridLayer.addTo(state.map);
    } else if (state.gridLayer) {
      state.map.removeLayer(state.gridLayer);
    }
  });

  $("grid-step").addEventListener("change", async (e) => {
    state.gridStep = parseFloat(e.target.value);
    updateGridInfo();
    if (state.gridLayer) {
      state.map.removeLayer(state.gridLayer);
      state.gridLayer = null;
      if ($("tgl-grid").checked) {
        state.gridLayer = makeGridLayer();
        state.gridLayer.addTo(state.map);
      }
    }
    if (state.computed && $("tgl-hsi").checked) await computeHSI();
    else invalidate();
  });

  $("tgl-hsi").addEventListener("change", async (e) => {
    if (e.target.checked) {
      if (!state.computed) await computeHSI();
      if (state.computed) renderHSI();
      else e.target.checked = false;
    } else if (state.hsiLayer) {
      state.map.removeLayer(state.hsiLayer);
    }
  });

  $("btn-params").addEventListener("click", applyParams);
  $("btn-csv").addEventListener("click", exportCSV);
  $("banner").addEventListener("click", () => $("banner").classList.add("hidden"));
}

function setSwitchesDisabled(v) {
  document
    .querySelectorAll('#panel input[type="checkbox"], #panel select, #panel button')
    .forEach((el) => (el.disabled = v));
}

/* ================= legends / labels ================= */

function buildNotes() {
  $("notes").innerHTML = CONFIG.notes.map((n) => `<li>${n}</li>`).join("");
}

function updateDateLabels() {
  const d = Data.dates;
  $("dates").textContent =
    `SST ${d.sst} · SSS ${d.sss} · Chl ${d.chl} (+${CONFIG.layers.chl.compositeDays - 1} d mean)`;
  for (const cfg of Object.values(CONFIG.layers)) {
    $("meta-" + cfg.key).textContent = `${cfg.source} · ${Data.dates[cfg.key]}`;
  }
}

function updateGridInfo() {
  const b = CONFIG.bounds;
  const s = state.gridStep;
  const rows = Math.round((b.latMax - b.latMin) / s);
  const cols = Math.round((b.lonMax - b.lonMin) / s);
  $("gridinfo").textContent =
    `${b.latMin}°N–${b.latMax}°N, ${b.lonMin}°E–${b.lonMax}°E → ${rows} × ${cols} = ${rows * cols} cells`;
}

async function ensureColormaps() {
  if (state.colormapsOk) return;
  await Promise.all(Object.values(CONFIG.layers).map((c) => Colormap.load(c)));
  state.colormapsOk = true;
}

async function buildLayerLegends() {
  await ensureColormaps();
  for (const cfg of Object.values(CONFIG.layers)) {
    const cm = Colormap.store[cfg.key];
    $("grad-" + cfg.key).style.background = Colormap.cssGradient(cm);
    const u = cm.units || cfg.unit;
    $("min-" + cfg.key).textContent = `${fmt(cm.dataMin, cfg.dec)} ${u}`;
    $("max-" + cfg.key).textContent = `${fmt(cm.dataMax, cfg.dec)} ${u}`;
    $("legend-" + cfg.key).hidden = false;
    const range = $("range-" + cfg.key);
    if (range) range.textContent = `GIBS legend: ${fmt(cm.dataMin, cfg.dec)} – ${fmt(cm.dataMax, cfg.dec)} ${u}`;
  }
}

function buildHSILegend() {
  $("grad-hsi").style.background = hsiGradientCss();
  $("hsi-ticks").innerHTML = CONFIG.hsi.stops
    .map((s) => `<span>${s[0].toFixed(2)}</span>`)
    .join("");
}

/* ================= grid ================= */

function makeGridLayer() {
  const g = L.layerGroup();
  const b = CONFIG.bounds;
  const s = state.gridStep;
  for (let lat = b.latMin; lat < b.latMax - 1e-9; lat += s) {
    for (let lon = b.lonMin; lon < b.lonMax - 1e-9; lon += s) {
      L.rectangle(
        [[lat, lon], [lat + s, lon + s]],
        { renderer: state.renderer, fill: false, color: "#8fb2d8", weight: 0.6, interactive: false }
      ).addTo(g);
    }
  }
  return g;
}

/* ================= HSI computation ================= */

function suitability(x, p) {
  if (x === null || x === undefined || !isFinite(x)) return null;
  if (x <= p.min || x >= p.max) return 0;
  return x <= p.opt ? (x - p.min) / (p.opt - p.min) : (p.max - x) / (p.max - p.opt);
}

function recalcHSI() {
  const w = CONFIG.hsi.weights;
  state.cells.forEach((c, i) => {
    const r = state.raw[i];
    const S = {
      sst: suitability(r.sst, state.params.sst),
      sss: suitability(r.sss, state.params.sss),
      chl: suitability(r.chl, state.params.chl)
    };
    let num = 0, den = 0, present = 0;
    for (const k of ["sst", "sss", "chl"]) {
      if (S[k] !== null) { num += w[k] * S[k] * S[k]; den += w[k]; present++; }
    }
    c.raw = r; c.S = S;
    c.hsi = den > 0 ? Math.sqrt(num / den) : null;
    c.status = present === 3 ? "full" : present > 0 ? "partial" : "none";
  });
}

async function computeHSI() {
  if (state.computing) return;
  state.computing = true;
  $("tgl-hsi").disabled = true;
  try {
    progress("Reading colour scales…", 0.02);
    await ensureColormaps();

    progress("Downloading NASA GIBS tiles…", 0.05);
    await Data.loadForCompute((done, total) =>
      progress(`Downloading NASA GIBS tiles… ${done}/${total}`, 0.05 + 0.55 * (done / total))
    );

    state.cells = Data.buildGrid(state.gridStep);
    const total = state.cells.length;
    const raw = new Array(total);
    for (let i = 0; i < total; i++) {
      const c = state.cells[i];
      raw[i] = {
        sst: Data.cellMean("sst", c).mean,
        sss: Data.cellMean("sss", c).mean,
        chl: Data.cellMean("chl", c).mean
      };
      if (i % 64 === 0) {
        progress(`Sampling grid cells… ${i}/${total}`, 0.6 + 0.35 * (i / total));
        await tick();
      }
    }
    state.raw = raw;
    recalcHSI();
    state.computed = true;

    if ($("tgl-hsi").checked) renderHSI();
    renderStats();
    warnOffline();
    progress("HSI ready", 1);
    setTimeout(hideProgress, 500);
  } catch (err) {
    hideProgress();
    showBanner("Computation failed: " + err.message);
  } finally {
    state.computing = false;
    $("tgl-hsi").disabled = false;
  }
}

function invalidate() {
  state.computed = false;
  state.cells = [];
  state.raw = [];
  if (state.hsiLayer) { state.map.removeLayer(state.hsiLayer); state.hsiLayer = null; }
  $("stats").hidden = true;
}

/* ================= rendering ================= */

function hsiColor(v) {
  const s = CONFIG.hsi.stops;
  if (!isFinite(v)) return "#3a4654";
  if (v <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const t = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      return mixHex(s[i - 1][1], s[i][1], t);
    }
  }
  return s[s.length - 1][1];
}

function hsiGradientCss() {
  return "linear-gradient(to right, " +
    CONFIG.hsi.stops.map((s) => `${s[1]} ${(s[0] * 100).toFixed(0)}%`).join(", ") + ")";
}

function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(r1, r2)},${m(g1, g2)},${m(b1, b2)})`;
}

function renderHSI() {
  if (state.hsiLayer) state.map.removeLayer(state.hsiLayer);
  const g = L.layerGroup();
  for (const c of state.cells) {
    const bounds = [[c.latMin, c.lonMin], [c.latMax, c.lonMax]];
    const has = c.hsi !== null;
    const rect = L.rectangle(bounds, {
      renderer: state.renderer,
      color: has ? "rgba(255,255,255,.35)" : "#59636f",
      weight: 0.5,
      fillColor: has ? hsiColor(c.hsi) : "#2b3540",
      fillOpacity: has ? (c.status === "full" ? 0.8 : 0.5) : 0.35
    });
    rect.bindTooltip(cellTip(c), { sticky: true });
    rect.bindPopup(() => cellPopup(c));
    rect.addTo(g);
    c._rect = rect;
  }
  state.hsiLayer = g;
  g.addTo(state.map);
}

function cellTip(c) {
  if (c.hsi === null) return `cell ${c.id} · no data`;
  return `<b>HSI ${c.hsi.toFixed(2)}</b> · SST ${fmt(c.raw.sst, 1)}°C · SSS ${fmt(c.raw.sss, 1)} · Chl ${fmt(c.raw.chl, 2)}`;
}

function cellPopup(c) {
  const head = `<div class="popup-title">Grid cell ${c.id} (${state.gridStep}° · ${c.clat.toFixed(2)}°N, ${c.clon.toFixed(2)}°E)</div>`;
  if (c.hsi === null) {
    return head + `<div class="popup-tag">No GIBS observations available for this cell.</div>`;
  }
  const row = (l, v, u = "") => `<tr><td>${l}</td><td>${v} ${u}</td></tr>`;
  const w = CONFIG.hsi.weights;
  return head + `
    <table class="popup-table">
      ${row("SST", fmt(c.raw.sst, 2), "°C")}
      ${row("Salinity", fmt(c.raw.sss, 2), "PSU")}
      ${row("Chlorophyll a", fmt(c.raw.chl, 3), "mg/m³")}
      ${row("S<sub>SST</sub> (w " + w.sst.toFixed(2) + ")", fmt(c.S.sst, 2))}
      ${row("S<sub>SSS</sub> (w " + w.sss.toFixed(2) + ")", fmt(c.S.sss, 2))}
      ${row("S<sub>Chl</sub> (w " + w.chl.toFixed(2) + ")", fmt(c.S.chl, 2))}
      ${row("<b>HSI</b>", "<b>" + c.hsi.toFixed(3) + "</b>")}
    </table>
    <div class="bar"><i style="width:${(c.hsi * 100).toFixed(1)}%;background:${hsiColor(c.hsi)}"></i></div>
    <div class="popup-tag">${c.status === "full" ? "all three variables present" : "partial data — weights re-normalised"}</div>`;
}

/* ================= stats / csv ================= */

function renderStats() {
  const withHsi = state.cells.filter((c) => c.hsi !== null);
  const full = state.cells.filter((c) => c.status === "full").length;
  const partial = state.cells.filter((c) => c.status === "partial").length;
  const none = state.cells.filter((c) => c.status === "none").length;
  const mean = withHsi.length ? withHsi.reduce((a, c) => a + c.hsi, 0) / withHsi.length : NaN;
  const max = withHsi.length ? Math.max(...withHsi.map((c) => c.hsi)) : NaN;
  const min = withHsi.length ? Math.min(...withHsi.map((c) => c.hsi)) : NaN;

  const rows = [
    ["Grid cells", state.cells.length],
    ["Cells with HSI", withHsi.length],
    ["Full data / partial / none", `${full} / ${partial} / ${none}`],
    ["Mean HSI", fmt(mean, 3)],
    ["Max HSI", fmt(max, 3)],
    ["Min HSI", fmt(min, 3)]
  ];
  $("stats-table").innerHTML = rows
    .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`)
    .join("");

  const top = [...withHsi].sort((a, b) => b.hsi - a.hsi).slice(0, 5);
  $("top-cells").innerHTML = top
    .map((c) => `<li data-id="${c.id}">#${c.id} · ${c.clat.toFixed(2)}°N ${c.clon.toFixed(2)}°E · HSI ${c.hsi.toFixed(3)}</li>`)
    .join("");
  $("top-cells").querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      const c = state.cells.find((x) => x.id === +li.dataset.id);
      if (!c) return;
      state.map.setView([c.clat, c.clon], Math.max(state.map.getZoom(), 7));
      if (c._rect) c._rect.openPopup();
    });
  });
  $("stats").hidden = false;
}

function exportCSV() {
  const head = [
    "cell_id", "row", "col", "lat_min", "lat_max", "lon_min", "lon_max",
    "lat_center", "lon_center", "sst_c", "sss_psu", "chl_mg_m3",
    "S_SST", "S_SSS", "S_Chl", "HSI", "status"
  ];
  const lines = [head.join(",")];
  state.cells.forEach((c) => {
    const r = c.raw || {};
    lines.push([
      c.id, c.row, c.col,
      c.latMin, c.latMax, c.lonMin, c.lonMax,
      c.clat, c.clon,
      num(r.sst), num(r.sss), num(r.chl),
      num(c.S && c.S.sst), num(c.S && c.S.sss), num(c.S && c.S.chl),
      num(c.hsi), c.status || ""
    ].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bob_hilsha_hsi_${state.gridStep}deg.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ================= suitability parameters UI ================= */

function buildParamsUI() {
  const wrap = $("params");
  wrap.innerHTML = "";
  for (const key of ["sst", "sss", "chl"]) {
    const p = state.params[key];
    const el = document.createElement("div");
    el.className = "param-block";
    el.innerHTML = `
      <div class="param-title">${p.label} <span>(${CONFIG.layers[key].unit})</span></div>
      <div class="param-inputs">
        <label>min<input type="number" step="any" data-k="${key}" data-f="min" value="${p.min}"></label>
        <label>optimum<input type="number" step="any" data-k="${key}" data-f="opt" value="${p.opt}"></label>
        <label>max<input type="number" step="any" data-k="${key}" data-f="max" value="${p.max}"></label>
      </div>
      <div class="param-range" id="range-${key}"></div>`;
    wrap.appendChild(el);
  }
}

function applyParams() {
  const inputs = $("params").querySelectorAll("input");
  const next = JSON.parse(JSON.stringify(state.params));
  inputs.forEach((i) => { next[i.dataset.k][i.dataset.f] = parseFloat(i.value); });
  for (const k of ["sst", "sss", "chl"]) {
    const p = next[k];
    if (!(isFinite(p.min) && isFinite(p.opt) && isFinite(p.max) && p.min < p.opt && p.opt < p.max)) {
      showBanner(`${p.label}: require min < optimum < max.`);
      return;
    }
  }
  state.params = next;
  if (state.computed) {
    recalcHSI();
    renderHSI();
    renderStats();
    showBanner("HSI recalculated with the new suitability parameters.");
  }
}

/* ================= helpers ================= */

function fmt(v, d) {
  return v === null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d);
}
function num(v) {
  return v === null || v === undefined || !isFinite(v) ? "" : Number(v).toFixed(4);
}

function progress(text, frac) {
  const p = $("progress");
  p.classList.remove("hidden");
  $("progress-text").textContent = text;
  $("progress-bar").style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
}
function hideProgress() { $("progress").classList.add("hidden"); }

function showBanner(msg) {
  const b = $("banner");
  b.textContent = msg;
  b.classList.remove("hidden");
}

function warnOffline() {
  const off = Object.values(CONFIG.layers)
    .filter((c) => Data.offline[c.key])
    .map((c) => c.short);
  if (off.length) {
    showBanner(
      `GIBS tiles for ${off.join(", ")} could not be downloaded — synthetic demo fields were used for those variables.`
    );
  }
}

boot();
