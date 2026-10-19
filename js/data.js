/* GIBS tile access, pixel -> value sampling, grid building */

const Data = {
  dates: { sst: null, sss: null, chl: null },
  chlDates: [],
  offline: { sst: false, sss: false, chl: false },
  cache: new Map(), // "key|time|z|x|y" -> ImageData | null (failed)

  /* ---------- tile helpers ---------- */

  tileUrl(cfg, time, z, x, y) {
    const t = time ? `${time}/` : "";
    return `${CONFIG.gibs}/${cfg.id}/default/${t}${cfg.set}/${z}/${y}/${x}.png`;
  },

  cacheKey(key, time, z, x, y) {
    return `${key}|${time}|${z}|${x}|${y}`;
  },

  lonToPxX(lon, z) {
    return ((lon + 180) / 360) * 256 * Math.pow(2, z);
  },

  latToPxY(lat, z) {
    const s = Math.sin((lat * Math.PI) / 180);
    return (
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z)
    );
  },

  /* ---------- latest date discovery (probe tile, 404 = not published) ---------- */

  async probeLatest(cfg, maxBack = 14) {
    const z = cfg.sampleZoom;
    const x = Math.floor(this.lonToPxX((CONFIG.bounds.lonMin + CONFIG.bounds.lonMax) / 2, z) / 256);
    const y = Math.floor(this.latToPxY((CONFIG.bounds.latMin + CONFIG.bounds.latMax) / 2, z) / 256);
    const now = new Date();
    for (let i = 0; i <= maxBack; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const iso = d.toISOString().slice(0, 10);
      try {
        const img = await loadImage(this.tileUrl(cfg, iso, z, x, y));
        return iso;
      } catch (e) { /* 404 -> keep looking back */ }
    }
    return cfg.defaultDate;
  },

  async ensureDates(onStatus) {
    const layers = Object.values(CONFIG.layers);
    await Promise.all(
      layers.map(async (cfg) => {
        if (onStatus) onStatus(`Checking latest ${cfg.short} date…`);
        this.dates[cfg.key] = await this.probeLatest(cfg);
      })
    );
    const chl = CONFIG.layers.chl;
    const base = Date.parse(this.dates.chl);
    this.chlDates = [];
    for (let i = 0; i < chl.compositeDays; i++) {
      this.chlDates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
    }
  },

  timesFor(key) {
    return key === "chl" ? this.chlDates : [this.dates[key]];
  },

  /* ---------- tile loading ---------- */

  regionJobs(cfg) {
    const z = cfg.sampleZoom;
    const b = CONFIG.bounds;
    const x0 = Math.floor(this.lonToPxX(b.lonMin - 1, z) / 256);
    const x1 = Math.floor(this.lonToPxX(b.lonMax + 1, z) / 256);
    const y0 = Math.floor(this.latToPxY(b.latMax + 1, z) / 256);
    const y1 = Math.floor(this.latToPxY(b.latMin - 1, z) / 256);
    const jobs = [];
    for (const t of this.timesFor(cfg.key)) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          jobs.push({ key: cfg.key, time: t, z, x, y });
        }
      }
    }
    return jobs;
  },

  async loadForCompute(onProgress) {
    const all = [];
    for (const cfg of Object.values(CONFIG.layers)) all.push(...this.regionJobs(cfg));
    const total = all.length;
    let done = 0;
    let idx = 0;

    const worker = async () => {
      while (idx < all.length) {
        const j = all[idx++];
        const ck = this.cacheKey(j.key, j.time, j.z, j.x, j.y);
        if (!this.cache.has(ck)) {
          try {
            const img = await loadImage(this.tileUrl(CONFIG.layers[j.key], j.time, j.z, j.x, j.y));
            const c = document.createElement("canvas");
            c.width = c.height = 256;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            this.cache.set(ck, ctx.getImageData(0, 0, 256, 256));
          } catch (e) {
            this.cache.set(ck, null);
          }
        }
        done++;
        if (onProgress) onProgress(done, total, j.key);
      }
    };

    await Promise.all(Array.from({ length: Math.min(8, total) }, worker));

    // a layer whose tiles mostly failed is treated as offline -> synthetic field
    for (const cfg of Object.values(CONFIG.layers)) {
      const jobs = this.regionJobs(cfg);
      let ok = 0;
      for (const j of jobs) {
        const v = this.cache.get(this.cacheKey(j.key, j.time, j.z, j.x, j.y));
        if (v) ok++;
      }
      this.offline[cfg.key] = jobs.length > 0 && ok / jobs.length < 0.5;
    }
  },

  /* ---------- pixel sampling ---------- */

  pixelAt(key, time, lat, lon) {
    const cfg = CONFIG.layers[key];
    const z = cfg.sampleZoom;
    const px = this.lonToPxX(lon, z);
    const py = this.latToPxY(lat, z);
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const img = this.cache.get(this.cacheKey(key, time, z, tx, ty));
    if (!img) return null;
    const lx = Math.min(255, Math.max(0, Math.floor(px - tx * 256)));
    const ly = Math.min(255, Math.max(0, Math.floor(py - ty * 256)));
    const i = (ly * 256 + lx) * 4;
    const d = img.data;
    if (d[i + 3] === 0) return null;
    return Colormap.value(key, d[i], d[i + 1], d[i + 2]);
  },

  /* mean of an NxN lattice inside the cell (across all composite dates) */
  cellMean(key, cell) {
    if (this.offline[key]) {
      const v = synthetic(key, cell.clat, cell.clon);
      return v === null ? { mean: null, n: 0 } : { mean: v, n: 1 };
    }
    const n = CONFIG.grid.subSamples;
    const dLat = (cell.latMax - cell.latMin) / n;
    const dLon = (cell.lonMax - cell.lonMin) / n;
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lat = cell.latMin + (i + 0.5) * dLat;
        const lon = cell.lonMin + (j + 0.5) * dLon;
        for (const t of this.timesFor(key)) {
          const v = this.pixelAt(key, t, lat, lon);
          if (v !== null && isFinite(v)) { sum += v; cnt++; }
        }
      }
    }
    return { mean: cnt ? sum / cnt : null, n: cnt };
  },

  /* ---------- grid ---------- */

  buildGrid(step) {
    const b = CONFIG.bounds;
    const cells = [];
    const rows = Math.round((b.latMax - b.latMin) / step);
    const cols = Math.round((b.lonMax - b.lonMin) / step);
    let id = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const latMin = b.latMin + r * step;
        const lonMin = b.lonMin + c * step;
        cells.push({
          id: ++id,
          row: r, col: c,
          latMin, latMax: latMin + step,
          lonMin, lonMax: lonMin + step,
          clat: latMin + step / 2,
          clon: lonMin + step / 2
        });
      }
    }
    return cells;
  }
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tile load failed: " + url));
    img.src = url;
  });
}

