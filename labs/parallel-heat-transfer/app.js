"use strict";

// Direct browser port of reactor_simulation10(3).py. The geometry, governing
// equations, constants, and input limits match the original Streamlit model.
const SIGMA = 5.670374419e-8;
const AMBIENT_C = 25.0;
const MAX_PROCESS_C = 800.0;
const MAX_INSULATION_M = 0.50;
const MAX_CONVECTION = 50.0;
const SAFETY_LIMIT_C = 60.0;
const STEP_M = 0.005;

const GEOMETRY = Object.freeze({
  nominalVolumeM3: 5.0,
  innerDiameterM: 1.0,
  straightLengthM: 6.0,
  overallLengthM: 6.55,
  headDepthM: 0.25,
  bareHeightM: 1.05,
  wallThicknessM: 0.025,
  steelConductivity: 45.0
});

const INPUTS = Object.freeze([
  { key: "processC", label: "Internal process temperature", symbol: "Tᵢₙ", unit: "°C", min: 0, max: MAX_PROCESS_C, step: 5, digits: 0 },
  { key: "insulationM", label: "Insulation thickness", symbol: "t", unit: "m", min: 0, max: MAX_INSULATION_M, step: STEP_M, digits: 3 },
  { key: "conductivity", label: "Insulation conductivity", symbol: "k", unit: "W/(m·K)", min: 0.02, max: 0.20, step: 0.005, digits: 3 },
  { key: "emissivity", label: "Outer-surface emissivity", symbol: "ε", unit: "", min: 0, max: 1, step: 0.01, digits: 2 },
  { key: "h", label: "External convection coefficient", symbol: "h", unit: "W/(m²·K)", min: 0, max: MAX_CONVECTION, step: 0.5, digits: 1 }
]);

const INPUT_BY_KEY = Object.freeze(Object.fromEntries(INPUTS.map(definition => [definition.key, definition])));

