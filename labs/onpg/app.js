"use strict";

const CALIBRATION = 3.43; // rounded fitted slope, ABS415 [-] = 3.43 [mM^-1] × CONP [mM]; fitted slope in supplied graph = 3.4337
const BACKGROUND_ABS415 = 0.056;
const INITIAL_ONPG = 0.83;
// Concentration scale that preserves the supplied MATLAB cBulk = 0.403 at 0.83 mM.
// This profile-model scale is distinct from the free-enzyme kinetic fit (Km = 2.00 mM).
const PROFILE_CONCENTRATION_SCALE = 2.059220522647014;
const FAST_MODE = new URLSearchParams(location.search).get("fast") === "1";
const RUN_SECONDS = 120;
const SAMPLE_INTERVAL_SECONDS = 10;
const SAMPLE_SCHEDULE = Array.from(
  { length: RUN_SECONDS / SAMPLE_INTERVAL_SECONDS + 1 },
  (_, index) => index * SAMPLE_INTERVAL_SECONDS
);

const COLORS = {
  small: "#008d83",
  large: "#ed8a3a",
  navy: "#0f3047",
  yellow: "#e1ad13",
  series: ["#2678a9", "#e57b38", "#4d9b59", "#3aa7bc", "#8d5bb1", "#b68a12"]
};

const LAB = {
  small: {
    diameter: 2.8,
    times: [0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,230,280,340],
    onp: [0,0.1438865,0.2817730,0.3775248,0.4639362,0.5350993,0.5884468,0.6306596,0.6630213,0.6868794,0.7051560,0.7143901,0.7344468,0.7499291,0.7509716,0.7499787,0.7509645,0.7525177,0.7613901,0.7670213,0.7670213],
    initialRate: 0.017,
    eta: 0.45,
    phi: 2.30,
    biot: 13.5,
    color: COLORS.small
  },
  large: {
    diameter: 4.6,
    times: [0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,210,220,240,260,300,340],
    onp: [0,0.0911915,0.1614113,0.2279362,0.2938227,0.3464681,0.3926099,0.4360142,0.4756241,0.5075248,0.5390284,0.5675887,0.5937021,0.6111702,0.6281915,0.6533333,0.6662908,0.6749433,0.6851702,0.6906241,0.6982979,0.7043617,0.7086454,0.7096950,0.7127943,0.7150213,0.7168369],
    initialRate: 0.009,
    eta: 0.29,
    phi: 3.78,
    biot: 11.6,
    color: COLORS.large
  }
};

const KINETICS = {
  concentrations: [0.621875, 1.24375, 2.4875, 4.975, 9.95, 19.9],
  rates: [0.000702, 0.000789, 0.001316, 0.001404, 0.001754, 0.002281],
  vmax: 0.00226,
  km: 2.00
};

const HIGH_ONPG_MODEL = [39.8,79.6,159.2].map(concentration => ({concentration,rate:KINETICS.vmax*concentration/(KINETICS.km+concentration)})); // equation predictions, not measurements
const WORKSHEET_SAMPLE_INDICES = [0,1,3,6,9,12];
const defaultState = () => ({
  stage: 1,
  beadRuns: {
    small: { elapsed: 0, samples: [], complete: false, armed: false },
    large: { elapsed: 0, samples: [], complete: false, armed: false }
  },
  kinetics: { loaded: false, blanked: false, scanned: false, ratesShown: false },
  curveBuilt: false,
  halfGuide: false,
  designDiameter: 2.8,
  designTrials: []
});

// Student work exists only in this page's memory. Opening or reloading the
// experiment always creates a fresh, independent session.
let state = defaultState();
let cleanupStage = () => {};
let toastTimer = null;

function saveState() {
  updateDataCount();
  updateStepper();
}

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function format(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const rounded = Number(n.toPrecision(3));
  const decimals = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(rounded))));
  return rounded.toFixed(decimals);
}

function labMinutes(seconds) { return seconds / RUN_SECONDS * 340; }
function formatMinutes(value) { return Number(value.toFixed(2)).toString(); }

function formatWhole(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

function lerp(a, b, f) { return a + (b - a) * f; }

function interpolateCurve(dataset, time) {
  if (time <= dataset.times[0]) return dataset.onp[0];
  if (time >= dataset.times.at(-1)) return dataset.onp.at(-1);
  const i = dataset.times.findIndex(t => t >= time);
  const f = (time - dataset.times[i - 1]) / (dataset.times[i] - dataset.times[i - 1]);
  return lerp(dataset.onp[i - 1], dataset.onp[i], f);
}

function crossingTime(dataset, concentration) {
  const i = dataset.onp.findIndex(v => v >= concentration);
  if (i < 1) return NaN;
  const f = (concentration - dataset.onp[i - 1]) / (dataset.onp[i] - dataset.onp[i - 1]);
  return lerp(dataset.times[i - 1], dataset.times[i], f);
}

function beadSummary(key) {
  const d = LAB[key];
  return {
    initialRate: d.initialRate,
    t50: crossingTime(d, INITIAL_ONPG * 0.50),
    t80: crossingTime(d, INITIAL_ONPG * 0.80),
    conversion: 100 * d.onp.at(-1) / INITIAL_ONPG,
    eta: d.eta
  };
}

function updateStepper() {
  const complete = {
    1: state.beadRuns.small.complete,
    2: state.beadRuns.large.complete,
    3: state.beadRuns.small.complete && state.beadRuns.large.complete,
    4: state.kinetics.scanned,
    5: state.curveBuilt,
    6: getAssignedDesigns().three && getAssignedDesigns().six
  };
  document.querySelectorAll(".step").forEach(button => {
    const number = Number(button.dataset.stage);
    button.classList.toggle("active", number === state.stage);
    button.classList.toggle("complete", Boolean(complete[number]));
  });
}

function updateDataCount() {
  const count = state.beadRuns.small.samples.length + state.beadRuns.large.samples.length +
    (state.kinetics.ratesShown ? 6 : 0) + state.designTrials.length;
  document.getElementById("dataCount").textContent = count;
}

function navigate(stage) {
  cleanupStage();
  cleanupStage = () => {};
  state.stage = stage;
  saveState();
  if (stage === 1) renderBeadStage("small");
  if (stage === 2) renderBeadStage("large");
  if (stage === 3) renderComparison();
  if (stage === 4) renderKineticScan();
  if (stage === 5) renderRateCurve();
  if (stage === 6) renderDesign();
  document.getElementById("stageArea").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function stageHeader(stage, title, description, chip) {
  return `<div class="stage-heading">
    <div><div class="stage-number">STAGE ${stage} OF 6</div><h2>${title}</h2><p>${description}</p></div>
    <div class="stage-heading-actions">
      <div class="stage-chip">${chip}</div>
      <button class="stage-reset" id="resetStage" type="button" aria-label="Reset Stage ${stage}">
        <span aria-hidden="true">↻</span> Reset stage
      </button>
    </div>
  </div>`;
}

function bindStageReset(stage) {
  const button = document.getElementById("resetStage");
  if (!button) return;
  button.addEventListener("click", () => {
    const fresh = defaultState();
    if (stage === 1) state.beadRuns.small = fresh.beadRuns.small;
    if (stage === 2) state.beadRuns.large = fresh.beadRuns.large;
    if (stage === 4) {
      state.kinetics = fresh.kinetics;
      state.curveBuilt = false;
      state.halfGuide = false;
    }
    if (stage === 5) {
      state.curveBuilt = false;
      state.halfGuide = false;
    }
    if (stage === 6) {
      state.designDiameter = fresh.designDiameter;
      state.designTrials = [];
    }
    saveState();
    navigate(stage);
    toast(stage === 3 ? "Comparison view refreshed; both reactor runs were preserved." : `Stage ${stage} reset.`);
  });
}

function beadCircles(key) {
  const small = key === "small";
  const cols = small ? 6 : 4;
  const rows = small ? 7 : 6;
  const radius = small ? 7.2 : 10.8;
  const x0 = small ? 369 : 376;
  const y0 = small ? 125 : 132;
  const dx = small ? 21.5 : 30;
  const dy = small ? 36 : 42;
  let circles = "";
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const jitterX = ((r * 13 + c * 7) % 9) - 4;
      const jitterY = ((r * 11 + c * 5) % 11) - 5;
      const dxMove = ((r + c) % 2 ? 1 : -1) * (small ? 5 + (c % 3) : 4 + (c % 2));
      const dyMove = -(small ? 13 + ((r + c) % 4) * 4 : 10 + ((r + c) % 3) * 5);
      const duration = (small ? 2.1 : 2.6) + ((r * cols + c) % 5) * .18;
      const delay = -((r * cols + c) % 9) * .19;
      const cx = x0 + c * dx + jitterX;
      const cy = y0 + r * dy + jitterY;
      circles += `<g class="fluidized-bead" style="--dx:${dxMove}px;--dy:${dyMove}px;--dur:${duration.toFixed(2)}s;--delay:${delay.toFixed(2)}s">
        <circle cx="${cx}" cy="${cy}" r="${radius}" fill="url(#beadProduct)" stroke="#a28d4b" stroke-width="1.8"/>
        <ellipse cx="${cx - radius * .27}" cy="${cy - radius * .3}" rx="${(radius * .28).toFixed(1)}" ry="${(radius * .18).toFixed(1)}" fill="#fff" opacity=".72"/>
      </g>`;
    }
  }
  return circles;
}

