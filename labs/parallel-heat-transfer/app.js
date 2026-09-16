"use strict";

// This browser model is a direct port of reactor_simulation10(3).py.
// The teaching trials and all numerical constants are intentionally unchanged.
const SIGMA = 5.670374419e-8;
const AMBIENT_C = 25.0;
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

const TRIALS = Object.freeze({
  1: { caseName: "Case A", processC: 400, insulationM: 0.100, conductivity: 0.080, emissivity: 0.00, h: 8.0 },
  2: { caseName: "Case A", processC: 400, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 0.0 },
  3: { caseName: "Case A", processC: 400, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
  4: { caseName: "Case A", processC: 600, insulationM: 0.000, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
  5: { caseName: "Case A", processC: 600, insulationM: 0.100, conductivity: 0.080, emissivity: 0.85, h: 8.0 },
  6: { caseName: "Case A", processC: 600, insulationM: 0.150, conductivity: 0.080, emissivity: 0.85, h: 8.0 }
});

const SAFETY_INPUTS = Object.freeze({
  caseName: "Case B",
  processC: 800,
  conductivity: 0.080,
  emissivity: 0.85,
  h: 8.0
});

const COLORS = Object.freeze({
  navy: "#0f3047",
  teal: "#008d83",
  tealPale: "#dcefeb",
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

function defaultState() {
  return {
    stage: 1,
    trials: {},
    safetyStep: 20,
    exploredSteps: [20]
  };
}

// Student work exists only in this page's memory. Opening or reloading the
// experiment always creates a fresh, independent session.
let state = defaultState();
let toastTimer = null;
let resizeTimer = null;

function saveState() {
  updateNavigation();
}

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
  toastTimer = setTimeout(() => element.classList.remove("show"), 2200);
}

function trialRecord(number, inputs) {
  return {
    trial: number,
    ...inputs,
    result: solveInsulatedVessel(inputs),
    recordedAt: new Date().toISOString()
  };
}

function stageComplete(stage) {
  if (stage === 1) return [1, 2, 3].every(number => state.trials[number]);
  if (stage === 2) return [4, 5, 6].every(number => state.trials[number]);
  return Boolean(state.trials[7] && state.trials[8]);
}

function recordCount() {
  return Object.keys(state.trials).filter(key => state.trials[key]).length;
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

function stageHeader(stage, title, description, chip) {
  return `<div class="stage-heading">
    <div>
      <div class="stage-number">EXPERIMENT ${stage} OF 3</div>
      <h2>${title}</h2>
      <p>${description}</p>
    </div>
    <div class="stage-heading-actions">
      <div class="stage-chip">${chip}</div>
      <button class="stage-reset" id="resetStage" type="button" aria-label="Reset experiment ${stage}">
        <span aria-hidden="true">↻</span> Reset experiment
      </button>
    </div>
  </div>`;
}

function fixedSettings(inputs) {
  return `<div class="settings-grid">
    <div class="setting"><span>Process</span><strong>${format(inputs.processC, 0)} °C</strong></div>
    <div class="setting"><span>Insulation</span><strong>${format(inputs.insulationM, 3)} m</strong></div>
    <div class="setting"><span>k insulation</span><strong>${format(inputs.conductivity, 3)} W/(m·K)</strong></div>
    <div class="setting"><span>Emissivity</span><strong>${format(inputs.emissivity, 2)}</strong></div>
    <div class="setting"><span>h convection</span><strong>${format(inputs.h, 1)} W/(m²·K)</strong></div>
    <div class="setting"><span>Ambient</span><strong>${format(AMBIENT_C, 0)} °C</strong></div>
  </div>`;
}

function temperatureColor(surfaceC) {
  if (!Number.isFinite(surfaceC)) return "#b7c9c9";
  const fraction = Math.min(1, Math.max(0, (surfaceC - 25) / 560));
  if (fraction < 0.35) {
    const t = fraction / 0.35;
    return `rgb(${Math.round(73 + 168 * t)}, ${Math.round(166 + 45 * t)}, ${Math.round(203 - 78 * t)})`;
  }
  const t = (fraction - 0.35) / 0.65;
  return `rgb(${Math.round(241 - 13 * t)}, ${Math.round(211 - 145 * t)}, ${Math.round(125 - 80 * t)})`;
}

function thermalApparatus(inputs, result, running = false) {
  const insulationPx = 7 + Math.round(Math.min(0.5, inputs.insulationM) / 0.5 * 27);
  const surface = result ? result.surfaceC : NaN;
  const surfaceColor = temperatureColor(surface);
  const qTotal = result ? Math.max(Math.abs(result.qTotalW), 1) : 1;
  const convOpacity = result ? Math.min(1, 0.2 + Math.abs(result.qConvW) / qTotal * 0.8) : 0.18;
  const radOpacity = result ? Math.min(1, 0.2 + Math.abs(result.qRadW) / qTotal * 0.8) : 0.18;
  const convWidth = result && result.qConvW !== 0 ? 2 + 5 * Math.abs(result.qConvW) / qTotal : 0;
  const radWidth = result && result.qRadW !== 0 ? 2 + 5 * Math.abs(result.qRadW) / qTotal : 0;
  const outerY = 141 - insulationPx;
  const outerH = 218 + 2 * insulationPx;
  const outerRx = 102 + insulationPx;
  const tLabel = format(inputs.insulationM, 3);
  const surfaceLabel = result ? `${format(surface, 1)} °C` : "— °C";
  const wallLabel = result ? `${format(result.wallOuterC, 1)} °C` : "— °C";
  const status = result ? (surface <= SAFETY_LIMIT_C ? "Surface at or below 60 °C" : "Surface above 60 °C") : "Ready for a trial";
  return `<svg class="thermal-apparatus ${running ? "running" : ""}" viewBox="0 0 900 480" role="img" aria-label="Horizontal insulated vessel showing radial conduction through steel and insulation and parallel convection and radiation from the outer surface">
    <title>Insulated process vessel heat-transfer apparatus</title>
    <defs>
      <linearGradient id="processHeat" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff0a8"/><stop offset=".52" stop-color="#f3983e"/><stop offset="1" stop-color="#d95531"/>
      </linearGradient>
      <linearGradient id="steelShell" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#eaf1f3"/><stop offset=".35" stop-color="#879ca7"/><stop offset=".7" stop-color="#d6e1e4"/><stop offset="1" stop-color="#6b818c"/>
      </linearGradient>
      <linearGradient id="insulationShell" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f8fbfb"/><stop offset=".42" stop-color="${surfaceColor}" stop-opacity=".72"/><stop offset="1" stop-color="#cbdadd"/>
      </linearGradient>
      <filter id="vesselShadow" x="-20%" y="-30%" width="140%" height="180%"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#0f3047" flood-opacity=".17"/></filter>
      <marker id="arrowBlue" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#2575aa"/></marker>
      <marker id="arrowOrange" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#ed8a3a"/></marker>
      <marker id="arrowGray" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#486571"/></marker>
    </defs>
    <rect width="900" height="480" rx="20" fill="#eaf3f1"/>
    <path d="M75 395 H830" stroke="#c2d3d3" stroke-width="3"/>
    <g filter="url(#vesselShadow)">
      <rect x="118" y="${outerY}" width="585" height="${outerH}" rx="${outerRx}" fill="url(#insulationShell)" stroke="#557b87" stroke-width="3"/>
      <rect x="137" y="154" width="547" height="192" rx="92" fill="url(#steelShell)" stroke="#304e5d" stroke-width="3"/>
      <rect x="155" y="170" width="511" height="160" rx="78" fill="url(#processHeat)" stroke="#a1482b" stroke-width="2"/>
      <path d="M183 207 C282 187 542 187 638 209" fill="none" stroke="#fff7cf" stroke-width="8" opacity=".55"/>
      <ellipse class="thermal-pulse" cx="410" cy="250" rx="230" ry="65" fill="#ffe474"/>
    </g>
    <g>
      <path d="M228 351 L207 395 H288 L270 351" fill="#496574"/>
      <path d="M548 351 L528 395 H609 L589 351" fill="#496574"/>
      <rect x="196" y="393" width="103" height="10" rx="4" fill="#304e5d"/>
      <rect x="517" y="393" width="103" height="10" rx="4" fill="#304e5d"/>
      <path d="M333 154 V105 H378 V154" fill="url(#steelShell)" stroke="#304e5d" stroke-width="3"/>
      <rect x="323" y="90" width="65" height="16" rx="6" fill="#54717f"/>
    </g>
    <g>
      <line x1="410" y1="250" x2="410" y2="${outerY - 9}" stroke="#486571" stroke-width="2.5" marker-end="url(#arrowGray)"/>
      <text x="423" y="119" class="apparatus-label">RADIAL CONDUCTION</text>
      <text x="423" y="135" class="minor">steel wall + insulation in series</text>
    </g>
    <g style="--air-opacity:${convOpacity}">
      <path class="air-line" d="M218 ${outerY - 12} C198 ${outerY - 42} 237 ${outerY - 55} 215 ${outerY - 86}" stroke-width="${convWidth}" stroke-dasharray="8 7" marker-end="url(#arrowBlue)"/>
      <path class="air-line" d="M287 ${outerY - 10} C267 ${outerY - 39} 308 ${outerY - 57} 286 ${outerY - 90}" stroke-width="${convWidth}" stroke-dasharray="8 7" marker-end="url(#arrowBlue)"/>
      <text x="194" y="42" class="apparatus-label" style="fill:#2575aa">CONVECTION</text>
      <text x="194" y="58" class="minor">h = ${format(inputs.h, 1)} W/(m²·K)</text>
    </g>
    <g style="--ray-opacity:${radOpacity}">
      <path class="heat-ray" d="M512 ${outerY - 7} L536 ${outerY - 74}" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
      <path class="heat-ray" d="M570 ${outerY - 5} L604 ${outerY - 69}" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
      <path class="heat-ray" d="M628 ${outerY + 4} L672 ${outerY - 53}" stroke-width="${radWidth}" marker-end="url(#arrowOrange)"/>
      <text x="553" y="42" class="apparatus-label" style="fill:#d36b21">RADIATION</text>
      <text x="553" y="58" class="minor">ε = ${format(inputs.emissivity, 2)}</text>
    </g>
    <g>
      <rect x="726" y="113" width="143" height="116" rx="16" fill="#0f3047"/>
      <text x="744" y="139" style="fill:#b7cbd3;font-size:10px;letter-spacing:.09em">SURFACE SENSOR</text>
      <text x="851" y="178" text-anchor="end" style="fill:#f6c843;font:700 26px Consolas,monospace">${surfaceLabel}</text>
      <text x="744" y="205" style="fill:#d6e4e8;font-size:10px">${status}</text>
      <path d="M726 173 C702 173 701 193 682 193" fill="none" stroke="#66828e" stroke-width="2"/>
      <circle cx="682" cy="193" r="6" fill="${surfaceColor}" stroke="#0f3047" stroke-width="2"/>
    </g>
    <g transform="translate(750 286)">
      <circle cx="48" cy="48" r="45" fill="#f8fbfb" stroke="#6d9199" stroke-width="3"/>
      <circle cx="48" cy="48" r="37" fill="${surfaceColor}" opacity=".75" stroke="#54717f" stroke-width="5"/>
      <circle cx="48" cy="48" r="30" fill="#aebdc4" stroke="#4d6570" stroke-width="6"/>
      <circle cx="48" cy="48" r="23" fill="#ed8a3a"/>
      <line x1="48" y1="2" x2="48" y2="95" stroke="#0f3047" stroke-width="1.5" stroke-dasharray="3 4" opacity=".6"/>
      <text x="48" y="112" text-anchor="middle" class="apparatus-label">RADIAL CROSS-SECTION</text>
    </g>
    <g>
      <text x="410" y="246" text-anchor="middle" class="apparatus-label" style="fill:#6b2c20">PROCESS FLUID · ${format(inputs.processC, 0)} °C</text>
      <text x="410" y="268" text-anchor="middle" class="minor" style="fill:#7d392a">inner steel-surface boundary</text>
      <text x="410" y="326" text-anchor="middle" class="minor">steel outer surface ${wallLabel}</text>
      <text x="410" y="375" text-anchor="middle" class="apparatus-label">INSULATION t = ${tLabel} m · k = ${format(inputs.conductivity, 3)} W/(m·K)</text>
      <text x="786" y="433" text-anchor="middle" class="apparatus-label">AMBIENT AIR · ${format(AMBIENT_C, 0)} °C</text>
      <text x="786" y="449" text-anchor="middle" class="minor">straight cylindrical section only</text>
    </g>
  </svg>`;
}

function apparatusPanel(inputs, result, title = "Insulated process vessel") {
  const statusClass = result ? (result.surfaceC <= SAFETY_LIMIT_C ? "ready" : "hot") : "";
  const statusTitle = result ? "Steady state solved" : "Apparatus ready";
  const statusCopy = result ? `${format(result.qTotalW / 1000, 3)} kW leaves the cylindrical shell` : "Run a trial to calculate the steady state.";
  return `<section class="panel">
    <div class="apparatus-wrap">${thermalApparatus(inputs, result)}</div>
    <div class="apparatus-readout">
      <div class="apparatus-status"><i class="status-light ${statusClass}"></i><div><strong>${title}</strong><small>${statusTitle} · ${statusCopy}</small></div></div>
      <div class="digital-readout"><span>OUTER-SURFACE TEMPERATURE</span><strong>${result ? `${format(result.surfaceC, 2)} °C` : "—"}</strong></div>
    </div>
  </section>`;
}

function resultMetrics(result) {
  if (!result) {
    return `<div class="metric-row">
      <div class="metric primary"><span>Surface temperature</span><strong>—</strong></div>
      <div class="metric"><span>Total heat loss</span><strong>—</strong></div>
      <div class="metric"><span>Outer area</span><strong>—</strong></div>
    </div>`;
  }
  return `<div class="metric-row">
    <div class="metric primary"><span>Surface temperature</span><strong>${format(result.surfaceC, 2)} <small>°C</small></strong></div>
    <div class="metric"><span>Total heat loss</span><strong>${format(kw(result.qTotalW), 3)} <small>kW</small></strong></div>
    <div class="metric"><span>Outer area</span><strong>${format(result.areaOuterM2, 2)} <small>m²</small></strong></div>
  </div>`;
}

function trialsTable(numbers, includeStatus = false) {
  const rows = numbers.map(number => {
    const record = state.trials[number];
    if (!record) return `<tr><td>Trial ${number}</td><td colspan="${includeStatus ? 11 : 10}" class="pending">Not recorded</td></tr>`;
    const r = record.result;
    const status = r.surfaceC <= SAFETY_LIMIT_C ? "PASS" : "FAIL";
    return `<tr>
      <td>Trial ${number}</td>
      <td>${format(record.processC, 0)}</td>
      <td>${format(record.insulationM, 3)}</td>
      <td>${format(record.conductivity, 3)}</td>
      <td>${format(record.emissivity, 2)}</td>
      <td>${format(record.h, 1)}</td>
      <td>${format(r.surfaceC, 2)}</td>
      <td>${format(kw(r.qCondW), 3)}</td>
      <td>${format(kw(r.qConvW), 3)}</td>
      <td>${format(kw(r.qRadW), 3)}</td>
      <td>${format(kw(r.qTotalW), 3)}</td>
      ${includeStatus ? `<td class="status-cell ${status === "PASS" ? "pass" : "fail"}">${status}</td>` : ""}
    </tr>`;
  }).join("");
  return `<div class="data-table-wrap"><table class="data-table">
    <thead><tr><th>Run</th><th>T<sub>in</sub> (°C)</th><th>t (m)</th><th>k (W/m·K)</th><th>ε</th><th>h (W/m²·K)</th><th>T<sub>s</sub> (°C)</th><th>Q̇<sub>cond</sub> (kW)</th><th>Q̇<sub>conv</sub> (kW)</th><th>Q̇<sub>rad</sub> (kW)</th><th>Q̇<sub>total</sub> (kW)</th>${includeStatus ? "<th>Safety</th>" : ""}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function trialCards(numbers, instructions) {
  return `<div class="settings-card">
    <div class="settings-title"><div><div class="section-label">TRIAL SETTINGS</div><h4>${instructions}</h4></div></div>
    ${numbers.map(number => {
      const inputs = TRIALS[number];
      const saved = Boolean(state.trials[number]);
      return `<div class="trial-row" data-trial="${number}">
        <div class="settings-title"><h4>Trial ${number}</h4><span class="trial-badge ${saved ? "saved" : ""}">${saved ? "Recorded" : "Ready"}</span></div>
        ${fixedSettings(inputs)}
        <div class="trial-actions"><button class="button ${saved ? "button-secondary" : ""} run-trial" data-trial="${number}" type="button">${saved ? `Run Trial ${number} again` : `Run and record Trial ${number}`}</button></div>
      </div>`;
    }).join("")}
  </div>`;
}

function parallelNetwork() {
  return `<div class="network" aria-label="Heat transfer resistance network">
    <svg viewBox="0 0 620 120" role="img">
      <title>Conduction in series with parallel convection and radiation</title>
      <circle class="node" cx="35" cy="60" r="7"/><circle class="node" cx="288" cy="60" r="7"/><circle class="node" cx="580" cy="60" r="7"/>
      <path class="path" d="M42 60 H281"/><rect x="117" y="41" width="90" height="38" rx="9" fill="#fff" stroke="#9bb2b7"/>
      <text x="162" y="64" text-anchor="middle">R<tspan baseline-shift="sub" font-size="8">steel+ins</tspan></text>
      <path class="path conv" d="M295 60 C355 60 352 24 413 24 H573"/><path class="path rad" d="M295 60 C355 60 352 96 413 96 H573"/>
      <rect x="411" y="7" width="100" height="34" rx="9" fill="#fff" stroke="#7db1d1"/><text x="461" y="28" text-anchor="middle">Convection</text>
      <rect x="411" y="79" width="100" height="34" rx="9" fill="#fff" stroke="#e7a879"/><text x="461" y="100" text-anchor="middle">Radiation</text>
      <text x="35" y="91" text-anchor="middle">T<tspan baseline-shift="sub" font-size="8">in</tspan></text><text x="288" y="91" text-anchor="middle">T<tspan baseline-shift="sub" font-size="8">s</tspan></text><text x="580" y="91" text-anchor="middle">T<tspan baseline-shift="sub" font-size="8">∞</tspan></text>
    </svg>
  </div>`;
}

function renderStage1() {
  const numbers = [1, 2, 3];
  const latest = [...numbers].reverse().find(number => state.trials[number]);
  const inputs = latest ? TRIALS[latest] : TRIALS[1];
  const result = latest ? state.trials[latest].result : null;
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(1, "Convection and radiation act in parallel", "Run the three worksheet conditions. Keep the vessel, process temperature, insulation, and ambient conditions fixed while the external heat-transfer paths change.", "Case A · Trials 1–3")}
    <div class="stage-grid">
      <div>
        ${apparatusPanel(inputs, result, latest ? `Trial ${latest} apparatus` : "Case A apparatus")}
        <section class="panel panel-pad" style="margin-top:20px">
          <div class="panel-title"><div><h3>Results to record</h3><p>Copy these calculated values into Table 1 of the worksheet.</p></div></div>
          ${trialsTable(numbers)}
        </section>
      </div>
      <div class="panel panel-pad">
        <div class="panel-title"><div><h3>Run the three heat-loss trials</h3><p>The blue and orange paths show convection and radiation leaving the same outer-surface node.</p></div></div>
        ${parallelNetwork()}
        ${trialCards(numbers, "Change only ε and h as specified.")}
        ${resultMetrics(result)}
        <div class="chart-frame compact"><canvas id="parallelChart" aria-label="Convection, radiation, and total heat loss for Trials 1 through 3"></canvas>${latest ? "" : '<div class="chart-placeholder">Run a trial to begin the heat-path comparison.</div>'}</div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.blue}"></i>Convection</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.orange}"></i>Radiation</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.navy}"></i>Total</span></div>
        <div class="continue-row"><button class="button" id="continueStage" ${stageComplete(1) ? "" : "disabled"} type="button">Continue to series conduction</button></div>
      </div>
    </div>
  </div>`;
  bindCommonStage(1);
  bindTrialButtons(numbers);
  document.getElementById("continueStage").addEventListener("click", () => navigate(2));
  drawParallelChart();
}

function renderStage2() {
  const numbers = [4, 5, 6];
  const latest = [...numbers].reverse().find(number => state.trials[number]);
  const inputs = latest ? TRIALS[latest] : TRIALS[4];
  const result = latest ? state.trials[latest].result : null;
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(2, "Steel and insulation resist heat flow in series", "Run the bare vessel and the two insulated conditions. The external environment is unchanged; only insulation thickness changes.", "Case A · Trials 4–6")}
    <div class="stage-grid analysis-grid">
      <div>
        ${apparatusPanel(inputs, result, latest ? `Trial ${latest} apparatus` : "Series-resistance apparatus")}
        <div class="panel panel-pad" style="margin-top:20px">
          <div class="panel-title"><div><h3>Run the thickness trials</h3><p>Use the exact three thicknesses specified in Table 2.</p></div></div>
          ${trialCards(numbers, "Change only insulation thickness.")}
          ${resultMetrics(result)}
        </div>
      </div>
      <div>
        <section class="panel chart-panel">
          <div class="panel-title"><div><h3>Effect of insulation thickness</h3><p>Recorded trial points share the same axes for direct comparison.</p></div></div>
          <div class="chart-frame"><canvas id="seriesChart" aria-label="Surface temperature and total heat loss versus insulation thickness"></canvas>${latest ? "" : '<div class="chart-placeholder">Run Trials 4–6 to build the thickness comparison.</div>'}</div>
          <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.teal}"></i>Surface temperature</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.orange}"></i>Total heat loss</span></div>
        </section>
        <section class="panel panel-pad" style="margin-top:20px">
          <div class="panel-title"><div><h3>Results to record</h3><p>Copy these values into Table 2 of the worksheet.</p></div></div>
          ${trialsTable(numbers)}
          <div class="continue-row"><button class="button" id="continueStage" ${stageComplete(2) ? "" : "disabled"} type="button">Continue to the safety limit</button></div>
        </section>
      </div>
    </div>
  </div>`;
  bindCommonStage(2);
  bindTrialButtons(numbers);
  document.getElementById("continueStage").addEventListener("click", () => navigate(3));
  drawSeriesChart();
}

function safetyInputsForStep(step) {
  return { ...SAFETY_INPUTS, insulationM: step * STEP_M };
}

function isFirstSafeStep(step) {
  const current = solveInsulatedVessel(safetyInputsForStep(step));
  if (current.surfaceC > SAFETY_LIMIT_C + 1e-9) return false;
  if (step === 0) return true;
  const lower = solveInsulatedVessel(safetyInputsForStep(step - 1));
  return lower.surfaceC > SAFETY_LIMIT_C + 1e-9;
}

function recordSafetyTrial(number) {
  const inputs = safetyInputsForStep(state.safetyStep);
  const result = solveInsulatedVessel(inputs);
  if (number === 7 && !isFirstSafeStep(state.safetyStep)) {
    toast(result.surfaceC <= SAFETY_LIMIT_C ? "This setting is safe, but it is not the first selectable safe thickness." : "Increase the thickness until the surface first reaches 60 °C or below.");
    return;
  }
  if (number === 8) {
    const trial7 = state.trials[7];
    const requiredStep = trial7 ? Math.round(trial7.insulationM / STEP_M) - 1 : null;
    if (!trial7 || state.safetyStep !== requiredStep || result.surfaceC <= SAFETY_LIMIT_C) {
      toast("Trial 8 must be exactly 0.005 m below Trial 7 and must fail the 60 °C limit.");
      return;
    }
  }
  if (number === 7) delete state.trials[8];
  state.trials[number] = trialRecord(number, inputs);
  saveState();
  renderStage3();
  toast(`Trial ${number} recorded.`);
}

function renderStage3() {
  const inputs = safetyInputsForStep(state.safetyStep);
  const result = solveInsulatedVessel(inputs);
  const safe = result.surfaceC <= SAFETY_LIMIT_C + 1e-9;
  const firstSafe = isFirstSafeStep(state.safetyStep);
  const trial7 = state.trials[7];
  const trial7Step = trial7 ? Math.round(trial7.insulationM / STEP_M) : null;
  const expectedTrial8Step = trial7Step === null ? null : trial7Step - 1;
  const validTrial8 = trial7 && state.safetyStep === expectedTrial8Step && !safe;
  const pointer = Math.min(100, Math.max(0, result.surfaceC / 100 * 100));
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(3, "Find the minimum selectable safe thickness", "Use 0.005 m increments to find the first insulation setting with an outer-surface temperature at or below 60 °C. Then test exactly one increment lower.", "Case B · Trials 7–8")}
    <div class="safety-layout">
      <div>
        ${apparatusPanel(inputs, result, "Case B safety apparatus")}
        <section class="panel panel-pad" style="margin-top:20px">
          <div class="panel-title"><div><h3>Select insulation thickness</h3><p>The selector moves only in exact 0.005 m increments.</p></div></div>
          <div class="control-card">
            <div class="value-heading"><span>Current selectable thickness</span><strong>${format(inputs.insulationM, 3)} m</strong></div>
            <input class="range" id="thicknessRange" type="range" min="0" max="100" step="1" value="${state.safetyStep}" aria-label="Insulation thickness in 0.005 metre increments">
            <div class="range-scale"><span>0.000 m</span><span>0.250 m</span><span>0.500 m</span></div>
            <div class="nudge-row">
              <button class="nudge" id="minusStep" type="button" aria-label="Decrease insulation by 0.005 metres" ${state.safetyStep === 0 ? "disabled" : ""}>−</button>
              <div class="increment-readout"><strong>${state.safetyStep} × 0.005 m</strong><span>exact selectable increment</span></div>
              <button class="nudge" id="plusStep" type="button" aria-label="Increase insulation by 0.005 metres" ${state.safetyStep === 100 ? "disabled" : ""}>+</button>
            </div>
            <div class="safety-banner ${safe ? "pass" : ""}"><strong>${safe ? "PASS · surface at or below limit" : "FAIL · surface above limit"}</strong><span>${format(result.surfaceC, 2)} °C</span></div>
            <div class="safety-meter"><div class="safety-track"></div><div class="safety-pointer" style="--pointer:${pointer}%"></div><div class="safety-labels"><span>cooler</span><span>60 °C limit</span><span>hotter</span></div></div>
            <div class="record-grid">
              <button class="button" id="recordTrial7" type="button" ${firstSafe ? "" : "disabled"}>${trial7 ? "Update Trial 7" : "Record first passing setting"}</button>
              <button class="button button-secondary" id="oneStepLower" type="button" ${trial7 ? "" : "disabled"}>Set 0.005 m lower</button>
              <button class="button" id="recordTrial8" type="button" ${validTrial8 ? "" : "disabled"}>${state.trials[8] ? "Update Trial 8" : "Record lower setting"}</button>
            </div>
          </div>
          <div class="note ${safe ? "" : "warm"}">${trial7 ? `Trial 7 is recorded at ${format(trial7.insulationM, 3)} m. Now verify the immediately lower selectable setting.` : "Search upward or downward until this is the first selectable setting that passes. The record button activates only at that boundary."}</div>
        </section>
      </div>
      <div>
        <section class="panel chart-panel">
          <div class="panel-title"><div><h3>Surface temperature versus insulation thickness</h3><p>Each setting you test is saved on the graph. The complete model curve appears after both boundary trials are recorded.</p></div></div>
          <div class="chart-frame tall"><canvas id="safetyChart" aria-label="Surface temperature versus insulation thickness with the 60 degree Celsius safety limit"></canvas></div>
          <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.teal}"></i>${stageComplete(3) ? "Model curve" : "Tested settings"}</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.red}"></i>60 °C safety limit</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.yellow}"></i>Current setting</span></div>
        </section>
        <section class="panel panel-pad" style="margin-top:20px">
          <div class="panel-title"><div><h3>Results to record</h3><p>Copy the passing boundary and the one-step-lower result into Table 3.</p></div></div>
          ${trialsTable([7, 8], true)}
          ${stageComplete(3) ? '<div class="note"><strong>Boundary confirmed.</strong> Trial 7 is the minimum selectable safe thickness because Trial 8, exactly 0.005 m lower, exceeds the 60 °C surface limit.</div>' : ""}
        </section>
      </div>
    </div>
  </div>`;
  bindCommonStage(3);
  const range = document.getElementById("thicknessRange");
  range.addEventListener("input", event => setSafetyStep(Number(event.target.value)));
  document.getElementById("minusStep").addEventListener("click", () => setSafetyStep(state.safetyStep - 1));
  document.getElementById("plusStep").addEventListener("click", () => setSafetyStep(state.safetyStep + 1));
  document.getElementById("recordTrial7").addEventListener("click", () => recordSafetyTrial(7));
  document.getElementById("recordTrial8").addEventListener("click", () => recordSafetyTrial(8));
  document.getElementById("oneStepLower").addEventListener("click", () => {
    if (!state.trials[7]) return;
    setSafetyStep(Math.max(0, Math.round(state.trials[7].insulationM / STEP_M) - 1));
  });
  drawSafetyChart();
}

function setSafetyStep(step) {
  state.safetyStep = Math.min(100, Math.max(0, Math.round(step)));
  if (!state.exploredSteps.includes(state.safetyStep)) state.exploredSteps.push(state.safetyStep);
  saveState();
  renderStage3();
}

function bindTrialButtons(numbers) {
  document.querySelectorAll(".run-trial").forEach(button => {
    button.addEventListener("click", () => {
      const number = Number(button.dataset.trial);
      if (!numbers.includes(number)) return;
      button.disabled = true;
      button.textContent = "Solving steady state…";
      const apparatus = document.querySelector(".thermal-apparatus");
      if (apparatus) apparatus.classList.add("running");
      setTimeout(() => {
        state.trials[number] = trialRecord(number, TRIALS[number]);
        saveState();
        if (state.stage === 1) renderStage1();
        else renderStage2();
        toast(`Trial ${number} solved and recorded.`);
      }, 550);
    });
  });
}

function bindCommonStage(stage) {
  const reset = document.getElementById("resetStage");
  reset.addEventListener("click", () => {
    if (stage === 1) [1, 2, 3].forEach(number => delete state.trials[number]);
    if (stage === 2) [4, 5, 6].forEach(number => delete state.trials[number]);
    if (stage === 3) {
      [7, 8].forEach(number => delete state.trials[number]);
      state.safetyStep = 20;
      state.exploredSteps = [20];
    }
    saveState();
    navigate(stage);
    toast(`Experiment ${stage} reset.`);
  });
}

function navigate(stage) {
  state.stage = Number(stage);
  saveState();
  if (state.stage === 1) renderStage1();
  if (state.stage === 2) renderStage2();
  if (state.stage === 3) renderStage3();
  document.getElementById("stageArea").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function prepareCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const bounds = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(300, Math.floor(bounds.width));
  const height = Math.max(220, Math.floor(bounds.height));
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

function chartAxes(prepared, { xMin, xMax, yMin, yMax, xTicks, yTicks, xLabel, yLabel, rightLabel = null }) {
  const { context: ctx, width, height } = prepared;
  const margin = { left: 64, right: rightLabel ? 62 : 20, top: 20, bottom: 52 };
  const plot = { x: margin.left, y: margin.top, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom };
  const x = value => plot.x + (value - xMin) / (xMax - xMin || 1) * plot.width;
  const y = value => plot.y + plot.height - (value - yMin) / (yMax - yMin || 1) * plot.height;
  ctx.font = "12px Inter, Segoe UI, sans-serif";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  yTicks.forEach(value => {
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(plot.x, y(value)); ctx.lineTo(plot.x + plot.width, y(value)); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "right";
    ctx.fillText(String(value), plot.x - 9, y(value));
  });
  xTicks.forEach(value => {
    ctx.strokeStyle = "#edf1f2";
    ctx.beginPath(); ctx.moveTo(x(value), plot.y); ctx.lineTo(x(value), plot.y + plot.height); ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "center";
    ctx.fillText(String(value), x(value), plot.y + plot.height + 18);
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

function drawParallelChart() {
  const prepared = prepareCanvas("parallelChart");
  if (!prepared) return;
  const records = [1, 2, 3].map(number => state.trials[number] || null);
  const max = Math.max(8, ...records.filter(Boolean).map(record => kw(record.result.qTotalW) * 1.18));
  const top = Math.ceil(max / 2) * 2;
  const axes = chartAxes(prepared, { xMin: 0.5, xMax: 3.5, yMin: 0, yMax: top, xTicks: [1, 2, 3], yTicks: [0, top / 4, top / 2, 3 * top / 4, top].map(v => format(v, 1)), xLabel: "Trial", yLabel: "Heat rate (kW)" });
  const { ctx, plot, x } = axes;
  const yValue = value => plot.y + plot.height - value / top * plot.height;
  records.forEach((record, index) => {
    if (!record) return;
    const center = x(index + 1);
    const barWidth = Math.min(42, plot.width / 12);
    const conv = kw(record.result.qConvW);
    const rad = kw(record.result.qRadW);
    const total = kw(record.result.qTotalW);
    [[conv, COLORS.blue, -barWidth], [rad, COLORS.orange, 0]].forEach(([value, color, offset]) => {
      ctx.fillStyle = color;
      ctx.fillRect(center + offset, yValue(value), barWidth - 3, plot.y + plot.height - yValue(value));
    });
    ctx.strokeStyle = COLORS.navy; ctx.fillStyle = COLORS.navy; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(center - barWidth, yValue(total)); ctx.lineTo(center + barWidth, yValue(total)); ctx.stroke();
    ctx.beginPath(); ctx.arc(center, yValue(total), 4.5, 0, Math.PI * 2); ctx.fill();
  });
}

function drawSeriesChart() {
  const prepared = prepareCanvas("seriesChart");
  if (!prepared) return;
  const records = [4, 5, 6].map(number => state.trials[number]).filter(Boolean).sort((a, b) => a.insulationM - b.insulationM);
  const maxTemp = Math.max(650, ...records.map(record => record.result.surfaceC * 1.08));
  const maxQ = Math.max(650, ...records.map(record => kw(record.result.qTotalW) * 1.08));
  const axes = chartAxes(prepared, { xMin: 0, xMax: 0.15, yMin: 0, yMax: maxTemp, xTicks: [0, 0.05, 0.10, 0.15].map(v => v.toFixed(2)), yTicks: [0, 150, 300, 450, 600], xLabel: "Insulation thickness (m)", yLabel: "Surface temperature (°C)", rightLabel: "Total heat loss (kW)" });
  const { ctx, plot } = axes;
  const x = value => plot.x + value / 0.15 * plot.width;
  const yTemp = value => plot.y + plot.height - value / maxTemp * plot.height;
  const yQ = value => plot.y + plot.height - value / maxQ * plot.height;
  const drawSeries = (accessor, y, color) => {
    if (!records.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); records.forEach((record, i) => { const px = x(record.insulationM); const py = y(accessor(record)); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke();
    records.forEach(record => { ctx.beginPath(); ctx.arc(x(record.insulationM), y(accessor(record)), 5, 0, Math.PI * 2); ctx.fill(); });
  };
  drawSeries(record => record.result.surfaceC, yTemp, COLORS.teal);
  drawSeries(record => kw(record.result.qTotalW), yQ, COLORS.orange);
  ctx.fillStyle = COLORS.muted; ctx.font = "11px Inter, Segoe UI, sans-serif"; ctx.textAlign = "left";
  [0, 150, 300, 450, 600].forEach(value => ctx.fillText(String(value), plot.x + plot.width + 8, yQ(value)));
}

function drawSafetyChart() {
  const prepared = prepareCanvas("safetyChart");
  if (!prepared) return;
  const complete = stageComplete(3);
  const steps = complete ? Array.from({ length: 101 }, (_, i) => i) : [...new Set(state.exploredSteps)].sort((a, b) => a - b);
  const points = steps.map(step => ({ step, thickness: step * STEP_M, result: solveInsulatedVessel(safetyInputsForStep(step)) }));
  const axes = chartAxes(prepared, { xMin: 0, xMax: 0.5, yMin: 20, yMax: 800, xTicks: [0, 0.1, 0.2, 0.3, 0.4, 0.5].map(v => v.toFixed(1)), yTicks: [20, 60, 200, 400, 600, 800], xLabel: "Insulation thickness (m)", yLabel: "Outer-surface temperature (°C)" });
  const { ctx, plot } = axes;
  const x = value => plot.x + value / 0.5 * plot.width;
  const y = value => plot.y + plot.height - (value - 20) / 780 * plot.height;
  ctx.strokeStyle = COLORS.red; ctx.lineWidth = 2; ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.moveTo(plot.x, y(60)); ctx.lineTo(plot.x + plot.width, y(60)); ctx.stroke(); ctx.setLineDash([]);
  if (complete && points.length) {
    ctx.strokeStyle = COLORS.teal; ctx.lineWidth = 3; ctx.beginPath();
    points.forEach((point, i) => { if (i === 0) ctx.moveTo(x(point.thickness), y(point.result.surfaceC)); else ctx.lineTo(x(point.thickness), y(point.result.surfaceC)); }); ctx.stroke();
  } else {
    ctx.fillStyle = COLORS.teal;
    points.forEach(point => { ctx.beginPath(); ctx.arc(x(point.thickness), y(point.result.surfaceC), 4.2, 0, Math.PI * 2); ctx.fill(); });
  }
  const current = solveInsulatedVessel(safetyInputsForStep(state.safetyStep));
  ctx.fillStyle = COLORS.yellow; ctx.strokeStyle = COLORS.navy; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x(state.safetyStep * STEP_M), y(current.surfaceC), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  [7, 8].forEach(number => {
    const record = state.trials[number];
    if (!record) return;
    ctx.fillStyle = number === 7 ? COLORS.green : COLORS.red; ctx.beginPath(); ctx.arc(x(record.insulationM), y(record.result.surfaceC), 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLORS.navy; ctx.font = "700 11px Inter, Segoe UI, sans-serif"; ctx.textAlign = number === 7 ? "left" : "right"; ctx.fillText(`Trial ${number}`, x(record.insulationM) + (number === 7 ? 9 : -9), y(record.result.surfaceC) - 11);
  });
}

function dataDialogHtml() {
  const numbers = Object.keys(state.trials).map(Number).sort((a, b) => a - b);
  if (!numbers.length) return '<div class="empty-state"><strong>No trials recorded yet.</strong><br>Run an experiment and its result will remain available here.</div>';
  return `<p class="note" style="margin-top:0">All results in this table were generated from this browser session and remain available while you move between experiments.</p>${trialsTable(numbers, true)}`;
}

function downloadCsv() {
  const records = Object.values(state.trials).filter(Boolean).sort((a, b) => a.trial - b.trial);
  if (!records.length) {
    toast("Record at least one trial before downloading data.");
    return;
  }
  const header = ["trial", "case", "process_C", "ambient_C", "insulation_m", "conductivity_W_mK", "emissivity", "h_W_m2K", "surface_C", "wall_outer_C", "q_cond_kW", "q_conv_kW", "q_rad_kW", "q_total_kW", "outer_area_m2", "safety_status"];
  const rows = records.map(record => {
    const r = record.result;
    return [record.trial, record.caseName, record.processC, AMBIENT_C, format(record.insulationM, 3), format(record.conductivity, 3), format(record.emissivity, 2), format(record.h, 1), format(r.surfaceC, 6), format(r.wallOuterC, 6), format(kw(r.qCondW), 6), format(kw(r.qConvW), 6), format(kw(r.qRadW), 6), format(kw(r.qTotalW), 6), format(r.areaOuterM2, 6), r.surfaceC <= SAFETY_LIMIT_C ? "PASS" : "FAIL"];
  });
  const csv = [header, ...rows].map(row => row.map(escapeCsv).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "parallel_heat_transfer_run_data.csv";
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
    if (!window.confirm("Clear all eight trial results and reset the current session?")) return;
    state = defaultState();
    saveState();
    dataDialog.close();
    navigate(1);
    toast("Session data cleared.");
  });
  [dataDialog, modelDialog].forEach(dialog => dialog.addEventListener("click", event => {
    const bounds = dialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) dialog.close();
  }));
}

function renderCurrentStage() {
  if (state.stage === 1) renderStage1();
  if (state.stage === 2) renderStage2();
  if (state.stage === 3) renderStage3();
}

function init() {
  document.querySelectorAll(".step").forEach(button => button.addEventListener("click", () => navigate(Number(button.dataset.stage))));
  bindDialogs();
  renderCurrentStage();
  updateNavigation();
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.stage === 1) drawParallelChart();
      if (state.stage === 2) drawSeriesChart();
      if (state.stage === 3) drawSafetyChart();
    }, 120);
  });
}

const MODEL_API = { SIGMA, GEOMETRY, TRIALS, SAFETY_INPUTS, STEP_M, solveInsulatedVessel, isFirstSafeStep };
if (typeof globalThis !== "undefined") globalThis.ParallelHeatTransferModel = MODEL_API;
if (typeof module !== "undefined" && module.exports) module.exports = MODEL_API;
if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", init);
