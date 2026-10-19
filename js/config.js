/* Configuration: NASA GIBS (Worldview) layers, grid + HSI parameters */

const CONFIG = {
  worldview: "https://worldview.earthdata.nasa.gov/",
  gibs: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best",

  bounds: { latMin: 5, latMax: 23.5, lonMin: 78, lonMax: 96 },

  base: {
    bathymetry: {
      id: "BlueMarble_ShadedRelief_Bathymetry",
      set: "GoogleMapsCompatible_Level8",
      ext: "jpeg",
      maxNativeZoom: 8,
      title: "Blue Marble / Bathymetry"
    },
    coast: {
      id: "Coastlines",
      set: "GoogleMapsCompatible_Level9",
      ext: "png",
      maxNativeZoom: 9,
      title: "Coastlines"
    },
    labels: {
      id: "Reference_Features",
      set: "GoogleMapsCompatible_Level9",
      ext: "png",
      maxNativeZoom: 9,
      title: "Place labels"
    }
  },

  layers: {
    sst: {
      key: "sst",
      id: "GHRSST_L4_MUR_Sea_Surface_Temperature",
      title: "Sea Surface Temperature",
      short: "SST",
      unit: "°C",
      dec: 2,
      set: "GoogleMapsCompatible_Level7",
      maxNativeZoom: 7,
      sampleZoom: 7,
      defaultDate: "2026-10-17",
      colormap: "https://gibs.earthdata.nasa.gov/colormaps/v1.3/GHRSST_Sea_Surface_Temperature.xml",
      source: "MUR L4 SST (GHRSST), 1 km"
    },
    sss: {
      key: "sss",
      id: "SMAP_L3_Sea_Surface_Salinity_CAP_8Day_RunningMean",
      title: "Sea Surface Salinity",
      short: "SSS",
      unit: "PSU",
      dec: 2,
      set: "GoogleMapsCompatible_Level6",
      maxNativeZoom: 6,
      sampleZoom: 6,
      defaultDate: "2026-10-10",
      colormap: "https://gibs.earthdata.nasa.gov/colormaps/v1.3/SMAP_Sea_Surface_Salinity.xml",
      source: "SMAP CAP 8-day running mean",
      // GIBS renders every value <= 30 PSU as a single class ("<= 30").
      // Map that class to the mid-point of the post-monsoon Bay of Bengal
      // plume range (20-30 PSU) instead of the 0-30 class mid-point.
      binOverrides: { first: 25 }
    },
    chl: {
      key: "chl",
      id: "VIIRS_SNPP_L2_Chlorophyll_A",
      title: "Chlorophyll a Concentration",
      short: "Chl-a",
      unit: "mg/m³",
      dec: 3,
      set: "GoogleMapsCompatible_Level7",
      maxNativeZoom: 7,
      sampleZoom: 6,
      defaultDate: "2026-10-18",
      colormap: "https://gibs.earthdata.nasa.gov/colormaps/v1.3/VIIRS_Chlorophyll.xml",
      source: "VIIRS/SNPP ocean colour L2, 750 m",
      // L2 swaths have cloud/coverage gaps: average this many recent days.
      compositeDays: 6
    }
  },

  grid: {
    step: 0.5,
    steps: [0.25, 0.5, 1],
    subSamples: 3 // NxN sample points per grid cell
  },

  hsi: {
    formula: "HSI = √( 0.40·S_SST² + 0.30·S_SSS² + 0.30·S_Chl² )",
    weights: { sst: 0.4, sss: 0.3, chl: 0.3 },
    params: {
      sst: { min: 20, opt: 28, max: 35, label: "SST" },
      sss: { min: 8, opt: 24, max: 36, label: "Salinity" },
      chl: { min: 0.1, opt: 5, max: 20, label: "Chlorophyll a" }
    },
    stops: [
      [0.0, "#d73027"],
      [0.3, "#fc8d59"],
      [0.5, "#fee08b"],
      [0.7, "#91cf60"],
      [1.0, "#1a9850"]
    ]
  },

  notes: [
    "Layers, colour scales and parameter ranges are taken from NASA Worldview / GIBS (Global Imagery Browse Services).",
    "Salinity: the GIBS SMAP colour scale stores every value ≤ 30 PSU as one class; it is mapped to 25 PSU (Bay of Bengal plume mid-point) for the HSI.",
    "Chlorophyll: daily VIIRS L2 scenes contain cloud gaps, so grid values are the mean of the last 6 available days.",
    "If a variable is missing inside a cell, the weights are re-normalised over the variables that are present (cell flagged 'partial')."
  ]
};