function apparatusSvg(key) {
  const diameter = LAB[key].diameter;
  return `<svg class="apparatus" id="apparatus" viewBox="0 0 840 470" role="img" aria-label="Recirculating ONPG bead reactor with reservoir, submerged pump, fluidized bead column, and inline spectrophotometer">
    <title>Recirculating immobilized-enzyme reactor</title>
    <defs>
      <radialGradient id="beadProduct"><stop id="beadCore" offset="0%" stop-color="#ffffff"/><stop id="beadEdge" offset="100%" stop-color="#ffffff"/></radialGradient>
      <linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".5" stop-color="#dceceb" stop-opacity=".38"/><stop offset="1" stop-color="#ffffff" stop-opacity=".84"/></linearGradient>
      <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#0f3047" flood-opacity=".13"/></filter>
    </defs>
    <rect x="0" y="0" width="840" height="470" rx="18" fill="#edf4f2"/>

    <line x1="323" y1="42" x2="323" y2="414" stroke="#708994" stroke-width="9" stroke-linecap="round"/>
    <line x1="323" y1="150" x2="356" y2="150" stroke="#708994" stroke-width="10" stroke-linecap="round"/>
    <line x1="323" y1="352" x2="356" y2="352" stroke="#708994" stroke-width="10" stroke-linecap="round"/>

    <path class="tube" d="M156 350 C238 350 274 416 425 416"/>
    <path class="fluid-stream" id="feedTube" d="M156 350 C238 350 274 416 425 416"/>
    <path class="tube" d="M425 48 C488 48 522 83 565 124 L565 182"/>
    <path class="fluid-stream" id="outletTube" d="M425 48 C488 48 522 83 565 124 L565 182"/>
    <path class="tube" d="M565 120 C646 72 790 103 801 216 C811 318 550 434 210 246 L210 329"/>
    <path class="fluid-stream" id="returnTube" d="M565 120 C646 72 790 103 801 216 C811 318 550 434 210 246 L210 329"/>
    <path class="flow-dash" d="M156 350 C238 350 274 416 425 416 M425 48 C488 48 522 83 565 124 L565 182 M565 120 C646 72 790 103 801 216 C811 318 550 434 210 246"/>

    <g filter="url(#softShadow)">
      <path d="M42 230 L68 410 H216 L240 230 Z" fill="#f9fcfb" stroke="#70a5a2" stroke-width="4"/>
      <path id="reservoirFill" class="reservoir-fill" d="M59 299 Q137 286 224 299 L212 395 H81 Z" fill="#e2f1f3"/>
      <ellipse id="reservoirSurface" cx="141" cy="298" rx="82" ry="10" fill="#e2f1f3" opacity=".92"/>
      <path d="M42 230 Q141 244 240 230" fill="none" stroke="#70a5a2" stroke-width="4"/>
    </g>
    <text class="apparatus-label" x="140" y="261" text-anchor="middle">ONPG / ONP RESERVOIR</text>
    <text class="minor" x="140" y="278" text-anchor="middle">well-mixed recirculating liquid</text>

    <g class="submersible-pump" filter="url(#softShadow)">
      <rect x="112" y="329" width="50" height="43" rx="12" fill="#123951" stroke="#08283a" stroke-width="3"/>
      <circle cx="137" cy="350" r="14" fill="#e7f1f0"/>
      <g class="pump-rotor"><path d="M137 338 L145 355 L129 355 Z" fill="#009688"/><circle cx="137" cy="350" r="3.3" fill="#006d66"/></g>
      <rect x="159" y="343" width="13" height="13" rx="4" fill="#123951"/>
    </g>
    <text class="minor apparatus-label" x="140" y="430" text-anchor="middle">SUBMERSIBLE PUMP</text>

    <g filter="url(#softShadow)">
      <rect x="350" y="68" width="150" height="318" rx="24" fill="url(#glass)" stroke="#5798a5" stroke-width="5"/>
      <rect id="columnWash" class="column-wash" x="359" y="95" width="132" height="266" rx="17" fill="#e2f1f3" opacity=".82"/>
      <path d="M361 109 H489 M361 346 H489" stroke="#789ba1" stroke-width="2" stroke-dasharray="5 5" opacity=".75"/>
    </g>
    ${beadCircles(key)}
    <rect x="340" y="50" width="170" height="50" rx="18" fill="#187e9f"/>
    <rect x="340" y="357" width="170" height="50" rx="18" fill="#187e9f"/>
    <rect x="386" y="34" width="78" height="28" rx="12" fill="#e8f2f1" stroke="#5798a5" stroke-width="4"/>
    <rect x="386" y="397" width="78" height="28" rx="12" fill="#e8f2f1" stroke="#5798a5" stroke-width="4"/>
    <text class="apparatus-label" x="425" y="441" text-anchor="middle">IMMOBILIZED-ENZYME REACTOR</text>
    <text class="minor" x="425" y="456" text-anchor="middle">${diameter.toFixed(1)} mm fluidized beads</text>

    <g filter="url(#softShadow)">
      <rect x="548" y="112" width="36" height="78" rx="7" fill="#f9fcfb" stroke="#70a5a2" stroke-width="4"/>
      <rect id="flowCell" x="554" y="149" width="24" height="33" rx="3" fill="#e2f1f3"/>
      <path d="M553 126 H579" stroke="#d6e4e3" stroke-width="2"/>
    </g>
    <text class="minor apparatus-label" x="566" y="207" text-anchor="middle">CUVETTE</text>
    <text class="minor" x="566" y="220" text-anchor="middle">inline flow cell</text>

    <path class="sensor-wire" d="M584 164 C594 164 595 192 608 192"/>
    <circle class="sensor-port" cx="584" cy="164" r="3.5"/>

    <g filter="url(#softShadow)">
      <rect x="602" y="180" width="180" height="128" rx="22" fill="#123951"/>
      <rect x="622" y="202" width="140" height="58" rx="9" fill="#061d2b" stroke="#557181" stroke-width="3"/>
      <text x="634" y="220" fill="#a9c2cc" style="fill:#a9c2cc;font-size:9.5px;letter-spacing:.09em">ABS<tspan baseline-shift="sub" font-size="7">415</tspan></text>
      <text id="spectroValue" x="750" y="249" text-anchor="end" fill="#f6c843" style="fill:#f6c843;font:700 25px Consolas,monospace">0.000</text>
      <rect x="625" y="277" width="54" height="14" rx="5" fill="#dce9e8"/>
      <circle cx="748" cy="283" r="11" fill="#718a97"/>
    </g>
    <text class="apparatus-label" x="692" y="332" text-anchor="middle">INLINE SPECTROPHOTOMETER</text>
    <text class="minor" x="692" y="349" text-anchor="middle">yellow ONP measured at 415 nm</text>
  </svg>`;
}

function sampleRows(samples) {
  if (!samples.length) return `<tr><td colspan="3" class="pending">No readings yet. Set the automatic 28.33-min sequence to record the zero baseline.</td></tr>`;
  return samples.map(s => `<tr><td>${formatMinutes(s.laboratoryMinutes)}</td><td>${format(s.a415)}</td><td>${format(s.onp)}</td></tr>`).join("");
}

function sampleProgress(samples) {
  // Compact overview: rounded clock labels fit in one row; exact times remain in tooltips and the data tables.
  return SAMPLE_SCHEDULE.map((second, index) => {
    const precise = formatMinutes(labMinutes(second));
    const status = index < samples.length ? "recorded" : "pending";
    return `<span class="sample-dot ${index < samples.length ? "saved" : ""}" title="${precise} equivalent lab min — ${status}" aria-label="${precise} minutes, ${status}"><i>${index}</i><small>${Math.round(labMinutes(second))}</small></span>`;
  }).join("");
}

