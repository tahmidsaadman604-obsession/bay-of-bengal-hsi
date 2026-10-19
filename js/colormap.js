/* GIBS colormap XML -> RGB -> physical value lookup table */

const Colormap = {
  store: {}, // key -> { lut: Map, dataMin, dataMax, units, title, stops: [] }

  async load(cfg) {
    if (this.store[cfg.key]) return this.store[cfg.key];
    const res = await fetch(cfg.colormap);
    if (!res.ok) throw new Error("colormap HTTP " + res.status);
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const mapNode = [...doc.getElementsByTagName("ColorMap")].find(
      (n) => n.getAttribute("title") !== "No Data"
    );
    if (!mapNode) throw new Error("no colour map in " + cfg.colormap);

    const entries = [...mapNode.getElementsByTagName("ColorMapEntry")];
    const lut = new Map();
    let dataMin = Infinity, dataMax = -Infinity;
    let firstKey = null;

    entries.forEach((e, i) => {
      const rgb = e.getAttribute("rgb");
      const range = e.getAttribute("value") || "";
      const [lo, hi] = parseRange(range);
      // geometric mean works for the log-spaced chlorophyll scale,
      // arithmetic for the linear scales (they are effectively identical)
      let v;
      if (isFinite(lo) && isFinite(hi)) v = lo > 0 ? Math.sqrt(lo * hi) : (lo + hi) / 2;
      else if (isFinite(lo)) v = lo;
      else if (isFinite(hi)) v = hi;
      else return;
      if (cfg.binOverrides && i === 0 && cfg.binOverrides.first !== undefined) {
        v = cfg.binOverrides.first;
      }
      lut.set(rgb, v);
      if (i === 0) firstKey = rgb;
      if (isFinite(lo) && lo > -1e30) dataMin = Math.min(dataMin, lo);
      if (isFinite(hi) && hi < 1e30) dataMax = Math.max(dataMax, hi);
    });

    // evenly sampled colour stops for building CSS gradients
    const stops = [];
    const n = Math.min(entries.length, 12);
    for (let i = 0; i < n; i++) {
      const e = entries[Math.round((i * (entries.length - 1)) / (n - 1))];
      const t = i / (n - 1);
      stops.push({ t, rgb: e.getAttribute("rgb") });
    }

    const units = mapNode.getAttribute("units") || "";
    const entry = {
      lut,
      firstKey,
      dataMin: dataMin === Infinity ? 0 : dataMin,
      dataMax: dataMax === -Infinity ? 0 : dataMax,
      units: units.replace(/A./g, "").trim(),
      title: mapNode.getAttribute("title") || cfg.title,
      stops
    };
    this.store[cfg.key] = entry;
    return entry;
  },

  /* value for an RGB triple, nearest-colour fallback for anti-aliased pixels */
  value(key, r, g, b) {
    const cm = this.store[key];
    if (!cm) return null;
    const exact = cm.lut.get(r + "," + g + "," + b);
    if (exact !== undefined) return exact;
    let best = null, bestD = 1e9;
    for (const [k, v] of cm.lut) {
      const [cr, cg, cb] = k.split(",").map(Number);
      const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD <= 64 ? best : null; // ~8/255 per channel
  },

  cssGradient(cm) {
    const parts = cm.stops.map(
      (s) => `rgb(${s.rgb}) ${(s.t * 100).toFixed(1)}%`
    );
    return `linear-gradient(to right, ${parts.join(", ")})`;
  }
};

function parseRange(v) {
  const m = v.match(/[\[(]([^,]+),\s*([^)\]]+)[\])]/);
  if (!m) return [NaN, NaN];
  const num = (s) => {
    s = s.trim();
    if (s === "-INF" || s === "-Inf") return -Infinity;
    if (s === "+INF" || s === "INF" || s === "Inf") return Infinity;
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  };
  return [num(m[1]), num(m[2])];
}