/* Deterministic stand-in fields, used only when GIBS cannot be reached */
function synthetic(key, lat, lon) {
  const w = (x) => (x * Math.PI) / 180;
  if (key === "sst") {
    return 29.6 - (lat - 5) * 0.17 +
      0.6 * Math.sin(w(lon * 0.5)) + 0.4 * Math.cos(w(lat * 0.8)) +
      0.5 * Math.sin(w((lon + lat) * 1.4));
  }
  if (key === "sss") {
    const plume = 15 * Math.exp(-(Math.pow((lat - 21) / 4.5, 2) + Math.pow((lon - 89.5) / 5.5, 2)));
    const west = 2.5 * Math.exp(-(Math.pow((lat - 13) / 3, 2) + Math.pow((lon - 80.5) / 2, 2)));
    return Math.max(12, 34.6 - (lat - 5) * 0.12 - plume - west + 0.4 * Math.sin(w(lon * 2 + lat)));
  }
  const coastal = 3.0 * Math.exp(-Math.pow((lat - 20) / 4, 2));
  const river = 1.6 * Math.exp(-Math.pow((lon - 88) / 6, 2));
  const westUp = 1.1 * Math.exp(-(Math.pow((lat - 15.5) / 3, 2) + Math.pow((lon - 80.5) / 2.5, 2)));
  const v = 0.3 + coastal + river + westUp + 0.15 * Math.sin(w(lon * 3)) * Math.cos(w(lat * 2));
  return Math.min(20, Math.max(0.02, v));
}