function beadSampleAt(dataset, simulationSeconds) {
  const laboratoryMinutes = simulationSeconds / RUN_SECONDS * 340;
  const onp = interpolateCurve(dataset, laboratoryMinutes);
  return {
    simulationSeconds,
    laboratoryMinutes,
    a415: CALIBRATION * onp,
    onp
  };
}

function renderBeadStage(key) {
  const stage = key === "small" ? 1 : 2;
  const next = stage + 1;
  const d = LAB[key];
  const run = state.beadRuns[key];
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(stage, `${d.diameter.toFixed(1)} mm bead experiment`, `Set the automatic spectrophotometer, then run 340 equivalent lab minutes in a two-minute playback. ${stage === 1 ? "This establishes the first response." : "Only bead diameter changes from Stage 1."}`, `Same enzyme charge; ${INITIAL_ONPG.toFixed(2)} mM ONPG`)}
    <div class="stage-grid">
      <section class="panel" aria-label="Virtual reactor apparatus">
        <div class="apparatus-wrap">${apparatusSvg(key)}</div>
        <div class="sample-cue" id="sampleCue"></div>
        <p class="sample-progress-label">Autosampler readings · equivalent lab time [min]</p>
         <div class="sample-progress" id="sampleProgress" aria-label="Automatic readings from zero to 340 equivalent lab minutes">${sampleProgress(run.samples)}</div>
        <div class="instrument-strip">
          <div class="instrument-status"><span class="status-light" id="statusLight"></span><div><strong id="runStatus">${run.complete ? "Simulation complete" : "Reactor ready"}</strong><small id="runSubstatus">120 simulation seconds represent 340 equivalent reaction minutes</small></div></div>
          <div class="clock"><span>EQUIVALENT LAB TIME</span><strong id="clockValue">${formatMinutes(labMinutes(run.elapsed))} min</strong></div>
        </div>
        <div class="panel-pad">
          <div class="controls">
            <button class="button button-secondary autosampler-button" id="armSampler" type="button" ${run.armed ? "disabled" : ""}>${run.armed ? "Autosampler set at 28.33 min intervals" : "Set autosampler · every 28.33 min"}</button>
            <button class="button" id="startRun" type="button" ${!run.armed || run.complete ? "disabled" : ""}>${run.complete ? "Simulation complete" : run.elapsed > 0 ? "Resume simulation" : "Start 340-min run (2-minute playback)"}</button>
          </div>
        </div>
      </section>

      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>ONP formation during this run</h3><p>The graph and sample table update from the supplied laboratory response.</p></div></div>
        <div class="chart-frame"><canvas id="beadChart" aria-label="ONP concentration versus equivalent laboratory time"></canvas></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${d.color}"></i>${d.diameter.toFixed(1)} mm response</span></div>
        <div class="metric-row">
          <div class="metric"><span>ONP concentration</span><strong id="currentOnp">${format(interpolateCurve(d, run.elapsed/RUN_SECONDS*340),3)}</strong> <small>mM</small></div>
          <div class="metric"><span>ABS<sub>415</sub></span><strong id="currentA">${format(CALIBRATION*interpolateCurve(d, run.elapsed/RUN_SECONDS*340),3)}</strong></div>
          <div class="metric"><span>Conversion</span><strong id="currentConversion">${format(100*interpolateCurve(d, run.elapsed/RUN_SECONDS*340)/INITIAL_ONPG,1)}</strong> <small>%</small></div>
        </div>
        <div class="panel-title"><div><h3>Automatic spectrophotometer readings</h3><p>The instrument records the zero baseline and 12 further readings at 28.33 equivalent lab min intervals through 340 min. No manual sampling is required.</p></div></div>
        <div class="data-table-wrap sample-table-wrap"><table class="data-table"><thead><tr><th>Equivalent lab time [min]</th><th>ABS<sub>415</sub> [-]</th><th>ONP concentration, C<sub>ONP</sub> [mM]</th></tr></thead><tbody id="sampleBody">${sampleRows(run.samples)}</tbody></table></div>
        <div class="note"><strong>Why ABS<sub>415</sub>?</strong> ONP is yellow and absorbs strongly at 415 nm. Absorbance is a dimensionless measure of how much light the sample absorbs at that wavelength. Before beginning a run, the experimentalist obtains a baseline absorbance for the clear liquid containing ONPG and zeroes the spectrophotometer. This subtracts background absorbance from all samples so that ABS<sub>415</sub> measures ONP alone. The calibration <strong>C<sub>ONP</sub> = ABS<sub>415</sub> / 3.43</strong> converts the reading to ONP concentration.</div>
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${run.complete && run.samples.length === SAMPLE_SCHEDULE.length ? "" : "disabled"}>Continue to Stage ${next}</button></div>
  </div>`;

  let raf = 0;
  let running = false;
  let last = 0;
  const effectiveScale = FAST_MODE ? 10 : 1;

  const chart = document.getElementById("beadChart");
  const startButton = document.getElementById("startRun");
  const armButton = document.getElementById("armSampler");
  const continueButton = document.getElementById("continueStage");

  function currentProduct() { return interpolateCurve(d, run.elapsed / RUN_SECONDS * 340); }

  function captureDueSamples() {
    if (!run.armed) return;
    let added = false;
    while (run.samples.length < SAMPLE_SCHEDULE.length && run.elapsed + .0001 >= SAMPLE_SCHEDULE[run.samples.length]) {
      const simulationSeconds = SAMPLE_SCHEDULE[run.samples.length];
      run.samples.push(beadSampleAt(d, simulationSeconds));
      added = true;
    }
    if (added) {
      document.getElementById("sampleBody").innerHTML = sampleRows(run.samples);
      document.getElementById("sampleProgress").innerHTML = sampleProgress(run.samples);
      saveState();
      toast(`Automatic reading at ${formatMinutes(run.samples.at(-1).laboratoryMinutes)} min saved.`);
    }
  }

  function updateVisuals() {
    const laboratoryTime = run.elapsed / RUN_SECONDS * 340;
    const onp = currentProduct();
    const conversion = 100 * onp / INITIAL_ONPG;
    document.getElementById("clockValue").textContent = `${formatMinutes(laboratoryTime)} min`;
    document.getElementById("currentOnp").textContent = format(onp,3);
    document.getElementById("currentA").textContent = format(CALIBRATION * onp,3);
    document.getElementById("currentConversion").textContent = format(conversion,1);
    document.getElementById("spectroValue").textContent = format(CALIBRATION * onp,3);
    const fraction = Math.min(1, conversion / 92);
    const blend = Math.pow(Math.max(0, (fraction - .06) / .94), .72);
    const beadColor = amount => `rgb(255, ${Math.round(255 - 55*amount)}, ${Math.round(255 - 225*amount)})`;
    document.getElementById("beadCore").setAttribute("stop-color", beadColor(Math.min(1, fraction*2)));
    document.getElementById("beadEdge").setAttribute("stop-color", beadColor(Math.max(0, Math.min(1, (fraction-.08)*1.4))));
    const startRgb = [255, 255, 255];
    const endRgb = [247, 194, 45];
    const productColor = `rgb(${startRgb.map((value, i) => Math.round(lerp(value, endRgb[i], blend))).join(",")})`;
    document.getElementById("apparatus").style.setProperty("--solution-color", productColor);
    document.getElementById("flowCell").setAttribute("fill", productColor);
    document.getElementById("reservoirFill").setAttribute("fill", productColor);
    document.getElementById("reservoirSurface").setAttribute("fill", productColor);
    document.getElementById("columnWash").setAttribute("fill", productColor);
    drawBeadProgress(chart, d, laboratoryTime);

    const cue = document.getElementById("sampleCue");
    if (!run.armed) {
      cue.className = "sample-cue attention";
      cue.textContent = "Before starting, set the spectrophotometer to record the zero baseline and then read automatically every 28.33 equivalent lab min.";
    } else if (run.samples.length >= SAMPLE_SCHEDULE.length) {
      cue.className = "sample-cue";
      cue.textContent = "All 13 scheduled readings, including the zero baseline, were recorded and saved.";
    } else {
      const due = SAMPLE_SCHEDULE[run.samples.length];
      cue.className = "sample-cue";
      cue.textContent = running ? `Autosampler armed · next reading at ${formatMinutes(labMinutes(due))} min.` : "Zero baseline saved · readings continue every 28.33 equivalent lab min through 340 min.";
    }
    armButton.disabled = run.armed;
    startButton.disabled = !run.armed || run.complete;
    continueButton.disabled = !(run.complete && run.samples.length === SAMPLE_SCHEDULE.length);
  }

  function tick(now) {
    if (!running) return;
    if (!last) last = now;
    const delta = (now - last) / 1000 * effectiveScale;
    last = now;
    run.elapsed = Math.min(RUN_SECONDS, run.elapsed + delta);
    captureDueSamples();
    updateVisuals();
    if (run.elapsed >= RUN_SECONDS) {
      running = false;
      run.complete = true;
      document.getElementById("apparatus").classList.remove("running");
      document.getElementById("statusLight").classList.remove("running");
      document.getElementById("runStatus").textContent = "Simulation complete";
      document.getElementById("runSubstatus").textContent = `${format(beadSummary(key).conversion,1)}% final conversion in supplied data`;
      startButton.textContent = "Simulation complete";
      startButton.disabled = true;
      continueButton.disabled = run.samples.length !== SAMPLE_SCHEDULE.length;
      saveState();
      toast(`${d.diameter.toFixed(1)} mm simulation and all 13 automatic readings saved.`);
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (!run.armed || run.complete) return;
    running = !running;
    document.getElementById("apparatus").classList.toggle("running", running);
    document.getElementById("statusLight").classList.toggle("running", running);
    document.getElementById("runStatus").textContent = running ? "Pump running" : "Run paused";
    document.getElementById("runSubstatus").textContent = running ? "Recirculation active · watch the return stream" : "Your elapsed time is retained";
    startButton.textContent = running ? "Pause run" : "Resume run";
    last = 0;
    if (running) raf = requestAnimationFrame(tick);
    else cancelAnimationFrame(raf);
    saveState();
    updateVisuals();
  }

  armButton.addEventListener("click", () => {
    if (run.elapsed > 0 || run.complete) return;
    run.armed = true;
    run.samples = [beadSampleAt(d, 0)];
    saveState();
    armButton.textContent = "Autosampler set at 28.33 min intervals";
    updateVisuals();
    toast("Zero baseline saved. Autosampler set at 28.33 min intervals.");
  });
  startButton.addEventListener("click", start);
  document.getElementById("continueStage").addEventListener("click", () => navigate(next));
  bindStageReset(stage);
  window.addEventListener("resize", updateVisuals, { passive: true });
  cleanupStage = () => {
    running = false;
    cancelAnimationFrame(raf);
    saveState();
    window.removeEventListener("resize", updateVisuals);
  };
  updateVisuals();
}

function drawBeadProgress(canvas, dataset, maxTime) {
  const points = [];
  const end = Math.max(0, maxTime);
  for (let t = 0; t <= end; t += 4) points.push({ x: t, y: interpolateCurve(dataset, t) });
  if (end > 0) points.push({ x: end, y: interpolateCurve(dataset, end) });
  drawPlot(canvas, {
    xMin: 0, xMax: 340, yMin: 0, yMax: .84,
    xLabel: "Equivalent lab time [min]", yLabel: "C<sub>ONP</sub> [mM]",
    series: [{ name: `${dataset.diameter} mm`, color: dataset.color, points, width: 3 }],
    xTicks: [0, 80, 160, 240, 320], yTicks: [0,.2,.4,.6,.8]
  });
}

function renderComparison() {
  const area = document.getElementById("stageArea");
  const small = beadSummary("small");
  const large = beadSummary("large");
  const runsReady = state.beadRuns.small.samples.length === SAMPLE_SCHEDULE.length && state.beadRuns.large.samples.length === SAMPLE_SCHEDULE.length;
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(3, "Compare bead diameter", "The tables and plot below contrast results for 2.8 and 4.6 mm bead sizes.", "Comparison only · no controls")}
    <div class="compare-summary">
      ${summaryCard("small", small)}${summaryCard("large", large)}
    </div>
    <div class="stage-grid analysis-grid">
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Summary of C<sub>ONP</sub> vs. t [min]</h3><p>Six worksheet checkpoints on the same 0–340 min time scale; the autosampler records all 13.</p></div></div>
        <div class="chart-frame"><canvas id="compareChart" aria-label="Automatic ONP readings for both bead sizes"></canvas><div class="chart-placeholder" ${runsReady ? "hidden" : ""}>Complete the automatic sample series in Stages 1 and 2 to populate this comparison.</div></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.small}"></i>2.8 mm automatic readings</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.large}"></i>4.6 mm automatic readings</span></div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Paired results from Stages 1 and 2</h3><p>Six worksheet time points selected from the 13 recorded in each simulation.</p></div></div>
        <div class="data-table-wrap sample-table-wrap"><table class="data-table comparison-table"><colgroup><col class="comparison-time"><col class="comparison-conc"><col class="comparison-conc"></colgroup><thead><tr><th>Equivalent lab time [min]</th><th>C<sub>ONP</sub> [mM]<br>2.8 mm bead</th><th>C<sub>ONP</sub> [mM]<br>4.6 mm bead</th></tr></thead><tbody>${comparisonRows()}</tbody></table></div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>C<sub>ONPG</sub> vs. dimensionless radius</h3><p>Center (0) to surface (1).</p></div></div>
        <div class="chart-frame"><canvas id="profileChart" aria-label="Radial ONPG concentration profiles for both bead sizes"></canvas></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>d = 2.8 mm; internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> = 0.450</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.large}"></i>d = 4.6 mm; internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> = 0.290</span></div>

        <div class="note">Engineers use an internal effectiveness factor for beads, <span class='math-eta'>η<sub>i</sub></span>, which is the ratio of the actual reaction rate to that expected if the entire bead were at its surface concentration. ONPG consumption in the outer region can leave little substrate available for reaction in the bead interior.</div>
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button">Continue to Stage 4</button></div>
  </div>`;
  const smallProfile = solveBead(2.8, "small");
  const largeProfile = solveBead(4.6, "large");
  const draw = () => {
    drawPlot(document.getElementById("compareChart"), {
      xMin:0,xMax:340,yMin:0,yMax:.84,xLabel:"Equivalent lab time [min]",yLabel:"C<sub>ONP</sub> [mM]",
      xTicks:[0,85,170,255,340],yTicks:[0,.2,.4,.6,.8],
      series:[
        {name:"2.8 mm",color:COLORS.small,points:state.beadRuns.small.samples.map(s=>({x:s.laboratoryMinutes,y:s.onp})),width:2.5,markers:true},
        {name:"4.6 mm",color:COLORS.large,points:state.beadRuns.large.samples.map(s=>({x:s.laboratoryMinutes,y:s.onp})),width:2.5,markers:true}
      ]
    });
    drawProfiles(document.getElementById("profileChart"), [
      {name:"2.8 mm", color:COLORS.small, profile:smallProfile},
      {name:"4.6 mm", color:COLORS.large, profile:largeProfile}
    ]);
  };
  draw();
  window.addEventListener("resize", draw, { passive:true });
  cleanupStage = () => window.removeEventListener("resize", draw);
  document.getElementById("continueStage").addEventListener("click", () => navigate(4));
  bindStageReset(3);
}