const STAGES = Object.freeze({
  1: {
    title: "Convection and radiation act in parallel",
    description: "Enter your own operating conditions, then compare how convection and radiation leave the same outer-surface node.",
    chip: "Case A · parallel paths",
    defaultInputs: { processC: 400, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
    worksheetTitle: "Worksheet route · Table 1",
    worksheetText: "Keep Tᵢₙ = 400 °C, t = 0.100 m, and k = 0.080 W/(m·K). Enter and run (ε, h) = (0.00, 8), (0.85, 0), and (0.85, 8). You can then explore any values within the displayed ranges.",
    chartTitle: "Parallel heat-loss paths",
    chartText: "Each recorded run adds convection, radiation, and total heat transfer to the comparison."
  },
  2: {
    title: "Steel and insulation resist heat flow in series",
    description: "Change the insulation thickness or any operating input and observe the live temperature profile through the vessel layers.",
    chip: "Case A · series conduction",
    defaultInputs: { processC: 600, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
    worksheetTitle: "Worksheet route · Table 2",
    worksheetText: "Use Tᵢₙ = 600 °C, k = 0.080 W/(m·K), ε = 0.85, and h = 8 W/(m²·K). Enter and run t = 0.000, 0.100, and 0.150 m. Additional settings may be explored.",
    chartTitle: "Effect of insulation thickness",
    chartText: "Recorded points compare outer-surface temperature and total heat transfer against insulation thickness."
  },
  3: {
    title: "Find a safe insulation design",
    description: "Adjust the design live and determine the first 0.005 m insulation setting that keeps the touchable surface at or below 60 °C.",
    chip: "Case B · safety search",
    defaultInputs: { processC: 800, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
    worksheetTitle: "Worksheet route · Table 3",
    worksheetText: "Use Tᵢₙ = 800 °C, k = 0.080 W/(m·K), ε = 0.85, and h = 8 W/(m²·K). Change t in exact 0.005 m steps until the first passing setting is found, then test one step lower.",
    chartTitle: "Surface temperature versus insulation thickness",
    chartText: "The full model curve updates for the current Tᵢₙ, k, ε, and h. Recorded runs appear as individual points."
  }
});

const COLORS = Object.freeze({
  navy: "#0f3047",
  teal: "#008d83",
  blue: "#2575aa",
  orange: "#ed8a3a",
  yellow: "#c69000",
  red: "#ce493f",
  green: "#38875a",
  grid: "#d9e3e4",
  muted: "#607680"
});

function cToK(value) {
  return Number(value) + 273.15;
}

function solveInsulatedVessel({
  processC,
  ambientC = AMBIENT_C,
  emissivity,
  lengthM = GEOMETRY.straightLengthM,
  diameterM = GEOMETRY.innerDiameterM,
  insulationM,
  conductivity,
  h
}) {
  const processK = cToK(processC);
  const ambientK = cToK(ambientC);
  const t = Math.max(Number(insulationM), 0);
  const epsilon = Math.min(1, Math.max(0, Number(emissivity)));
  const convection = Math.max(Number(h), 0);
  const k = Math.max(Number(conductivity), 1e-12);

  const rInner = diameterM / 2;
  const rWallOuter = rInner + GEOMETRY.wallThicknessM;
  const rOuter = rWallOuter + t;
  const areaOuter = 2 * Math.PI * rOuter * lengthM;
  const areaBare = Math.PI * (2 * rWallOuter) * lengthM;
  const resistanceSteel = Math.log(rWallOuter / rInner) /
    (2 * Math.PI * lengthM * GEOMETRY.steelConductivity);
  const resistanceInsulation = t <= 1e-12 ? 0 :
    Math.log(rOuter / rWallOuter) / (2 * Math.PI * lengthM * k);
  const resistanceCond = resistanceSteel + resistanceInsulation;

  const externalHeatRate = surfaceK => ({
    qConv: convection * areaOuter * (surfaceK - ambientK),
    qRad: epsilon * SIGMA * areaOuter * (surfaceK ** 4 - ambientK ** 4)
  });

  let surfaceK;
  if (Math.abs(processK - ambientK) <= 1e-12) {
    surfaceK = processK;
  } else if (epsilon <= 1e-12 && convection <= 1e-12) {
    surfaceK = processK;
  } else {
    let low = Math.min(processK, ambientK);
    let high = Math.max(processK, ambientK);
    for (let index = 0; index < 64; index += 1) {
      const trialK = 0.5 * (low + high);
      const qCondTrial = (processK - trialK) / resistanceCond;
      const external = externalHeatRate(trialK);
      const residual = qCondTrial - external.qConv - external.qRad;
      if (residual > 0) low = trialK;
      else high = trialK;
    }
    surfaceK = 0.5 * (low + high);
  }

  let { qConv, qRad } = externalHeatRate(surfaceK);
  let qTotal = qConv + qRad;
  let qCond = (processK - surfaceK) / resistanceCond;
  const wallOuterK = processK - qCond * resistanceSteel;
  if (Math.abs(qTotal) < 1e-9) qTotal = 0;
  if (Math.abs(qCond) < 1e-9) qCond = 0;
  if (Math.abs(qConv) < 1e-9) qConv = 0;
  if (Math.abs(qRad) < 1e-9) qRad = 0;

  return {
    processC: Number(processC),
    wallOuterC: wallOuterK - 273.15,
    surfaceC: surfaceK - 273.15,
    ambientC: Number(ambientC),
    qTotalW: qTotal,
    qCondW: qCond,
    qConvW: qConv,
    qRadW: qRad,
    rInnerM: rInner,
    rWallOuterM: rWallOuter,
    rOuterM: rOuter,
    outerDiameterM: 2 * rOuter,
    areaBareM2: areaBare,
    areaOuterM2: areaOuter,
    resistanceSteelKW: resistanceSteel,
    resistanceInsulationKW: resistanceInsulation,
    resistanceCondKW: resistanceCond
  };
}

function cloneInputs(inputs) {
  return { ...inputs };
}

function defaultState() {
  return {
    stage: 1,
    inputs: {
      1: cloneInputs(STAGES[1].defaultInputs),
      2: cloneInputs(STAGES[2].defaultInputs),
      3: cloneInputs(STAGES[3].defaultInputs)
    },
    records: { 1: [], 2: [], 3: [] }
  };
}

// Student work remains only in this page's memory. A new tab or reload starts
// with a separate, empty session.
let state = defaultState();
let toastTimer = null;
let resizeTimer = null;

function format(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function kw(valueW) {
  return Number(valueW) / 1000;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toast(message) {
  const element = document.getElementById("toast");
  if (!element) return;
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
}

function stageComplete(stage) {
  return state.records[stage].length > 0;
}

function recordCount() {
  return Object.values(state.records).reduce((total, records) => total + records.length, 0);
}

function updateNavigation() {
  document.querySelectorAll(".step").forEach(button => {
    const stage = Number(button.dataset.stage);
    button.classList.toggle("active", stage === state.stage);
    button.classList.toggle("complete", stageComplete(stage));
  });
  const count = document.getElementById("dataCount");
  if (count) count.textContent = recordCount();
}

function stageHeader(stage) {
  const config = STAGES[stage];
  return `<div class="stage-heading">
    <div>
      <div class="stage-number">EXPERIMENT ${stage} OF 3</div>
      <h2>${config.title}</h2>
      <p>${config.description}</p>
    </div>
    <div class="stage-heading-actions">
      <div class="stage-chip">${config.chip}</div>
      <button class="stage-reset" id="resetStage" type="button" aria-label="Reset experiment ${stage}">
        <span aria-hidden="true">↻</span> Reset experiment
      </button>
    </div>
  </div>`;
}

function fixedParameters() {
  return `<div class="fixed-basis-card" aria-label="Fixed vessel and boundary parameters">
    <div class="section-label">FIXED MODEL BASIS</div>
    <div class="fixed-basis-grid">
      <div><span>Ambient</span><strong>${format(AMBIENT_C, 0)} °C</strong></div>
      <div><span>Inner diameter</span><strong>${format(GEOMETRY.innerDiameterM, 2)} m</strong></div>
      <div><span>Straight length</span><strong>${format(GEOMETRY.straightLengthM, 2)} m</strong></div>
      <div><span>Steel wall</span><strong>${format(GEOMETRY.wallThicknessM, 3)} m</strong></div>
      <div><span>Steel k</span><strong>${format(GEOMETRY.steelConductivity, 0)} W/(m·K)</strong></div>
      <div><span>Safety limit</span><strong>${format(SAFETY_LIMIT_C, 0)} °C</strong></div>
    </div>
  </div>`;
}

function inputControl(stage, definition, value) {
  const id = `stage-${stage}-${definition.key}`;
  const unit = definition.unit ? `<span>${definition.unit}</span>` : "";
  return `<div class="variable-control" data-key="${definition.key}">
    <div class="variable-heading">
      <label for="${id}-number"><strong>${definition.label}</strong><small>${definition.symbol}</small></label>
      <div class="number-with-unit">
        <input id="${id}-number" class="variable-number" data-number-input="${definition.key}" type="number" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${format(value, definition.digits)}" inputmode="decimal" aria-describedby="${id}-range-text">
        ${unit}
      </div>
    </div>
    <input id="${id}-range" class="variable-range" data-range-input="${definition.key}" type="range" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${value}" aria-label="${definition.label}">
    <div class="input-range-text" id="${id}-range-text"><span>${format(definition.min, definition.digits)}${definition.unit ? ` ${definition.unit}` : ""}</span><span>step ${format(definition.step, definition.digits)}</span><span>${format(definition.max, definition.digits)}${definition.unit ? ` ${definition.unit}` : ""}</span></div>
  </div>`;
}

function controlsPanel(stage) {
  const config = STAGES[stage];
  const values = state.inputs[stage];
  return `<section class="panel panel-pad simulator-controls-panel">
    <div class="panel-title">
      <div><h3>Enter experimental conditions</h3><p>Type a value or move its slider. The vessel and calculated preview update immediately.</p></div>
      <span class="live-badge"><i></i> Live model</span>
    </div>
    <div class="worksheet-guide">
      <strong>${config.worksheetTitle}</strong>
      <p>${config.worksheetText}</p>
    </div>
    <div class="variable-stack">
      ${INPUTS.map(definition => inputControl(stage, definition, values[definition.key])).join("")}
    </div>
    ${fixedParameters()}
    <div class="run-actions">
      <button class="button run-current" id="runCurrent" type="button">Run and record current settings</button>
      <p>The preview is live. Clicking Run stores one snapshot in this tab's session data.</p>
    </div>
  </section>`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [0, 2, 4].map(index => Number.parseInt(normalized.slice(index, index + 2), 16));
}

function mixColor(start, end, fraction) {
  const a = hexToRgb(start);
  const b = hexToRgb(end);
  const t = Math.min(1, Math.max(0, fraction));
  return `rgb(${a.map((value, index) => Math.round(value + (b[index] - value) * t)).join(",")})`;
}

function temperatureColor(temperatureC) {
  if (!Number.isFinite(temperatureC)) return "#aebfc6";
  const fraction = Math.min(1, Math.max(0, (temperatureC - AMBIENT_C) / (MAX_PROCESS_C - AMBIENT_C)));
  const stops = [
    [0.00, "#2f86c4"],
    [0.22, "#6fc2e5"],
    [0.45, "#c6eaf7"],
    [0.64, "#fff4be"],
    [0.82, "#ff9737"],
    [1.00, "#dc2626"]
  ];
  for (let index = 1; index < stops.length; index += 1) {
    if (fraction <= stops[index][0]) {
      const [leftPoint, leftColor] = stops[index - 1];
      const [rightPoint, rightColor] = stops[index];
      return mixColor(leftColor, rightColor, (fraction - leftPoint) / (rightPoint - leftPoint));
    }
  }
  return stops.at(-1)[1];
}

function thermalApparatus(inputs, result) {
  const insulationPx = Math.round(Math.min(MAX_INSULATION_M, inputs.insulationM) / MAX_INSULATION_M * 38);
  const ringPx = Math.round(Math.min(MAX_INSULATION_M, inputs.insulationM) / MAX_INSULATION_M * 28);
  const outerX = 118 - insulationPx;
  const outerY = 146 - insulationPx;
  const outerWidth = 543 + insulationPx * 2;
  const outerHeight = 168 + insulationPx * 2;
  const outerRadius = 84 + insulationPx;
  const processColor = temperatureColor(inputs.processC);
  const wallColor = temperatureColor(result.wallOuterC);
  const surfaceColor = temperatureColor(result.surfaceC);
  const totalMagnitude = Math.max(Math.abs(result.qConvW) + Math.abs(result.qRadW), 1);
  const convWidth = result.qConvW === 0 ? 0 : 2.5 + 5.5 * Math.abs(result.qConvW) / totalMagnitude;
  const radWidth = result.qRadW === 0 ? 0 : 2.5 + 5.5 * Math.abs(result.qRadW) / totalMagnitude;
  const outerRing = 58 + ringPx;
  const insulationShape = inputs.insulationM > 1e-12
    ? `<rect x="${outerX}" y="${outerY}" width="${outerWidth}" height="${outerHeight}" rx="${outerRadius}" fill="url(#insulationThermal)" stroke="#3f6977" stroke-width="3"/>`
    : "";
  const insulationRing = inputs.insulationM > 1e-12
    ? `<circle cx="810" cy="225" r="${outerRing}" fill="url(#radialInsulation)" stroke="#3f6977" stroke-width="3"/>`
    : "";

  return `<svg class="thermal-apparatus" viewBox="0 0 940 430" role="img" aria-label="Live insulated vessel. Layer thickness and thermal colors change with the entered operating conditions.">
    <title>Live temperature and insulation response of the process vessel</title>
    <defs>
      <linearGradient id="fluidThermal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff8d7"/><stop offset=".45" stop-color="${processColor}"/><stop offset="1" stop-color="${mixColor(processColor, "#d95531", .34)}"/>
      </linearGradient>
      <linearGradient id="steelThermal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#edf3f5"/><stop offset=".42" stop-color="${wallColor}"/><stop offset="1" stop-color="#647b86"/>
      </linearGradient>
      <linearGradient id="insulationThermal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${mixColor(wallColor, "#ffffff", .40)}"/><stop offset=".48" stop-color="${surfaceColor}"/><stop offset="1" stop-color="${mixColor(surfaceColor, "#304e5d", .25)}"/>
      </linearGradient>
      <radialGradient id="radialInsulation"><stop offset=".58" stop-color="${wallColor}"/><stop offset="1" stop-color="${surfaceColor}"/></radialGradient>
      <filter id="vesselShadow" x="-20%" y="-30%" width="140%" height="180%"><feDropShadow dx="0" dy="9" stdDeviation="9" flood-color="#0f3047" flood-opacity=".17"/></filter>
      <marker id="arrowBlue" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#2575aa"/></marker>
      <marker id="arrowOrange" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#ed8a3a"/></marker>
    </defs>
    <rect width="940" height="430" rx="22" fill="#edf5f3"/>
    <path d="M56 362 H704" stroke="#c6d7d7" stroke-width="3"/>
    <g filter="url(#vesselShadow)">
      ${insulationShape}
      <rect x="126" y="154" width="527" height="152" rx="76" fill="url(#steelThermal)" stroke="#304e5d" stroke-width="3"/>
      <rect x="142" y="170" width="495" height="120" rx="60" fill="url(#fluidThermal)" stroke="#8e3f29" stroke-width="2.5"/>
      <path d="M173 199 C277 181 512 181 605 201" fill="none" stroke="#fff" stroke-width="7" opacity=".40"/>
    </g>
    <g aria-hidden="true">
      <path d="M223 305 L205 362 H279 L263 305" fill="#496574"/>
      <path d="M521 305 L503 362 H577 L561 305" fill="#496574"/>
      <rect x="196" y="359" width="94" height="10" rx="4" fill="#304e5d"/>
      <rect x="494" y="359" width="94" height="10" rx="4" fill="#304e5d"/>
      <path d="M329 154 V115 H369 V154" fill="url(#steelThermal)" stroke="#304e5d" stroke-width="3"/>
      <rect x="319" y="102" width="60" height="14" rx="6" fill="#54717f"/>
    </g>
    <g class="convection-flow" opacity="${result.qConvW === 0 ? 0 : .95}">
      <path d="M210 ${outerY - 7} C190 ${outerY - 31} 227 ${outerY - 47} 207 ${outerY - 72}" fill="none" stroke="#2575aa" stroke-width="${convWidth}" stroke-dasharray="8 7" marker-end="url(#arrowBlue)"/>
      <path d="M280 ${outerY - 7} C260 ${outerY - 31} 297 ${outerY - 47} 277 ${outerY - 72}" fill="none" stroke="#2575aa" stroke-width="${convWidth}" stroke-dasharray="8 7" marker-end="url(#arrowBlue)"/>
    </g>
    <g class="radiation-flow" opacity="${result.qRadW === 0 ? 0 : .95}">
      <path d="M492 ${outerY - 2} L519 ${outerY - 64}" fill="none" stroke="#ed8a3a" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
      <path d="M555 ${outerY - 2} L591 ${outerY - 59}" fill="none" stroke="#ed8a3a" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
      <path d="M616 ${outerY + 7} L661 ${outerY - 46}" fill="none" stroke="#ed8a3a" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
    </g>
    <g aria-hidden="true">
      ${insulationRing}
      <circle cx="810" cy="225" r="58" fill="${wallColor}" stroke="#304e5d" stroke-width="5"/>
      <circle cx="810" cy="225" r="49" fill="${processColor}" stroke="#7f3b29" stroke-width="2.5"/>
      <circle cx="810" cy="225" r="8" fill="#fff" opacity=".42"/>
      <path d="M716 335 H898" stroke="#c6d7d7" stroke-width="3"/>
    </g>
  </svg>`;
}

function visualPanel(inputs, result) {
  const safe = result.surfaceC <= SAFETY_LIMIT_C + 1e-9;
  return `<section class="panel live-visual-panel">
    <div class="visual-stat-strip">
      <div><span>Process</span><strong>${format(inputs.processC, 0)} °C</strong></div>
      <div><span>Steel outer face</span><strong>${format(result.wallOuterC, 1)} °C</strong></div>
      <div class="${safe ? "safe-value" : "hot-value"}"><span>Touchable surface</span><strong>${format(result.surfaceC, 1)} °C</strong></div>
      <div><span>Ambient</span><strong>${format(AMBIENT_C, 0)} °C</strong></div>
    </div>
    <div class="apparatus-wrap live-apparatus-wrap">${thermalApparatus(inputs, result)}</div>
    <div class="visual-key" aria-label="Vessel layer and heat-path legend">
      <span><i class="key-process"></i>Process fluid</span>
      <span><i class="key-steel"></i>Steel wall · 25 mm</span>
      <span><i class="key-insulation"></i>Insulation · ${format(inputs.insulationM * 1000, 0)} mm</span>
      <span><i class="key-convection"></i>Convection</span>
      <span><i class="key-radiation"></i>Radiation</span>
    </div>
    <div class="temperature-scale" aria-label="Thermal color scale from ambient to process temperature">
      <span>Ambient ${format(AMBIENT_C, 0)} °C</span><i></i><span>Process ${format(inputs.processC, 0)} °C</span>
    </div>
  </section>`;
}

function resultMetrics(result) {
  return `<div class="result-grid">
    <div class="result-card primary"><span>Outer-surface temperature</span><strong>${format(result.surfaceC, 2)} <small>°C</small></strong></div>
    <div class="result-card"><span>Total heat transfer</span><strong>${format(kw(result.qTotalW), 3)} <small>kW</small></strong></div>
    <div class="result-card"><span>Conduction</span><strong>${format(kw(result.qCondW), 3)} <small>kW</small></strong></div>
    <div class="result-card path-conv"><span>Convection</span><strong>${format(kw(result.qConvW), 3)} <small>kW</small></strong></div>
    <div class="result-card path-rad"><span>Radiation</span><strong>${format(kw(result.qRadW), 3)} <small>kW</small></strong></div>
    <div class="result-card"><span>Outside diameter</span><strong>${format(result.outerDiameterM, 3)} <small>m</small></strong></div>
  </div>`;
}

function safetyAnalysis(inputs) {
  const points = [];
  let firstSafe = null;
  for (let step = 0; step <= Math.round(MAX_INSULATION_M / STEP_M); step += 1) {
    const thickness = step * STEP_M;
    const result = solveInsulatedVessel({ ...inputs, insulationM: thickness });
    const point = { step, thickness, result };
    points.push(point);
    if (!firstSafe && result.surfaceC <= SAFETY_LIMIT_C + 1e-9) firstSafe = point;
  }
  return { points, firstSafe };
}

function safetySummary(inputs, result) {
  const passed = result.surfaceC <= SAFETY_LIMIT_C + 1e-9;
  const analysis = safetyAnalysis(inputs);
  const boundary = analysis.firstSafe;
  let boundaryText = `No selectable thickness up to ${format(MAX_INSULATION_M, 3)} m meets the limit for these conditions.`;
  if (boundary) {
    const lower = boundary.step > 0 ? analysis.points[boundary.step - 1] : null;
    boundaryText = `First selectable safe thickness: <strong>${format(boundary.thickness, 3)} m</strong> (${format(boundary.result.surfaceC, 2)} °C).${lower ? ` One step lower, ${format(lower.thickness, 3)} m, gives ${format(lower.result.surfaceC, 2)} °C.` : ""}`;
  }
  return `<div class="safety-summary ${passed ? "pass" : "fail"}">
    <div><span>Selected design</span><strong>${passed ? "PASS" : "FAIL"}</strong></div>
    <p>Surface = <strong>${format(result.surfaceC, 2)} °C</strong>; requirement is Tₛ ≤ ${format(SAFETY_LIMIT_C, 0)} °C.</p>
    <p>${boundaryText}</p>
  </div>`;
}

function liveOutput(stage) {
  const inputs = state.inputs[stage];
  const result = solveInsulatedVessel(inputs);
  return `<div class="simulation-output">
    <div id="liveVisual">${visualPanel(inputs, result)}</div>
    <section class="panel panel-pad live-results-panel">
      <div class="panel-title"><div><h3>Live calculated results</h3><p>Steady radial conduction equals convection plus radiation at the outer surface.</p></div><span class="preview-label">PREVIEW</span></div>
      <div id="liveMetrics">${resultMetrics(result)}</div>
      ${stage === 3 ? `<div id="liveSafety">${safetySummary(inputs, result)}</div>` : ""}
    </section>
  </div>`;
}

function recordsTable(records, { includeStage = false, includeStatus = false } = {}) {
  if (!records.length) {
    return '<div class="empty-records"><strong>No runs recorded yet.</strong><span>Enter conditions, inspect the live preview, and click Run and record.</span></div>';
  }
  const rows = records.map(record => {
    const result = record.result;
    const status = result.surfaceC <= SAFETY_LIMIT_C + 1e-9 ? "PASS" : "FAIL";
    return `<tr>
      ${includeStage ? `<td>Experiment ${record.stage}</td>` : ""}
      <td>Run ${record.run}</td>
      <td>${format(record.processC, 0)}</td>
      <td>${format(record.insulationM, 3)}</td>
      <td>${format(record.conductivity, 3)}</td>
      <td>${format(record.emissivity, 2)}</td>
      <td>${format(record.h, 1)}</td>
      <td>${format(result.surfaceC, 2)}</td>
      <td>${format(kw(result.qCondW), 3)}</td>
      <td>${format(kw(result.qConvW), 3)}</td>
      <td>${format(kw(result.qRadW), 3)}</td>
      <td>${format(kw(result.qTotalW), 3)}</td>
      ${includeStatus ? `<td class="status-cell ${status === "PASS" ? "pass" : "fail"}">${status}</td>` : ""}
    </tr>`;
  }).join("");
  return `<div class="data-table-wrap"><table class="data-table">
    <thead><tr>${includeStage ? "<th>Experiment</th>" : ""}<th>Run</th><th>T<sub>in</sub> (°C)</th><th>t (m)</th><th>k (W/m·K)</th><th>ε</th><th>h (W/m²·K)</th><th>T<sub>s</sub> (°C)</th><th>Q̇<sub>cond</sub> (kW)</th><th>Q̇<sub>conv</sub> (kW)</th><th>Q̇<sub>rad</sub> (kW)</th><th>Q̇<sub>total</sub> (kW)</th>${includeStatus ? "<th>Safety</th>" : ""}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function evidenceSection(stage) {
  const config = STAGES[stage];
  const records = state.records[stage];
  const chartId = stage === 1 ? "parallelChart" : stage === 2 ? "seriesChart" : "safetyChart";
  const chartLabel = stage === 1
    ? "Convection, radiation, and total heat transfer for recorded student runs"
    : stage === 2
      ? "Surface temperature and total heat transfer versus insulation thickness"
      : "Surface temperature versus insulation thickness with the 60 degree Celsius safety limit";
  const legend = stage === 1
    ? `<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.blue}"></i>Convection</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.orange}"></i>Radiation</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.navy}"></i>Total</span>`
    : stage === 2
      ? `<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.teal}"></i>Surface temperature</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.orange}"></i>Total heat transfer</span>`
      : `<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.teal}"></i>Model curve</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.red}"></i>60 °C limit</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.yellow}"></i>Current setting</span>`;
  return `<div class="evidence-grid">
    <section class="panel chart-panel">
      <div class="panel-title"><div><h3>${config.chartTitle}</h3><p>${config.chartText}</p></div></div>
      <div class="chart-frame interactive-chart"><canvas id="${chartId}" aria-label="${chartLabel}"></canvas>${stage !== 3 && !records.length ? '<div class="chart-placeholder">Record a run to start this comparison.</div>' : ""}</div>
      <div class="legend">${legend}</div>
    </section>
    <section class="panel panel-pad records-panel">
      <div class="panel-title"><div><h3>Recorded student runs</h3><p>Enter as many conditions as needed. Copy the worksheet runs into the matching table, then continue exploring.</p></div><span class="record-count">${records.length} recorded</span></div>
      ${recordsTable(records, { includeStatus: stage === 3 })}
    </section>
  </div>`;
}

function renderStage(stage) {
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(stage)}
    <div class="interactive-stage-grid">
      ${controlsPanel(stage)}
      ${liveOutput(stage)}
    </div>
    ${evidenceSection(stage)}
    <div class="continue-row">
      ${stage > 1 ? `<button class="button button-secondary" id="previousStage" type="button">← Previous experiment</button>` : "<span></span>"}
      ${stage < 3 ? `<button class="button" id="continueStage" type="button">Continue to experiment ${stage + 1} →</button>` : '<a class="button" href="../../">Return to Virtual Lab home →</a>'}
    </div>
  </div>`;
  bindStage(stage);
  drawStageChart(stage);
  updateNavigation();
}

function snapInput(definition, value) {
  const clamped = Math.min(definition.max, Math.max(definition.min, Number(value)));
  const steps = Math.round((clamped - definition.min) / definition.step);
  return Number((definition.min + steps * definition.step).toFixed(definition.digits));
}

function controlsAreValid() {
  return [...document.querySelectorAll(".variable-number")].every(input => input.checkValidity() && input.value !== "");
}

function updateRunButton() {
  const button = document.getElementById("runCurrent");
  if (button) button.disabled = !controlsAreValid();
}

function refreshLiveOutputs(stage) {
  if (state.stage !== stage || !controlsAreValid()) {
    updateRunButton();
    return;
  }
  const inputs = state.inputs[stage];
  const result = solveInsulatedVessel(inputs);
  const visual = document.getElementById("liveVisual");
  const metrics = document.getElementById("liveMetrics");
  const safety = document.getElementById("liveSafety");
  if (visual) visual.innerHTML = visualPanel(inputs, result);
  if (metrics) metrics.innerHTML = resultMetrics(result);
  if (safety) safety.innerHTML = safetySummary(inputs, result);
  updateRunButton();
  drawStageChart(stage);
}

function bindStage(stage) {
  document.querySelectorAll("[data-range-input]").forEach(range => {
    range.addEventListener("input", event => {
      const key = event.currentTarget.dataset.rangeInput;
      const definition = INPUT_BY_KEY[key];
      const value = snapInput(definition, event.currentTarget.value);
      state.inputs[stage][key] = value;
      const number = document.querySelector(`[data-number-input="${key}"]`);
      number.value = format(value, definition.digits);
      number.setCustomValidity("");
      number.classList.remove("invalid");
      refreshLiveOutputs(stage);
    });
  });

  document.querySelectorAll("[data-number-input]").forEach(number => {
    const key = number.dataset.numberInput;
    const definition = INPUT_BY_KEY[key];
    number.addEventListener("input", event => {
      const raw = event.currentTarget.value;
      const value = Number(raw);
      const valid = raw !== "" && Number.isFinite(value) && value >= definition.min && value <= definition.max;
      event.currentTarget.setCustomValidity(valid ? "" : `Enter a value from ${definition.min} to ${definition.max}.`);
      event.currentTarget.classList.toggle("invalid", !valid);
      if (valid) {
        state.inputs[stage][key] = value;
        document.querySelector(`[data-range-input="${key}"]`).value = value;
        refreshLiveOutputs(stage);
      } else {
        updateRunButton();
      }
    });
    number.addEventListener("change", event => {
      if (!event.currentTarget.checkValidity() || event.currentTarget.value === "") return;
      const value = snapInput(definition, event.currentTarget.value);
      state.inputs[stage][key] = value;
      event.currentTarget.value = format(value, definition.digits);
      document.querySelector(`[data-range-input="${key}"]`).value = value;
      refreshLiveOutputs(stage);
    });
  });

  document.getElementById("runCurrent").addEventListener("click", () => recordCurrentRun(stage));
  document.getElementById("resetStage").addEventListener("click", () => resetStage(stage));
  const previous = document.getElementById("previousStage");
  const next = document.getElementById("continueStage");
  if (previous) previous.addEventListener("click", () => navigate(stage - 1));
  if (next) next.addEventListener("click", () => navigate(stage + 1));
  updateRunButton();
}

function recordCurrentRun(stage) {
  if (!controlsAreValid()) {
    toast("Enter a valid value for every variable before recording the run.");
    return;
  }
  const button = document.getElementById("runCurrent");
  button.disabled = true;
  button.textContent = "Solving steady state…";
  const apparatus = document.querySelector(".thermal-apparatus");
  if (apparatus) apparatus.classList.add("running");
  setTimeout(() => {
    const inputs = cloneInputs(state.inputs[stage]);
    const records = state.records[stage];
    records.push({
      stage,
      run: records.length + 1,
      ...inputs,
      result: solveInsulatedVessel(inputs),
      recordedAt: new Date().toISOString()
    });
    renderStage(stage);
    toast(`Experiment ${stage}, Run ${records.length} recorded.`);
  }, 420);
}

function resetStage(stage) {
  const records = state.records[stage];
  if (records.length && !window.confirm(`Clear all ${records.length} recorded run${records.length === 1 ? "" : "s"} from Experiment ${stage}?`)) return;
  state.inputs[stage] = cloneInputs(STAGES[stage].defaultInputs);
  state.records[stage] = [];
  renderStage(stage);
  toast(`Experiment ${stage} reset.`);
}

function navigate(stage) {
  state.stage = Number(stage);
  renderStage(state.stage);
  document.getElementById("stageArea").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function prepareCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const bounds = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(300, Math.floor(bounds.width));
  const height = Math.max(250, Math.floor(bounds.height));
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height };
}

function tickValues(minimum, maximum, count = 5) {
  return Array.from({ length: count }, (_, index) => minimum + (maximum - minimum) * index / (count - 1));
}

function axisLabel(value) {
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return format(value, 0);
  if (magnitude >= 10) return format(value, 1);
  return format(value, 2);
}

function chartAxes(prepared, { xMin, xMax, yMin, yMax, xTicks, yTicks, xLabel, yLabel, rightLabel = null }) {
  const { context: ctx, width, height } = prepared;
  const margin = { left: 67, right: rightLabel ? 67 : 22, top: 18, bottom: 54 };
  const plot = { x: margin.left, y: margin.top, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom };
  const x = value => plot.x + (value - xMin) / (xMax - xMin || 1) * plot.width;
  const y = value => plot.y + plot.height - (value - yMin) / (yMax - yMin || 1) * plot.height;
  ctx.font = "12px Inter, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  yTicks.forEach(value => {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plot.x, y(value)); ctx.lineTo(plot.x + plot.width, y(value)); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "right";
    ctx.fillText(axisLabel(value), plot.x - 9, y(value));
  });
  xTicks.forEach(tick => {
    const value = typeof tick === "object" ? tick.value : tick;
    const label = typeof tick === "object" ? tick.label : axisLabel(tick);
    ctx.strokeStyle = "#edf1f2";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(value), plot.y); ctx.lineTo(x(value), plot.y + plot.height); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    ctx.fillText(label, x(value), plot.y + plot.height + 19);
  });
  ctx.strokeStyle = "#718a94";
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(plot.x, plot.y); ctx.lineTo(plot.x, plot.y + plot.height); ctx.lineTo(plot.x + plot.width, plot.y + plot.height); ctx.stroke();
  ctx.fillStyle = "#385764";
  ctx.font = "700 12px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, plot.x + plot.width / 2, height - 15);
  ctx.save(); ctx.translate(17, plot.y + plot.height / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(yLabel, 0, 0); ctx.restore();
  if (rightLabel) {
    ctx.save(); ctx.translate(width - 15, plot.y + plot.height / 2); ctx.rotate(Math.PI / 2); ctx.fillText(rightLabel, 0, 0); ctx.restore();
  }
  return { ctx, plot, x, y };
}

function paddedBounds(values, minimumSpan = 1) {
  const finite = values.filter(Number.isFinite);
  let minimum = Math.min(0, ...finite);
  let maximum = Math.max(0, ...finite);
  if (maximum - minimum < minimumSpan) {
    maximum += minimumSpan / 2;
    minimum -= minimumSpan / 2;
  }
  const padding = (maximum - minimum) * 0.12;
  return { minimum: minimum - padding, maximum: maximum + padding };
}

function drawParallelChart() {
  const prepared = prepareCanvas("parallelChart");
  if (!prepared) return;
  const records = state.records[1];
  if (!records.length) return;
  const values = records.flatMap(record => [kw(record.result.qConvW), kw(record.result.qRadW), kw(record.result.qTotalW)]);
  const bounds = paddedBounds(values, 1);
  const xMax = Math.max(3.5, records.length + 0.5);
  const every = Math.max(1, Math.ceil(records.length / 10));
  const xTicks = records.filter((_, index) => index % every === 0 || index === records.length - 1).map(record => ({ value: record.run, label: String(record.run) }));
  const axes = chartAxes(prepared, {
    xMin: 0.5,
    xMax,
    yMin: bounds.minimum,
    yMax: bounds.maximum,
    xTicks,
    yTicks: tickValues(bounds.minimum, bounds.maximum),
    xLabel: "Recorded run",
    yLabel: "Heat transfer (kW)"
  });
  const { ctx, plot, x, y } = axes;
  const zeroY = y(0);
  const barWidth = Math.min(20, plot.width / Math.max(records.length * 4.5, 12));
  records.forEach(record => {
    const center = x(record.run);
    const bars = [
      { value: kw(record.result.qConvW), color: COLORS.blue, offset: -barWidth - 1 },
      { value: kw(record.result.qRadW), color: COLORS.orange, offset: 1 }
    ];
    bars.forEach(bar => {
      const valueY = y(bar.value);
      ctx.fillStyle = bar.color;
      ctx.fillRect(center + bar.offset, Math.min(zeroY, valueY), barWidth, Math.max(1, Math.abs(zeroY - valueY)));
    });
    const totalY = y(kw(record.result.qTotalW));
    ctx.fillStyle = COLORS.navy;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(center, totalY, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}

function drawSeriesChart() {
  const prepared = prepareCanvas("seriesChart");
  if (!prepared) return;
  const records = [...state.records[2]].sort((a, b) => a.insulationM - b.insulationM || a.run - b.run);
  if (!records.length) return;
  const qBounds = paddedBounds(records.map(record => kw(record.result.qTotalW)), 1);
  const axes = chartAxes(prepared, {
    xMin: 0,
    xMax: MAX_INSULATION_M,
    yMin: 0,
    yMax: MAX_PROCESS_C,
    xTicks: [0, .1, .2, .3, .4, .5],
    yTicks: [0, 200, 400, 600, 800],
    xLabel: "Insulation thickness (m)",
    yLabel: "Surface temperature (°C)",
    rightLabel: "Total heat transfer (kW)"
  });
  const { ctx, plot, x, y } = axes;
  const yQ = value => plot.y + plot.height - (value - qBounds.minimum) / (qBounds.maximum - qBounds.minimum) * plot.height;
  tickValues(qBounds.minimum, qBounds.maximum).forEach(value => {
    ctx.fillStyle = COLORS.muted;
    ctx.font = "12px Inter, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(axisLabel(value), plot.x + plot.width + 8, yQ(value));
  });
  const drawLine = (valueForRecord, yForValue, color) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    records.forEach((record, index) => {
      const px = x(record.insulationM);
      const py = yForValue(valueForRecord(record));
      if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    if (records.length > 1) ctx.stroke();
    records.forEach(record => {
      ctx.beginPath(); ctx.arc(x(record.insulationM), yForValue(valueForRecord(record)), 5, 0, Math.PI * 2); ctx.fill();
    });
  };
  drawLine(record => record.result.surfaceC, y, COLORS.teal);
  drawLine(record => kw(record.result.qTotalW), yQ, COLORS.orange);
}

function drawSafetyChart() {
  const prepared = prepareCanvas("safetyChart");
  if (!prepared) return;
  const inputs = state.inputs[3];
  const analysis = safetyAnalysis(inputs);
  const axes = chartAxes(prepared, {
    xMin: 0,
    xMax: MAX_INSULATION_M,
    yMin: 0,
    yMax: MAX_PROCESS_C,
    xTicks: [0, .1, .2, .3, .4, .5],
    yTicks: [0, 200, 400, 600, 800],
    xLabel: "Insulation thickness (m)",
    yLabel: "Outer-surface temperature (°C)"
  });
  const { ctx, plot, x, y } = axes;
  ctx.fillStyle = "rgba(56,135,90,.08)";
  ctx.fillRect(plot.x, y(SAFETY_LIMIT_C), plot.width, y(0) - y(SAFETY_LIMIT_C));
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 6]);
  ctx.beginPath(); ctx.moveTo(plot.x, y(SAFETY_LIMIT_C)); ctx.lineTo(plot.x + plot.width, y(SAFETY_LIMIT_C)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.red;
  ctx.font = "700 11px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("60 °C limit", plot.x + plot.width - 5, y(SAFETY_LIMIT_C) - 10);

  ctx.strokeStyle = COLORS.teal;
  ctx.lineWidth = 3;
  ctx.beginPath();
  analysis.points.forEach((point, index) => {
    const px = x(point.thickness);
    const py = y(point.result.surfaceC);
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  const current = solveInsulatedVessel(inputs);
  ctx.fillStyle = COLORS.yellow;
  ctx.strokeStyle = COLORS.navy;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x(inputs.insulationM), y(current.surfaceC), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  state.records[3].forEach(record => {
    const passed = record.result.surfaceC <= SAFETY_LIMIT_C + 1e-9;
    ctx.fillStyle = passed ? COLORS.green : COLORS.red;
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x(record.insulationM), y(record.result.surfaceC), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}

function drawStageChart(stage) {
  if (stage === 1) drawParallelChart();
  if (stage === 2) drawSeriesChart();
  if (stage === 3) drawSafetyChart();
}

function allRecords() {
  return [1, 2, 3].flatMap(stage => state.records[stage]);
}

function dataDialogHtml() {
  const records = allRecords();
  if (!records.length) return '<div class="empty-state"><strong>No runs recorded yet.</strong><br>Each experiment accepts student-entered conditions. Recorded snapshots will appear here.</div>';
  return `<p class="note" style="margin-top:0">These model results exist only in this open tab. Refreshing or closing the page clears them.</p>${recordsTable(records, { includeStage: true, includeStatus: true })}`;
}

function downloadCsv() {
  const records = allRecords();
  if (!records.length) {
    toast("Record at least one run before downloading data.");
    return;
  }
  const header = ["experiment", "run", "process_C", "ambient_C", "insulation_m", "conductivity_W_mK", "emissivity", "h_W_m2K", "surface_C", "wall_outer_C", "q_cond_kW", "q_conv_kW", "q_rad_kW", "q_total_kW", "outer_area_m2", "safety_status"];
  const rows = records.map(record => {
    const result = record.result;
    return [record.stage, record.run, record.processC, AMBIENT_C, format(record.insulationM, 3), format(record.conductivity, 3), format(record.emissivity, 2), format(record.h, 1), format(result.surfaceC, 6), format(result.wallOuterC, 6), format(kw(result.qCondW), 6), format(kw(result.qConvW), 6), format(kw(result.qRadW), 6), format(kw(result.qTotalW), 6), format(result.areaOuterM2, 6), result.surfaceC <= SAFETY_LIMIT_C + 1e-9 ? "PASS" : "FAIL"];
  });
  const csv = [header, ...rows].map(row => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "parallel_heat_transfer_student_runs.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindDialogs() {
  const dataDialog = document.getElementById("dataDialog");
  const modelDialog = document.getElementById("modelDialog");
  document.getElementById("openData").addEventListener("click", () => {
    document.getElementById("dataDialogBody").innerHTML = dataDialogHtml();
    dataDialog.showModal();
  });
  document.getElementById("closeData").addEventListener("click", () => dataDialog.close());
  document.getElementById("openModel").addEventListener("click", () => modelDialog.showModal());
  document.getElementById("closeModel").addEventListener("click", () => modelDialog.close());
  document.getElementById("downloadCsv").addEventListener("click", downloadCsv);
  document.getElementById("clearData").addEventListener("click", () => {
    const count = recordCount();
    if (count && !window.confirm(`Clear all ${count} recorded run${count === 1 ? "" : "s"} and reset the current session?`)) return;
    state = defaultState();
    dataDialog.close();
    renderStage(1);
    toast("Session data cleared.");
  });
  [dataDialog, modelDialog].forEach(dialog => dialog.addEventListener("click", event => {
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  }));
}

function init() {
  document.querySelectorAll(".step").forEach(button => button.addEventListener("click", () => navigate(Number(button.dataset.stage))));
  bindDialogs();
  renderStage(state.stage);
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawStageChart(state.stage), 120);
  });
}

const MODEL_API = {
  SIGMA,
  AMBIENT_C,
  MAX_PROCESS_C,
  MAX_INSULATION_M,
  MAX_CONVECTION,
  SAFETY_LIMIT_C,
  STEP_M,
  GEOMETRY,
  INPUTS,
  STAGES,
  solveInsulatedVessel,
  safetyAnalysis
};

if (typeof globalThis !== "undefined") globalThis.ParallelHeatTransferModel = MODEL_API;
if (typeof module !== "undefined" && module.exports) module.exports = MODEL_API;
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);