function summaryCard(key, s) {
  const d = LAB[key];
  return `<article class="result-card"><h4><i class="bead-dot" style="--swatch:${d.color}"></i>${d.diameter.toFixed(1)} mm beads</h4><dl>
    <dt>Initial rate</dt><dd>${format(s.initialRate)} mM/min</dd>
    <dt>Final conversion</dt><dd>${format(s.conversion)}%</dd>
    <dt>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span></dt><dd>${format(s.eta)}</dd>
  </dl></article>`;
}

function comparisonRows() {
  const small=state.beadRuns.small.samples, large=state.beadRuns.large.samples;
  const value=(array,second)=>{const sample=array.find(s=>s.simulationSeconds===second);return sample?format(sample.onp,3):'<span class="pending">—</span>';};
  return WORKSHEET_SAMPLE_INDICES.map(index=>{
    const second=SAMPLE_SCHEDULE[index];
    return `<tr><td>${formatMinutes(labMinutes(second))}</td><td>${value(small,second)}</td><td>${value(large,second)}</td></tr>`;
  }).join("");
}

function renderKineticScan() {
  const k = state.kinetics;
  const area = document.getElementById("stageArea");
  const finalABS415 = CALIBRATION * KINETICS.rates.at(-1) * 4.5;
  const displayValue = k.scanned ? format(finalABS415,3) : k.blanked ? "0.000" : format(BACKGROUND_ABS415,3);
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(4, "Run six free-enzyme assays", "Only initial ONPG concentration changes. The same free-enzyme amount, solution volume, pH, and temperature are used in all six cuvettes.", "0.62–19.9 mM ONPG · no beads")}
    <div class="spectro-layout">
      <section class="panel">
        <div class="spectro-bench">
          <div class="section-label">SIX-POSITION SPECTROPHOTOMETER</div>
          <div class="cuvette-rack ${k.loaded ? "loaded" : ""}" id="cuvetteRack">${cuvetteMarkup()}</div>
          <div class="spectrometer">
            <div class="spectro-lid" aria-hidden="true"></div>
            <div class="spectro-screen"><span>ABSORBANCE AT 415 NM</span><strong id="kineticDisplay">${displayValue}</strong></div>
            <div class="spectro-button"></div><div class="spectro-knob"></div>
          </div>
        </div>
        <div class="panel-pad">
          <div class="baseline-status ${k.blanked ? "blanked" : ""}"><strong>${k.blanked ? "Background removed" : "Background reading detected"}</strong><span>${k.blanked ? `${format(BACKGROUND_ABS415)} → 0 ABS₄₁₅` : `ABS₄₁₅ = ${format(BACKGROUND_ABS415)} before blanking`}</span></div>
          <div class="controls">
            <button class="button" id="loadCuvettes" type="button" ${k.loaded ? "disabled" : ""}>Load six cuvettes</button>
            <button class="button" id="blankSpectro" type="button" ${!k.loaded || k.blanked ? "disabled" : ""}>Blank spectrophotometer</button>
            <button class="button" id="startScan" type="button" ${!k.blanked || k.scanned ? "disabled" : ""}>Start 4.5-s scan</button>
            <button class="button button-secondary" id="showRates" type="button" ${!k.scanned || k.ratesShown ? "disabled" : ""}>Show initial rates</button>
          </div>
          <div class="note"><strong>Why blank first?</strong> The cuvette and reaction mixture contribute background absorbance before ONP is measured. Blanking subtracts that background and sets the baseline to zero. The calibration <strong>C<sub>ONP</sub> = ABS<sub>415</sub> / 3.43</strong> converts absorbance to ONP concentration, and the slope of each early C<sub>ONP</sub>-time line is the initial rate, v<sub>0</sub>.</div>
        </div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Six ONP-time traces</h3><p>All completed assays remain on the same axes for direct slope comparison.</p></div></div>
        <div class="chart-frame"><canvas id="kineticTraceChart" aria-label="ONP concentration versus time for six initial ONPG concentrations"></canvas><div id="kineticPlaceholder" class="chart-placeholder" ${k.scanned ? "hidden" : ""}>Complete the four instrument actions to collect all six traces.</div></div>
        <div class="legend" id="kineticLegend">${kineticLegend()}</div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Results to record</h3><p>Rates remain hidden until you click Show initial rates.</p></div></div>
        <div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody id="kineticBody">${kineticRows(k.ratesShown)}</tbody></table></div>
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${k.ratesShown ? "" : "disabled"}>Continue to Stage 5</button></div>
  </div>`;

  let raf = 0;
  let scanning = false;
  let scanStart = 0;
  let progress = k.scanned ? 1 : 0;
  const draw = () => drawKineticTraces(document.getElementById("kineticTraceChart"), progress);
  draw();
  if (k.scanned) {
    updateCuvetteColors(1);
    const finalOnp = KINETICS.rates.at(-1) * 4.5;
    document.getElementById("kineticDisplay").textContent = format(CALIBRATION * finalOnp, 3);
  }
  window.addEventListener("resize", draw, {passive:true});

  document.getElementById("loadCuvettes").addEventListener("click", () => {
    k.loaded = true; saveState(); toast("Six cuvettes loaded with equal enzyme amounts."); renderKineticScan();
  });
  document.getElementById("blankSpectro").addEventListener("click", () => {
    k.blanked = true; saveState(); toast(`Background ABS₄₁₅ ${format(BACKGROUND_ABS415,3)} removed; baseline set to 0.000.`); renderKineticScan();
  });
  document.getElementById("startScan").addEventListener("click", () => {
    scanning = true;
    scanStart = performance.now();
    document.getElementById("kineticPlaceholder").hidden = true;
    const duration = FAST_MODE ? 1200 : 7000;
    function tick(now) {
      progress = Math.min(1, (now - scanStart) / duration);
      const t = 4.5 * progress;
      const onp = KINETICS.rates.at(-1) * t;
      document.getElementById("kineticDisplay").textContent = format(CALIBRATION * onp,3);
      updateCuvetteColors(progress);
      draw();
      if (progress < 1) raf = requestAnimationFrame(tick);
      else {
        scanning = false;
        k.scanned = true;
        saveState();
        toast("Six assays complete. Initial rates can now be revealed.");
        renderKineticScan();
      }
    }
    raf = requestAnimationFrame(tick);
  });
  document.getElementById("showRates").addEventListener("click", () => {
    k.ratesShown = true; saveState(); toast("Initial-rate table saved to Run data."); renderKineticScan();
  });
  document.getElementById("continueStage").addEventListener("click", () => navigate(5));
  bindStageReset(4);
  cleanupStage = () => { scanning = false; cancelAnimationFrame(raf); window.removeEventListener("resize", draw); };
}

function cuvetteMarkup() {
  return KINETICS.concentrations.map((s,i) => `<div class="cuvette-item"><div class="cuvette" data-cuvette="${i}" style="--cuvette:#f8f8ec"></div><small>${s < 10 ? s.toFixed(2) : s.toFixed(1)} mM</small></div>`).join("");
}

function updateCuvetteColors(progress) {
  document.querySelectorAll("[data-cuvette]").forEach((el,i) => {
    const fraction = KINETICS.rates[i] / Math.max(...KINETICS.rates) * progress;
    el.style.setProperty("--cuvette", `hsl(48 ${55 + fraction*35}% ${96 - fraction*38}%)`);
  });
}

function kineticLegend() {
  return KINETICS.concentrations.map((s,i)=>`<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.series[i]}"></i>${s < 10 ? s.toFixed(2) : s.toFixed(1)} mM</span>`).join("");
}

function kineticRows(show) {
  if (!show) return `<tr><td colspan="2" class="pending">Complete the scan, then reveal the initial rates.</td></tr>`;
  return KINETICS.concentrations.map((s,i) =>
    `<tr><td><span class="color-key" style="--series:${COLORS.series[i]}"></span>${format(s)}</td><td>${format(KINETICS.rates[i])}</td></tr>`
  ).join("");
}

function drawKineticTraces(canvas, progress=1) {
  const xEnd = 4.5 * progress;
  const series = KINETICS.rates.map((rate,i) => ({
    name:String(KINETICS.concentrations[i]), color:COLORS.series[i], width:2.3, markers:progress>=1,
    points:Array.from({length:10},(_,j)=>({x:j*.5,y:rate*j*.5})).filter(p=>p.x<=xEnd+.001)
  }));
  drawPlot(canvas,{xMin:0,xMax:4.5,yMin:0,yMax:.011,xLabel:"Assay time [s]",yLabel:"C<sub>ONP</sub> [mM]",xTicks:[0,1,2,3,4],yTicks:[0,.002,.004,.006,.008,.010],series});
}

function renderRateCurve() {
  const area = document.getElementById("stageArea");
  const ready = state.kinetics.ratesShown;
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(5, "Build the Michaelis–Menten rate curve", "Use six measured Stage 4 initial rates and three higher-substrate predictions calculated from the teaching model. These predictions are not experimental measurements.", "Six measured + three model-predicted rates")}
    <div class="stage-grid analysis-grid">
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>Six measured Stage 4 initial rates</h3><p>Each value is the slope of a supplied ONP-time trace.</p></div></div>
        <div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v₀ [mM/s]</th></tr></thead><tbody>${kineticRateRows()}</tbody></table></div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Three high-ONPG model predictions (not measured)</h3><p>Extrapolated from the fitted teaching equation beyond 19.9 mM.</p></div></div>
        <div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Predicted initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody>${highModelRows()}</tbody></table></div>
        <div class="note"><strong>Model-only extrapolation:</strong> uses V<sub>max</sub> = 0.00226 mM/s and K<sub>m</sub> = 2.00 mM. No additional assays were performed. Predictions assume no substrate inhibition, enzyme deactivation, or solubility constraints; feasibility at these concentrations has not been established.</div>
        <div class="equation">v<sub>0</sub> = V<sub>max</sub> C<sub>ONPG,0</sub> / (K<sub>m</sub> + C<sub>ONPG,0</sub>)</div>
        <div class="controls">
          <button class="button" id="buildCurve" type="button" ${!ready || state.curveBuilt ? "disabled" : ""}>Build kinetics plot</button>
          <button class="button button-secondary" id="halfGuide" type="button" ${!state.curveBuilt || state.halfGuide ? "disabled" : ""}>Show half-maximum guide</button>
        </div>
        ${!ready ? `<div class="note"><strong>Stage 4 is incomplete.</strong> Return to the kinetic scan and reveal all six initial rates before building this graph.</div>` : ""}
        ${state.curveBuilt ? `<div class="callout" style="margin-top:15px"><h4>Teaching fit</h4><p>V<sub>max</sub> = <code>0.00226 mM/s</code> &nbsp;·&nbsp; K<sub>m</sub> = <code>2.00 mM</code>. Measured points need not fall exactly on this supplied curve. A least-squares reciprocal fit to the six displayed rates gives approximately V<sub>max</sub> = 0.00188 mM/s and K<sub>m</sub> = 1.17 mM; reciprocal fitting weights the data differently.</p></div>` : ""}
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Measured range: 0–20 mM</h3><p>Six measured rates are circles; the teaching model is a solid curve.</p></div></div>
        <div class="chart-frame"><canvas id="mmChart" aria-label="Michaelis-Menten graph of initial rate versus initial ONPG concentration"></canvas><div class="chart-placeholder" id="mmPlaceholder" ${state.curveBuilt ? "hidden" : ""}>Click Build kinetics plot after completing Stage 4.</div></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.navy}"></i>Measured v₀</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>Michaelis–Menten fit</span>${state.halfGuide?`<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.yellow}"></i>Half maximum</span>`:""}</div>
        ${state.halfGuide ? `<div class="note"><strong>Read the guide:</strong> one-half V<sub>max</sub> = 0.00113 mM/s intersects the fitted curve at [S]<sub>0</sub> = 2.00 mM.</div>` : ""}
      </section>
    </div>
    <section class="panel chart-panel" style="margin-top:18px">
      <div class="panel-title"><div><h3>Extended-range model and saturation</h3><p>Measured Stage 4 rates are circles; additional calculated rates are open triangles. These three high-concentration points are model predictions, not measurements.</p></div></div>
      <div class="chart-frame"><canvas id="extendedMmChart" aria-label="Extended ONPG Michaelis–Menten rate curve with three model predictions"></canvas><div class="chart-placeholder" ${state.curveBuilt ? "hidden" : ""}>Build the Stage 5 plot to view saturation predictions.</div></div>
      <div class="legend"><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.navy}"></i>Six measured (circles)</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>Teaching model (line)</span><span class="legend-item">△ Three predicted (open triangles)</span></div>
    </section>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${state.curveBuilt ? "" : "disabled"}>Continue to Stage 6</button></div>
  </div>`;
  const draw = () => {drawMichaelis(document.getElementById("mmChart"),state.curveBuilt,state.halfGuide);drawExtendedMichaelis(document.getElementById("extendedMmChart"),state.curveBuilt);};
  draw();
  window.addEventListener("resize", draw, {passive:true});
  document.getElementById("buildCurve").addEventListener("click", () => { state.curveBuilt=true; saveState(); toast("Kinetics plot built and saved."); renderRateCurve(); });
  document.getElementById("halfGuide").addEventListener("click", () => { state.halfGuide=true; saveState(); renderRateCurve(); });
  document.getElementById("continueStage").addEventListener("click", () => navigate(6));
  bindStageReset(5);
  cleanupStage = () => window.removeEventListener("resize", draw);
}

function highModelRows() {
  return HIGH_ONPG_MODEL.map(p=>`<tr><td>${p.concentration.toFixed(1)}</td><td>${p.rate.toFixed(6)}</td></tr>`).join("");
}
function drawExtendedMichaelis(canvas,built) {
  const curve=[];
  for(let x=0;x<=160;x+=1)curve.push({x,y:KINETICS.vmax*x/(KINETICS.km+x)});
  const series=built?[
    {name:"Model",color:COLORS.small,width:3,points:curve},
    {name:"Measured",color:COLORS.navy,width:0,markers:true,points:KINETICS.concentrations.map((x,i)=>({x,y:KINETICS.rates[i]}))},
    {name:"Predicted",color:COLORS.large,width:0,markers:true,markerShape:"triangle",points:HIGH_ONPG_MODEL.map(p=>({x:p.concentration,y:p.rate}))}
  ]:[];
  drawPlot(canvas,{xMin:0,xMax:165,yMin:0,yMax:.0027,xLabel:"Initial ONPG, C<sub>ONPG,0</sub> [mM]",yLabel:"v<sub>0</sub> [mM/s]",xTicks:[0,40,80,120,160],yTicks:[0,.0005,.001,.0015,.002,.0025],series});
}
function kineticRateRows() {
  return KINETICS.concentrations.map((s,i)=>`<tr><td><span class="color-key" style="--series:${COLORS.series[i]}"></span>${format(s,s<10?3:1)}</td><td>${format(KINETICS.rates[i],6)}</td></tr>`).join("");
}

function drawMichaelis(canvas, built, halfGuide) {
  const fit = [];
  for (let s=0;s<=22;s+=.2) fit.push({x:s,y:KINETICS.vmax*s/(KINETICS.km+s)});
  const series = built ? [
    {name:"Fit",color:COLORS.small,width:3,points:fit},
    {name:"Measured",color:COLORS.navy,width:0,markers:true,points:KINETICS.concentrations.map((x,i)=>({x,y:KINETICS.rates[i]}))}
  ] : [];
  if (built && halfGuide) {
    series.push({name:"half horizontal",color:COLORS.yellow,width:2,dash:[6,5],points:[{x:0,y:KINETICS.vmax/2},{x:KINETICS.km,y:KINETICS.vmax/2}]});
    series.push({name:"half vertical",color:COLORS.yellow,width:2,dash:[6,5],points:[{x:KINETICS.km,y:0},{x:KINETICS.km,y:KINETICS.vmax/2}]});
  }
  drawPlot(canvas,{xMin:0,xMax:22,yMin:0,yMax:.0027,xLabel:"Initial ONPG, C<sub>ONPG,0</sub> [mM]",yLabel:"v<sub>0</sub> [mM/s]",xTicks:[0,5,10,15,20],yTicks:[0,.0005,.001,.0015,.002,.0025],series});
}

function renderDesign() {
  const area = document.getElementById("stageArea");
  const d = state.designDiameter;
  const profile = solveBead(d, null);
  const eta = reportedEta(d, profile.eta);
  const assigned = getAssignedDesigns();
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(6, "Adjust bead diameter and compare two trials", "Use the diameter slider to first set 0.6 mm and save that result. Then reduce the diameter to 0.3 mm and save that result. Compare the internal effectiveness factors and ONPG profiles. You may also explore other diameters.", "Target <span class='math-eta'>η<sub>i</sub></span> ≥ 0.95")}
    <div class="design-grid">
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>Adjustable diameter control</h3><p>Required trials: 0.6 mm, then 0.3 mm. Use 0.1 mm increments; other diameters may also be explored.</p></div><span class="pass-badge ${eta>=.95?"pass":""}">${eta>=.95?"MEETS TARGET":"BELOW TARGET"}</span></div>
        <div class="slider-block">
          <div class="diameter-readout"><strong id="diameterValue">${d.toFixed(1)}</strong><span>mm diameter</span></div>
          <input class="range" id="diameterSlider" type="range" min="0.3" max="4.6" step="0.1" value="${d.toFixed(1)}" aria-label="Adjust bead diameter in millimeters">
          <div class="range-scale"><span>0.3 mm</span><span>4.6 mm</span></div>
          <div class="nudge-row"><button class="nudge" id="diameterDown" type="button" aria-label="Decrease diameter by 0.1 mm">−</button><button class="button" id="saveDiameter" type="button">Save ${d.toFixed(1)} mm result</button><button class="nudge" id="diameterUp" type="button" aria-label="Increase diameter by 0.1 mm">+</button></div>
          <p><strong>Assigned trials:</strong> 0.6 mm ${assigned.six?"✓ saved":"— not yet saved"} · 0.3 mm ${assigned.three?"✓ saved":"— not yet saved"}. Additional diameters are optional.</p>
        </div>
        <div class="metric-row">
          <div class="metric"><span>Internal effectiveness factor</span><strong id="etaValue">${eta.toFixed(4)}</strong></div>
          <div class="metric"><span>Surface ONPG concentration</span><strong id="surfaceValue">${format(profile.surface,3)}</strong> <small>mM</small></div>
          <div class="metric"><span>Center ONPG concentration</span><strong id="centerValue">${format(profile.center,3)}</strong> <small>mM</small></div>
        </div>
        <div class="target-track"><div class="target-fill" style="width:${Math.min(100,eta*100)}%"></div></div>
        <div class="target-label"><span>0</span><strong><span class='math-eta'>η<sub>i</sub></span> target = 0.95</strong><span>1.00</span></div>
        <div class="note"><strong>Model basis:</strong> the same ONPG, enzyme kinetics, and transport assumptions are held fixed while diameter changes. The 2.8 and 4.6 mm rows are laboratory-tested sizes; smaller design sizes are predictions.</div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Surface-to-center ONPG profiles</h3><p>After saving both required results, the 0.6 mm and 0.3 mm profiles appear together on this graph.</p></div></div>
        <div class="chart-frame"><canvas id="designProfileChart" aria-label="Radial ONPG concentration profiles for selected bead sizes"></canvas></div>
        <div class="legend" id="designLegend">${designLegend(assigned,d)}</div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Design table</h3><p>The 0.6 mm and 0.3 mm rows update as you save each result.</p></div></div>
        <div class="data-table-wrap"><table class="data-table result-table"><thead><tr><th>Result</th><th>Bead diameter [mm]</th><th>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> [-]</th><th>Surface ONPG concentration [mM]</th><th>Center ONPG concentration [mM]</th></tr></thead><tbody>${designRows(assigned)}</tbody></table></div>
      </section>
    </div>
  </div>`;
  let currentProfile = profile;
  const slider = document.getElementById("diameterSlider");
  const draw = () => {
    const a = getAssignedDesigns();
    const profiles = a.six && a.three ? [
      {name:"0.6 mm", color:COLORS.large, profile:a.six.profile || solveBead(0.6,null)},
      {name:"0.3 mm", color:COLORS.small, profile:a.three.profile || solveBead(0.3,null)}
    ] : [];
    if (!profiles.length || (Math.abs(d-0.6)>.001 && Math.abs(d-0.3)>.001)) {
      profiles.push({name:`${d.toFixed(1)} mm (current)`,color:COLORS.navy,profile:currentProfile});
    }
        drawProfiles(document.getElementById("designProfileChart"),profiles);
  };
  draw();
  window.addEventListener("resize",draw,{passive:true});

  function setDiameter(value) {
    state.designDiameter = Math.max(0.3, Math.min(4.6, Math.round(value*10)/10));
    saveState();
    renderDesign();
  }
  slider.addEventListener("change",event=>setDiameter(Number(event.target.value)));
  document.getElementById("diameterDown").addEventListener("click",()=>setDiameter(d-0.1));
  document.getElementById("diameterUp").addEventListener("click",()=>setDiameter(d+0.1));
    document.getElementById("saveDiameter").addEventListener("click",()=>{
    const trial = { diameter:d, eta, surface:profile.surface, center:profile.center, profile };
    state.designTrials = state.designTrials.filter(t=>Math.abs(t.diameter-d)>.001);
    state.designTrials.push(trial);
    state.designTrials.sort((a,b)=>a.diameter-b.diameter);
    saveState();
    toast(`${d.toFixed(1)} mm model result saved.`);
    renderDesign();
  });
  bindStageReset(6);
  cleanupStage = () => window.removeEventListener("resize",draw);
}

function reportedEta(d, raw) {
  if (Math.abs(d-2.8)<.001) return .45;
  if (Math.abs(d-4.6)<.001) return .29;
  return raw;
}

function getAssignedDesigns() {
  const trials = state.designTrials || [];
  return {three: trials.find(t=>Math.abs(t.diameter-0.3)<0.001) || null,
          six: trials.find(t=>Math.abs(t.diameter-0.6)<0.001) || null};
}

function designRows(assigned) {
  const knownSmall = solveBead(2.8,"small");
  const knownLarge = solveBead(4.6,"large");
  const row = (label,t) => t ? `<tr><td>${label}</td><td>${t.diameter.toFixed(1)}</td><td>${t.eta.toFixed(4)}</td><td>${format(t.surface,3)}</td><td>${format(t.center,3)}</td></tr>` : `<tr><td>${label}</td><td colspan="4" class="pending">Not saved yet</td></tr>`;
  return row("Large laboratory bead",{diameter:4.6,eta:.29,surface:knownLarge.surface,center:knownLarge.center}) +
    row("Small laboratory bead",{diameter:2.8,eta:.45,surface:knownSmall.surface,center:knownSmall.center}) +
    row("Assigned 0.6 mm",assigned.six) +
    row("Assigned 0.3 mm",assigned.three);
}

function designLegend(assigned,d) {
  if (assigned.six && assigned.three) return `<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.large}"></i>d = 0.6 mm; <span class="math-eta">η<sub>i</sub></span> = ${assigned.six.eta.toFixed(4)}</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>d = 0.3 mm; <span class="math-eta">η<sub>i</sub></span> = ${assigned.three.eta.toFixed(4)}</span>${(Math.abs(d-0.6)>.001 && Math.abs(d-0.3)>.001)?`<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.navy}"></i>d = ${d.toFixed(1)} mm; current exploration</span>`:""}`;
  return `<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.navy}"></i>d = ${d.toFixed(1)} mm; current design (select 0.6 mm, then 0.3 mm)</span>`;
}

function solveBead(diameter, fixedKey=null) {
  const cBulk = INITIAL_ONPG / PROFILE_CONCENTRATION_SCALE;
  const phi = fixedKey ? LAB[fixedKey].phi : .8214 * diameter;
  const biot = fixedKey ? LAB[fixedKey].biot : 15;
  const eps = 1e-4;
  const steps = 700;

  function integrate(center, collect=false) {
    const h=(1-eps)/steps;
    const q0=9*phi*phi*center/(1+center);
    let x=eps;
    let c=center+q0*eps*eps/6;
    let u=q0*eps*eps*eps/3;
    const points=collect?[{x:0,y:center*PROFILE_CONCENTRATION_SCALE}]:null;
    const deriv=(xx,cc,uu)=>[uu/(xx*xx),xx*xx*9*phi*phi*cc/(1+cc)];
    for(let i=0;i<steps;i+=1){
      const k1=deriv(x,c,u);
      const k2=deriv(x+h/2,c+h*k1[0]/2,u+h*k1[1]/2);
      const k3=deriv(x+h/2,c+h*k2[0]/2,u+h*k2[1]/2);
      const k4=deriv(x+h,c+h*k3[0],u+h*k3[1]);
      c+=h*(k1[0]+2*k2[0]+2*k3[0]+k4[0])/6;
      u+=h*(k1[1]+2*k2[1]+2*k3[1]+k4[1])/6;
      x+=h;
      if(collect && (i%14===0 || i===steps-1)) points.push({x:Math.min(1,x),y:c*PROFILE_CONCENTRATION_SCALE});
    }
    return {c,u,points};
  }

  function residual(center){const r=integrate(center,false);return r.u-3*biot*(cBulk-r.c);}
  let lo=1e-11,hi=cBulk;
  for(let i=0;i<65;i+=1){const mid=(lo+hi)/2;if(residual(mid)>0)hi=mid;else lo=mid;}
  const solved=integrate((lo+hi)/2,true);
  const eta=solved.u*(1+solved.c)/(3*phi*phi*solved.c);
  return {eta,surface:solved.c*PROFILE_CONCENTRATION_SCALE,center:(lo+hi)/2*PROFILE_CONCENTRATION_SCALE,points:solved.points,diameter};
}

function drawProfiles(canvas, profiles) {
  drawPlot(canvas,{xMin:0,xMax:1,yMin:0,yMax:.86,xLabel:"Dimensionless radius, r/R",yLabel:"C<sub>ONPG</sub> [mM]",xTicks:[0,.2,.4,.6,.8,1],yTicks:[0,.2,.4,.6,.8],series:profiles.map(p=>({name:p.name,color:p.color,width:3,points:p.profile.points}))});
}

function drawPlot(canvas, options) {
  if (!canvas) return;
  const cssWidth = Math.max(320, canvas.parentElement.clientWidth || 520);
  const cssHeight = canvas.parentElement.classList.contains("compact") ? 250 : 310;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth*ratio);
  canvas.height = Math.round(cssHeight*ratio);
  const ctx=canvas.getContext("2d");
  ctx.scale(ratio,ratio);
  const m={left:88,right:20,top:14,bottom:52};
  const w=cssWidth-m.left-m.right,h=cssHeight-m.top-m.bottom;
  const sx=x=>m.left+(x-options.xMin)/(options.xMax-options.xMin)*w;
  const sy=y=>m.top+h-(y-options.yMin)/(options.yMax-options.yMin)*h;
  ctx.clearRect(0,0,cssWidth,cssHeight);
  ctx.fillStyle="#fff";ctx.fillRect(0,0,cssWidth,cssHeight);
  ctx.font="14px Arial, sans-serif";
  ctx.strokeStyle="#e2e9e9";ctx.lineWidth=1;
  ctx.fillStyle="#263b44";
  (options.yTicks||[]).forEach(t=>{const y=sy(t);ctx.beginPath();ctx.moveTo(m.left-5,y);ctx.lineTo(m.left,y);ctx.stroke();ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillText(t<.01&&t!==0?t.toFixed(4):String(t),m.left-8,y);});
  (options.xTicks||[]).forEach(t=>{const x=sx(t);ctx.beginPath();ctx.moveTo(x,m.top+h);ctx.lineTo(x,m.top+h+5);ctx.stroke();ctx.textAlign="center";ctx.textBaseline="top";ctx.fillText(String(t),x,m.top+h+8);});
  ctx.strokeStyle="#748b94";ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(m.left,m.top);ctx.lineTo(m.left,m.top+h);ctx.lineTo(m.left+w,m.top+h);ctx.stroke();
  (options.series||[]).forEach(s=>{
    if(!s.points?.length)return;
    ctx.save();ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.lineWidth=s.width??2.5;ctx.lineJoin="round";ctx.lineCap="round";ctx.setLineDash(s.dash||[]);
    if((s.width??2.5)>0){ctx.beginPath();s.points.forEach((p,i)=>{const x=sx(p.x),y=sy(p.y);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();}
    if(s.markers){ctx.setLineDash([]);s.points.forEach(p=>{
      const x=sx(p.x),y=sy(p.y);ctx.beginPath();
      if(s.markerShape==="triangle"){ctx.moveTo(x,y-6);ctx.lineTo(x+5,y+4);ctx.lineTo(x-5,y+4);ctx.closePath();ctx.fillStyle="#fff";ctx.fill();ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.stroke();}
      else {ctx.arc(x,y,3.4,0,Math.PI*2);ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.stroke();}
    });}
    ctx.restore();
  });
  // Canvas text doesn't interpret markup. Draw subscripts as smaller glyphs
  // on a lowered baseline so chemical symbols remain legible on both axes.
  drawMathAxisLabel(ctx, options.xLabel, m.left+w/2, cssHeight-7);
  drawMathAxisLabel(ctx, options.yLabel, 20, m.top+h/2, -Math.PI/2);
}

function drawMathAxisLabel(ctx, label, x, y, angle=0) {
  const tokens = String(label)
    .split(new RegExp("(<sub>[^<]*</sub>|<sup>[^<]*</sup>)", "g"))
    .filter(Boolean)
    .map(fragment => {
      const sub=fragment.startsWith("<sub>");
      const sup=fragment.startsWith("<sup>");
      return {text: (sub||sup) ? fragment.slice(5,-6) : fragment, sub, sup};
    });
  const font = small => `600 ${small ? 10 : 14}px Arial, Helvetica, sans-serif`;
  ctx.save();
  ctx.translate(x,y);
  ctx.rotate(angle);
  ctx.textAlign="left";
  ctx.textBaseline="alphabetic";
  ctx.fillStyle="#36535f";
  const widths=tokens.map(t => { ctx.font=font(t.sub||t.sup); return ctx.measureText(t.text).width; });
  let cursor=-widths.reduce((a,b)=>a+b,0)/2;
  tokens.forEach((t,i) => {
    ctx.font=font(t.sub||t.sup);
    ctx.fillText(t.text,cursor,t.sub ? 4 : t.sup ? -6 : 0);
    cursor+=widths[i];
  });
  ctx.restore();
}

function renderDataDialog() {
  const body=document.getElementById("dataDialogBody");
  const sections=[];
  for(const key of ["small","large"]){
    const run=state.beadRuns[key];
    if(run.samples.length) sections.push(`<div class="panel-title"><div><h3>${LAB[key].diameter.toFixed(1)} mm bead samples</h3></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Equivalent lab time [min]</th><th>ABS<sub>415</sub> [-]</th><th>ONP concentration, C<sub>ONP</sub> [mM]</th></tr></thead><tbody>${sampleRows(run.samples)}</tbody></table></div>`);
  }
  if(state.kinetics.ratesShown) sections.push(`<div class="panel-title" style="margin-top:20px"><div><h3>Free-enzyme initial rates</h3></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody>${kineticRateRows()}</tbody></table></div>`);
  if(state.curveBuilt) sections.push(`<div class="panel-title" style="margin-top:20px"><div><h3>High-concentration teaching-model predictions (not measured)</h3></div></div><div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Predicted initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody>${highModelRows()}</tbody></table></div>`);
  if(state.designTrials.length) sections.push(`<div class="panel-title" style="margin-top:20px"><div><h3>Saved bead designs</h3></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Bead diameter [mm]</th><th>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> [-]</th><th>Surface ONPG concentration [mM]</th><th>Center ONPG concentration [mM]</th></tr></thead><tbody>${state.designTrials.map(t=>`<tr><td>${format(t.diameter)}</td><td>${format(t.eta)}</td><td>${format(t.surface)}</td><td>${format(t.center)}</td></tr>`).join("")}</tbody></table></div>`);
  body.innerHTML=sections.length?sections.join(""):`<div class="empty-state"><h3>No results saved yet</h3><p>In Stage 1, set the autosampler to 28.33 equivalent laboratory minute intervals and start the reactor simulation.</p></div>`;
}

function sessionCsv() {
  const rows=[["section","condition","simulation_time_s","equivalent_reaction_time_min","ABS415","ONP_mM","initial_rate_mM_s","diameter_mm","eta_i","surface_ONPG_mM","center_ONPG_mM"]];
  for(const key of ["small","large"]) state.beadRuns[key].samples.forEach(s=>rows.push(["bead sample",`${LAB[key].diameter} mm`,s.simulationSeconds,s.laboratoryMinutes,s.a415,s.onp,"",LAB[key].diameter,"","",""]));
  if(state.kinetics.ratesShown) KINETICS.concentrations.forEach((s,i)=>rows.push(["free-enzyme kinetics",`${s} mM ONPG`,"","","","",KINETICS.rates[i],"","","",""]));
  if(state.curveBuilt) HIGH_ONPG_MODEL.forEach(p=>rows.push(["model extrapolation (not measured)",`${p.concentration} mM ONPG`,"","","","",p.rate,"","","",""]));
  state.designTrials.forEach(t=>rows.push(["bead design",`${t.diameter} mm`,"","","","","",t.diameter,t.eta,t.surface,t.center]));
  return rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
}

function initGlobal() {
  document.querySelectorAll(".step").forEach(button=>button.addEventListener("click",()=>navigate(Number(button.dataset.stage))));
  const dataDialog=document.getElementById("dataDialog");
  const aboutDialog=document.getElementById("aboutDialog");
  document.getElementById("openAbout").addEventListener("click",()=>aboutDialog.showModal());
  document.getElementById("closeAbout").addEventListener("click",()=>aboutDialog.close());
  document.getElementById("openData").addEventListener("click",()=>{renderDataDialog();dataDialog.showModal();});
  document.getElementById("closeData").addEventListener("click",()=>dataDialog.close());
  document.getElementById("downloadCsv").addEventListener("click",()=>{
    const blob=new Blob([sessionCsv()],{type:"text/csv"});
    const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="ONPG_virtual_lab_session.csv";a.click();URL.revokeObjectURL(url);
  });
  document.getElementById("clearData").addEventListener("click",()=>{
    if(!confirm("Clear every sample, kinetic result, and bead-design trial from this session?"))return;
    state=defaultState();saveState();dataDialog.close();navigate(1);toast("Session cleared.");
  });
  [dataDialog,aboutDialog].forEach(dialog=>dialog.addEventListener("click",event=>{
    const bounds=dialog.getBoundingClientRect();
    const outside=event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom;
    if(outside)dialog.close();
  }));
  updateDataCount();updateStepper();navigate(state.stage || 1);
}

document.addEventListener("DOMContentLoaded",initGlobal);
