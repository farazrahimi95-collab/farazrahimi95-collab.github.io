"use strict";

const CALIBRATION = 3.43; // rounded fitted slope, ABS415 [-] = 3.43 [mM^-1] × CONP [mM]; fitted slope in supplied graph = 3.4337
const BACKGROUND_ABS415 = 0.056;
const INITIAL_ONPG = 0.83;
// Concentration scale that preserves the supplied MATLAB cBulk = 0.403 at 0.83 mM.
// This profile-model scale is distinct from the free-enzyme kinetic fit (Km = 2.00 mM).
const PROFILE_CONCENTRATION_SCALE = 2.059220522647014;
const FAST_MODE = new URLSearchParams(location.search).get("fast") === "1";
const RUN_SECONDS = 60;
// Six readings, at exact equivalent laboratory times over the 60-second playback.
const SAMPLE_LAB_MINUTES = [0, 28, 85, 170, 255, 340];
const SAMPLE_SCHEDULE = SAMPLE_LAB_MINUTES.map(t => t / 340 * RUN_SECONDS);

const COLORS = {
  small: "#008d83",
  large: "#ed8a3a",
  navy: "#0f3047",
  yellow: "#e1ad13",
  series: ["#2678a9", "#e57b38", "#4d9b59", "#3aa7bc", "#8d5bb1", "#b68a12", "#c45972"]
};

const LAB = {
  small: {
    diameter: 2.8,
    times: [0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,230,280,340],
    onp: [0,0.1438865,0.2817730,0.3775248,0.4639362,0.5350993,0.5884468,0.6306596,0.6630213,0.6868794,0.7051560,0.7143901,0.7344468,0.7499291,0.7509716,0.7499787,0.7509645,0.7525177,0.7613901,0.7670213,0.7670213],
    phi: 2.04,
    biot: 16.8,
    color: COLORS.small
  },
  large: {
    diameter: 4.6,
    times: [0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,210,220,240,260,300,340],
    onp: [0,0.0911915,0.1614113,0.2279362,0.2938227,0.3464681,0.3926099,0.4360142,0.4756241,0.5075248,0.5390284,0.5675887,0.5937021,0.6111702,0.6281915,0.6533333,0.6662908,0.6749433,0.6851702,0.6906241,0.6982979,0.7043617,0.7086454,0.7096950,0.7127943,0.7150213,0.7168369],
    phi: 3.79,
    biot: 18.6,
    color: COLORS.large
  }
};

// Six supplied laboratory rates plus one high-substrate virtual assay.
// Anchor the saturating reference curve at the recorded 19.9 mM initial rate.
const KINETICS = {
  concentrations: [0.621875, 1.24375, 2.4875, 4.975, 9.95, 19.9],
  rates: [0.000702, 0.000789, 0.001316, 0.001404, 0.001754, 0.002281],
  km: 2.00
};
const anchorIndex = KINETICS.concentrations.length - 1;
KINETICS.vmax = KINETICS.rates[anchorIndex] *
  (KINETICS.km + KINETICS.concentrations[anchorIndex]) / KINETICS.concentrations[anchorIndex];
for (const concentration of [39.8]) {
  KINETICS.concentrations.push(concentration);
  KINETICS.rates.push(KINETICS.vmax * concentration / (KINETICS.km + concentration));
}
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
function formatMinutes(value) { return String(Math.round(value)); }

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

// Estimate the instantaneous initial rate from an unweighted cubic least-squares
// fit to the original 0–60 minute ONP-versus-time points. v0 = dC_ONP/dt at t=0.
// Normalize the fitting time to [0,1] to keep the normal equations conditioned.
function reactorInitialRate(dataset) {
  const windowMinutes = 60;
  const order = 3;
  const a = Array.from({length: order + 1}, () => Array(order + 2).fill(0));
  dataset.times.forEach((time, i) => {
    if (time > windowMinutes) return;
    const x = time / windowMinutes;
    const powers = Array.from({length: 2*order + 1}, (_,j) => x**j);
    for (let row=0;row<=order;row++) {
      for (let col=0;col<=order;col++) a[row][col] += powers[row+col];
      a[row][order+1] += powers[row] * dataset.onp[i];
    }
  });
  // Partial-pivot Gaussian elimination for the four polynomial coefficients.
  for (let j=0;j<=order;j++) {
    let pivot=j;
    for (let i=j+1;i<=order;i++) if (Math.abs(a[i][j])>Math.abs(a[pivot][j])) pivot=i;
    if (Math.abs(a[pivot][j])<1e-12) throw new Error("Insufficient independent initial-rate samples");
    [a[j],a[pivot]]=[a[pivot],a[j]];
    const scale=a[j][j];
    for (let k=j;k<=order+1;k++) a[j][k]/=scale;
    for (let i=0;i<=order;i++) {
      if (i===j) continue;
      const fac=a[i][j];
      for (let k=j;k<=order+1;k++) a[i][k]-=fac*a[j][k];
    }
  }
  return a[1][order+1] / windowMinutes;
}

function beadSummary(key) {
  const d=LAB[key];
  return {
    initialRate: reactorInitialRate(d),
    t50: crossingTime(d, INITIAL_ONPG*0.50),
    t80: crossingTime(d, INITIAL_ONPG*0.80),
    conversion: 100*d.onp.at(-1)/INITIAL_ONPG,
    eta: solveBead(d.diameter,key).eta
  };
}

function updateStepper() {
  const complete = {
    1: state.kinetics.scanned,
    2: state.curveBuilt,
    3: Boolean(getAssignedDesigns().three && getAssignedDesigns().six),
    4: state.beadRuns.small.complete,
    5: state.beadRuns.large.complete,
    6: state.beadRuns.small.complete && state.beadRuns.large.complete
  };
  document.querySelectorAll(".step").forEach(button => {
    const number = Number(button.dataset.stage);
    button.classList.toggle("active", number === state.stage);
    button.classList.toggle("complete", Boolean(complete[number]));
  });
}

function updateDataCount() {
  const count = state.beadRuns.small.samples.length + state.beadRuns.large.samples.length +
    (state.kinetics.ratesShown ? KINETICS.rates.length : 0) + state.designTrials.length;
  document.getElementById("dataCount").textContent = count;
}

function navigate(stage) {
  cleanupStage();
  cleanupStage = () => {};
  state.stage = stage;
  saveState();
  if (stage === 1) renderKineticScan();
  if (stage === 2) renderRateCurve();
  if (stage === 3) renderDesign();
  if (stage === 4) renderBeadStage("small");
  if (stage === 5) renderBeadStage("large");
  if (stage === 6) renderComparison();
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
    if (stage === 4) state.beadRuns.small = fresh.beadRuns.small;
    if (stage === 5) state.beadRuns.large = fresh.beadRuns.large;
    if (stage === 1) {
      state.kinetics = fresh.kinetics;
      state.curveBuilt = false;
      state.halfGuide = false;
    }
    if (stage === 2) {
      state.curveBuilt = false;
      state.halfGuide = false;
    }
    if (stage === 3) {
      state.designDiameter = fresh.designDiameter;
      state.designTrials = [];
    }
    saveState();
    navigate(stage);
    toast(stage === 6 ? "Comparison view refreshed; both reactor runs were preserved." : `Stage ${stage} reset.`);
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
  if (!samples.length) return `<tr><td colspan="3" class="pending">No readings yet. Set the six-point autosampler to capture the zero baseline.</td></tr>`;
  return samples.map(s => `<tr><td>${formatMinutes(s.laboratoryMinutes)}</td><td>${format(s.a415)}</td><td>${format(s.onp)}</td></tr>`).join("");
}

function sampleProgress(samples) {
  // Six exact equivalent-lab sample times; display full labels in one row.
  return SAMPLE_SCHEDULE.map((second, index) => {
    const precise = formatMinutes(labMinutes(second));
    const status = index < samples.length ? "recorded" : "pending";
    return `<span class="sample-dot ${index < samples.length ? "saved" : ""}" title="${precise} equivalent lab min — ${status}" aria-label="${precise} minutes, ${status}"><i>${index}</i><small>${precise}</small></span>`;
  }).join("");
}

function beadSampleAt(dataset, simulationSeconds) {
  const laboratoryMinutes = Math.round(labMinutes(simulationSeconds));
  const onp = interpolateCurve(dataset, laboratoryMinutes);
  return {
    simulationSeconds,
    laboratoryMinutes,
    a415: CALIBRATION * onp,
    onp
  };
}

function renderBeadStage(key) {
  const stage = key === "small" ? 4 : 5;
  const next = stage + 1;
  const d = LAB[key];
  const run = state.beadRuns[key];
  const area = document.getElementById("stageArea");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(stage, `${d.diameter.toFixed(1)} mm bead experiment`, `First click "Set autosampler · six sample times" to record the initial reading at 0 min and schedule five more. Then click "Start 340-min run (1-minute playback)." Watch the smooth ONP concentration curve and the six recorded readings. ${stage === 4 ? "This is the 2.8 mm run." : "Repeat the same experiment with 4.6 mm beads."}`, `Same enzyme charge; ${INITIAL_ONPG.toFixed(2)} mM ONPG`)}
    <div class="stage-grid">
      <section class="panel" aria-label="Virtual reactor apparatus">
        <div class="apparatus-wrap">${apparatusSvg(key)}</div>
        <div class="sample-cue" id="sampleCue"></div>
        <p class="sample-progress-label">Autosampler readings · equivalent lab time [min]</p>
         <div class="sample-progress" id="sampleProgress" aria-label="Automatic readings from zero to 340 equivalent lab minutes">${sampleProgress(run.samples)}</div>
        <div class="instrument-strip">
          <div class="instrument-status"><span class="status-light" id="statusLight"></span><div><strong id="runStatus">${run.complete ? "Simulation complete" : "Reactor ready"}</strong><small id="runSubstatus">60 simulation seconds represent 340 equivalent reaction minutes</small></div></div>
          <div class="clock"><span>EQUIVALENT LAB TIME</span><strong id="clockValue">${formatMinutes(labMinutes(run.elapsed))} min</strong></div>
        </div>
        <div class="panel-pad">
          <div class="controls">
            <button class="button button-secondary autosampler-button" id="armSampler" type="button" ${run.armed ? "disabled" : ""}>${run.armed ? "Autosampler set for six sample times" : "Set autosampler · six sample times"}</button>
            <button class="button" id="startRun" type="button" ${!run.armed || run.complete ? "disabled" : ""}>${run.complete ? "Simulation complete" : run.elapsed > 0 ? "Resume simulation" : "Start 340-min run (1-minute playback)"}</button>
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
        <div class="panel-title"><div><h3>Automatic spectrophotometer readings</h3><p>The spectrophotometer automatically records six readings at 0, 28, 85, 170, 255 and 340 equivalent lab minutes. The complete response runs in one minute.</p></div></div>
        <div class="data-table-wrap sample-table-wrap"><table class="data-table"><thead><tr><th>Equivalent lab time [min]</th><th>ABS<sub>415</sub> [-]</th><th>ONP concentration, C<sub>ONP</sub> [mM]</th></tr></thead><tbody id="sampleBody">${sampleRows(run.samples)}</tbody></table></div>
        <div class="note"><strong>Why ABS<sub>415</sub>?</strong> Yellow ONP absorbs light at 415 nm. In the laboratory, a clear ONPG reference is used to zero the spectrophotometer and remove background absorbance. The corrected absorbance gives ONP concentration using <strong>C<sub>ONP</sub> = ABS<sub>415</sub> / 3.43</strong>.</div>
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
      cue.textContent = "Before starting, set the autosampler to capture the zero baseline and five more sample readings.";
    } else if (run.samples.length >= SAMPLE_SCHEDULE.length) {
      cue.className = "sample-cue";
      cue.textContent = "All six sample readings, including the zero baseline, were recorded and saved. Final conversion is shown above.";
    } else {
      const due = SAMPLE_SCHEDULE[run.samples.length];
      cue.className = "sample-cue";
      cue.textContent = running ? `Autosampler armed · next reading at ${formatMinutes(labMinutes(due))} min.` : "Zero baseline saved · the remaining five readings will be collected at the scheduled sampling times.";
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
      toast(`${d.diameter.toFixed(1)} mm simulation complete; six readings and final conversion saved.`);
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
    armButton.textContent = "Autosampler set for six sample times";
    updateVisuals();
    toast("Zero baseline saved. Six sampling times are scheduled.");
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
    xTicks: [0,85,170,255,340], yTicks: [0,.2,.4,.6,.8]
  });
}

// Full supplied reactor responses appear as smooth lines; ONLY six recorded
// samples per bead size appear as dots. Include each recorded sample as a knot
// so dots lie exactly on the smooth shape-preserving interpolated curves.
function fullReactorResponseCurve(dataset, samples) {
  const knots=dataset.times.map((x,i)=>({x,y:dataset.onp[i]}));
  for(const sample of samples){
    const x=sample.laboratoryMinutes;
    const found=knots.find(p=>Math.abs(p.x-x)<1e-8);
    if(found)found.y=sample.onp;else knots.push({x,y:sample.onp});
  }
  knots.sort((a,b)=>a.x-b.x);
  const n=knots.length,h=[],slope=[],tangent=new Array(n);
  for(let i=0;i<n-1;i++){
    h[i]=knots[i+1].x-knots[i].x;
    slope[i]=(knots[i+1].y-knots[i].y)/h[i];
  }
  const edge=(ha,hb,sa,sb)=>{
    const val=((2*ha+hb)*sa-ha*sb)/(ha+hb);
    if(Math.sign(val)!==Math.sign(sa))return 0;
    if(Math.sign(sa)!==Math.sign(sb)&&Math.abs(val)>3*Math.abs(sa))return 3*sa;
    return val;
  };
  tangent[0]=edge(h[0],h[1],slope[0],slope[1]);
  tangent[n-1]=edge(h[n-2],h[n-3],slope[n-2],slope[n-3]);
  for(let i=1;i<n-1;i++){
    if(!slope[i-1]||!slope[i]||Math.sign(slope[i-1])!==Math.sign(slope[i]))tangent[i]=0;
    else{
      const w1=2*h[i]+h[i-1],w2=h[i]+2*h[i-1];
      tangent[i]=(w1+w2)/(w1/slope[i-1]+w2/slope[i]);
    }
  }
  const points=[];
  for(let i=0;i<n-1;i++){
    const count=Math.max(2,Math.ceil(h[i]/2));
    for(let j=0;j<count;j++){
      const t=j/count,t2=t*t,t3=t2*t;
      const y=(2*t3-3*t2+1)*knots[i].y+(t3-2*t2+t)*h[i]*tangent[i]+(-2*t3+3*t2)*knots[i+1].y+(t3-t2)*h[i]*tangent[i+1];
      points.push({x:knots[i].x+t*h[i],y});
    }
  }
  points.push({...knots[n-1]});
  return points;
}

function renderComparison() {
  const area = document.getElementById("stageArea");
  const small = beadSummary("small");
  const large = beadSummary("large");
  const runsReady = state.beadRuns.small.samples.length === SAMPLE_SCHEDULE.length && state.beadRuns.large.samples.length === SAMPLE_SCHEDULE.length;
  const smallProfile = solveBead(2.8, "small");
  const largeProfile = solveBead(4.6, "large");
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(6, "Compare bead diameter", "The tables and plot below contrast results for 2.8 and 4.6 mm bead sizes.", "Paired reactor results")}
    <div class="compare-summary">
      ${summaryCard("small", small)}${summaryCard("large", large)}
    </div>
    <p class="assay-source-note">Initial rates come from cubic least-squares fits to the full supplied 0–60 min ONP responses (slope at t = 0), not from the six automatically recorded display points. Effectiveness factors come directly from the bead-scale reaction–diffusion solver.</p>
    <div class="stage-grid analysis-grid">
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>ONP concentration versus reaction time</h3><p>Smooth curves show the complete 0–340 min conversion responses; dots mark only the six recorded sample times for each bead size.</p></div></div>
        <div class="chart-frame"><canvas id="compareChart" aria-label="Complete smooth ONP conversion curves with six recorded sample markers on each curve"></canvas><div class="chart-placeholder" ${runsReady ? "hidden" : ""}>Complete the automatic sample series in Stages 4 and 5 to populate this comparison.</div></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>2.8 mm full response</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.small}"></i>Six samples</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.large}"></i>4.6 mm full response</span><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.large}"></i>Six samples</span></div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Paired results from Stages 4 and 5</h3><p>The same six sampling times recorded in Stages 4 and 5 are listed here.</p></div></div>
        <div class="data-table-wrap sample-table-wrap"><table class="data-table comparison-table"><colgroup><col class="comparison-time"><col class="comparison-conc"><col class="comparison-conc"></colgroup><thead><tr><th>Equivalent lab time [min]</th><th>C<sub>ONP</sub> [mM]<br>2.8 mm bead</th><th>C<sub>ONP</sub> [mM]<br>4.6 mm bead</th></tr></thead><tbody>${comparisonRows()}</tbody></table></div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>C<sub>ONPG</sub> vs. dimensionless radius</h3><p>Center (0) to surface (1).</p></div></div>
        <div class="chart-frame"><canvas id="profileChart" aria-label="Radial ONPG concentration profiles for both bead sizes"></canvas></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>d = 2.8 mm; internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> = ${smallProfile.eta.toFixed(4)}</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.large}"></i>d = 4.6 mm; internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> = ${largeProfile.eta.toFixed(4)}</span></div>

        <div class="note">The internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span>, compares the actual integrated bead reaction rate with the rate if the entire bead were at its surface concentration. Lower values indicate stronger internal diffusion limitations.</div>
        <details class="model-details"><summary>Reaction–diffusion equations and MATLAB parameters</summary>        <div class="note model-method-note">Engineers use an internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span>, defined as the actual integrated bead reaction rate divided by the rate if the whole bead were at its surface concentration. The model solves d²c/dx² + (2/x)dc/dx − 9φ²c/(1+c) = 0, where x = r/R and c = C<sub>ONPG</sub>/K<sub>m,profile</sub>. Conditions are dc/dx = 0 at x = 0 and dc/dx = 3N<sub>B</sub>(c<sub>bulk</sub> − c<sub>s</sub>) at x = 1. Its surface-film parameter is defined with that factor of three (N<sub>B</sub> = k<sub>f</sub>R/(3D<sub>eff</sub>)); c<sub>bulk</sub> = 0.403. Inputs: 2.8 mm φ = 2.04, N<sub>B</sub> = 16.8; 4.6 mm φ = 3.79, N<sub>B</sub> = 18.6. K<sub>m,profile</sub> is the separately calibrated 2.059 mM profile scale. Results are numerical model outputs, not direct measurements.</div></details>
      </section>
    </div>
  </div>`;
  const draw = () => {
    drawPlot(document.getElementById("compareChart"), {
      xMin:0,xMax:340,yMin:0,yMax:.84,xLabel:"Equivalent lab time [min]",yLabel:"C<sub>ONP</sub> [mM]",
      xTicks:[0,85,170,255,340],yTicks:[0,.2,.4,.6,.8],
      series:runsReady?[
        {name:"2.8 mm full conversion",color:COLORS.small,points:fullReactorResponseCurve(LAB.small,state.beadRuns.small.samples),width:2.8},
        {name:"4.6 mm full conversion",color:COLORS.large,points:fullReactorResponseCurve(LAB.large,state.beadRuns.large.samples),width:2.8},
        {name:"2.8 mm six samples",color:COLORS.small,points:state.beadRuns.small.samples.map(p=>({x:p.laboratoryMinutes,y:p.onp})),width:0,markers:true},
        {name:"4.6 mm six samples",color:COLORS.large,points:state.beadRuns.large.samples.map(p=>({x:p.laboratoryMinutes,y:p.onp})),width:0,markers:true}
      ]:[]
    });
    drawProfiles(document.getElementById("profileChart"), [
      {name:"2.8 mm", color:COLORS.small, profile:smallProfile},
      {name:"4.6 mm", color:COLORS.large, profile:largeProfile}
    ]);
  };
  draw();
  window.addEventListener("resize", draw, { passive:true });
  cleanupStage = () => window.removeEventListener("resize", draw);
  bindStageReset(6);
}

function summaryCard(key, s) {
  const d = LAB[key];
  return `<article class="result-card"><h4><i class="bead-dot" style="--swatch:${d.color}"></i>${d.diameter.toFixed(1)} mm beads</h4><dl>
    <dt>Initial rate (0–60 min fit)</dt><dd>${s.initialRate.toFixed(5)} mM/min</dd>
    <dt>Final conversion</dt><dd>${format(s.conversion)}%</dd>
    <dt>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span></dt><dd>${s.eta.toFixed(4)}</dd>
  </dl></article>`;
}

function comparisonRows() {
  const small=state.beadRuns.small.samples, large=state.beadRuns.large.samples;
  const value=(array,second)=>{const sample=array.find(s=>s.simulationSeconds===second);return sample?format(sample.onp,3):'<span class="pending">—</span>';};
  return SAMPLE_SCHEDULE.map(second=>
    `<tr><td>${formatMinutes(labMinutes(second))}</td><td>${value(small,second)}</td><td>${value(large,second)}</td></tr>`
  ).join("");
}

function refreshStageView(renderer) {
  cleanupStage();
  cleanupStage = () => {};
  renderer();
}

function renderKineticScan() {
  const k = state.kinetics;
  const area = document.getElementById("stageArea");
  const finalABS415 = CALIBRATION * KINETICS.rates.at(-1) * 4.5;
  const displayValue = k.scanned ? format(finalABS415,3) : k.blanked ? "0.000" : format(BACKGROUND_ABS415,3);
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(1, "Run seven free-enzyme assays", "Only the initial ONPG concentration changes. All seven virtual assays use the same enzyme amount, reaction volume, pH, and temperature.", "0.62–39.8 mM ONPG · no beads")}
    <div class="spectro-layout">
      <section class="panel">
        <div class="spectro-bench">
          <div class="section-label">SEVEN-ASSAY SPECTROPHOTOMETER</div>
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
            <button class="button" id="loadCuvettes" type="button" ${k.loaded ? "disabled" : ""}>Load seven cuvettes</button>
            <button class="button" id="blankSpectro" type="button" ${!k.loaded || k.blanked ? "disabled" : ""}>Blank spectrophotometer</button>
            <button class="button" id="startScan" type="button" ${!k.blanked || k.scanned ? "disabled" : ""}>Start 4.5-s scan</button>
            <button class="button button-secondary" id="showRates" type="button" ${!k.scanned || k.ratesShown ? "disabled" : ""}>Show initial rates</button>
          </div>
          <div class="note"><strong>Why blank first?</strong> The cuvette and reaction mixture contribute background absorbance before ONP is measured. Blanking subtracts that background and sets the baseline to zero. The calibration <strong>C<sub>ONP</sub> = ABS<sub>415</sub> / 3.43</strong> converts absorbance to ONP concentration, and the slope of each early C<sub>ONP</sub>-time line is the initial rate, v<sub>0</sub>.</div>
        </div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Seven ONP-time traces</h3><p>All completed assays remain on the same axes for direct slope comparison.</p></div></div>
        <div class="chart-frame"><canvas id="kineticTraceChart" aria-label="ONP concentration versus time for seven initial ONPG concentrations"></canvas><div id="kineticPlaceholder" class="chart-placeholder" ${k.scanned ? "hidden" : ""}>Complete the four instrument actions to collect all seven traces.</div></div>
        <div class="legend" id="kineticLegend">${kineticLegend()}</div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Results to record</h3><p>Rates remain hidden until you click Show initial rates.</p></div></div>
        <div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody id="kineticBody">${kineticRows(k.ratesShown)}</tbody></table></div>
        <p class="assay-source-note">The six supplied laboratory rates are retained; the 39.8 mM virtual assay uses the Michaelis–Menten reference equation.</p>
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${k.ratesShown ? "" : "disabled"}>Continue to Stage 2</button></div>
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
    k.loaded = true; saveState(); toast("Seven cuvettes loaded with equal enzyme amounts."); refreshStageView(renderKineticScan);
  });
  document.getElementById("blankSpectro").addEventListener("click", () => {
    k.blanked = true; saveState(); toast(`Background ABS₄₁₅ ${format(BACKGROUND_ABS415,3)} removed; baseline set to 0.000.`); refreshStageView(renderKineticScan);
  });
  document.getElementById("startScan").addEventListener("click", () => {
    if (scanning || k.scanned) return;
    document.getElementById("startScan").disabled = true;
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
        toast("Seven assays complete. Initial rates can now be revealed.");
        refreshStageView(renderKineticScan);
      }
    }
    raf = requestAnimationFrame(tick);
  });
  document.getElementById("showRates").addEventListener("click", () => {
    k.ratesShown = true; saveState(); toast("Initial-rate table saved to Run data."); refreshStageView(renderKineticScan);
  });
  document.getElementById("continueStage").addEventListener("click", () => navigate(2));
  bindStageReset(1);
  cleanupStage = () => { scanning = false; cancelAnimationFrame(raf); window.removeEventListener("resize", draw); };
}

function assayConcentrationLabel(concentration) { return format(concentration); }

function cuvetteMarkup() {
  return KINETICS.concentrations.map((s,i) => `<div class="cuvette-item"><div class="cuvette" data-cuvette="${i}" style="--cuvette:#f8f8ec"></div><small>${assayConcentrationLabel(s)}<span>mM</span></small></div>`).join("");
}

function updateCuvetteColors(progress) {
  document.querySelectorAll("[data-cuvette]").forEach((el,i) => {
    const fraction = KINETICS.rates[i] / Math.max(...KINETICS.rates) * progress;
    el.style.setProperty("--cuvette", `hsl(48 ${55 + fraction*35}% ${96 - fraction*38}%)`);
  });
}

function kineticLegend() {
  return KINETICS.concentrations.map((s,i)=>`<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.series[i]}"></i>${assayConcentrationLabel(s)} mM</span>`).join("");
}

function kineticRows(show) {
  if (!show) return `<tr><td colspan="2" class="pending">Complete the scan, then reveal the initial rates.</td></tr>`;
  return KINETICS.concentrations.map((s,i) =>
    `<tr><td><span class="color-key" style="--series:${COLORS.series[i]}"></span>${assayConcentrationLabel(s)}</td><td>${KINETICS.rates[i].toFixed(6)}</td></tr>`
  ).join("");
}

function drawKineticTraces(canvas, progress=1) {
  const xEnd = 4.5 * progress;
  const series = KINETICS.rates.map((rate,i) => ({
    name:String(KINETICS.concentrations[i]), color:COLORS.series[i], width:2.3, markers:progress>=1,
    points:Array.from({length:10},(_,j)=>({x:j*.5,y:rate*j*.5})).filter(p=>p.x<=xEnd+.001)
  }));
  drawPlot(canvas,{xMin:0,xMax:4.5,yMin:0,yMax:.012,xLabel:"Assay time [s]",yLabel:"C<sub>ONP</sub> [mM]",xTicks:[0,1,2,3,4],yTicks:[0,.002,.004,.006,.008,.010,.012],series});
}

function renderRateCurve() {
  const area = document.getElementById("stageArea");
  const ready = state.kinetics.ratesShown;
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(2, "Build the Michaelis–Menten rate curve", "Use the seven initial rates from Stage 1 to examine how the rate approaches saturation as ONPG concentration increases.", "Seven initial rates · 0.62–39.8 mM")}
    <div class="stage-grid analysis-grid">
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>Seven Stage 1 initial rates</h3><p>Each initial rate is the slope of its ONP-time trace.</p></div></div>
        <div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v₀ [mM/s]</th></tr></thead><tbody>${ready ? kineticRateRows() : '<tr><td colspan="2" class="pending">Complete Stage 1 and reveal the seven initial rates to populate this table.</td></tr>'}</tbody></table></div>
        <div class="equation">v<sub>0</sub> = V<sub>max</sub> C<sub>ONPG,0</sub> / (K<sub>m</sub> + C<sub>ONPG,0</sub>)</div>
        <div class="controls">
          <button class="button" id="buildCurve" type="button" ${!ready || state.curveBuilt ? "disabled" : ""}>Build kinetics plot</button>
          <button class="button button-secondary" id="halfGuide" type="button" ${!state.curveBuilt || state.halfGuide ? "disabled" : ""}>Show half-maximum guide</button>
        </div>
        ${!ready ? `<div class="note"><strong>Stage 1 is incomplete.</strong> Return to the kinetic scan and reveal all seven initial rates before building this graph.</div>` : ""}
        ${state.curveBuilt ? `<div class="callout" style="margin-top:15px"><h4>Michaelis–Menten reference</h4><p>V<sub>max</sub> = <code>${KINETICS.vmax.toFixed(6)} mM/s</code> &nbsp;·&nbsp; K<sub>m</sub> = <code>${KINETICS.km.toFixed(2)} mM</code>.</p></div>` : ""}
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Initial-rate saturation · 0–40 mM</h3><p>All seven Stage 1 initial rates appear together with the Michaelis–Menten reference curve.</p></div></div>
        <div class="chart-frame"><canvas id="mmChart" aria-label="Michaelis-Menten graph of initial rate versus initial ONPG concentration"></canvas><div class="chart-placeholder" id="mmPlaceholder" ${state.curveBuilt ? "hidden" : ""}>Click Build kinetics plot after completing Stage 1.</div></div>
        <div class="legend"><span class="legend-item"><i class="legend-swatch point" style="--swatch:${COLORS.navy}"></i>Seven initial rates</span><span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.small}"></i>Michaelis–Menten curve</span>${state.halfGuide?`<span class="legend-item"><i class="legend-swatch" style="--swatch:${COLORS.yellow}"></i>Half maximum</span>`:""}</div>
        ${state.halfGuide ? `<div class="note"><strong>Read the guide:</strong> one-half V<sub>max</sub> = ${(KINETICS.vmax/2).toFixed(6)} mM/s intersects the reference curve at C<sub>ONPG,0</sub> = ${KINETICS.km.toFixed(2)} mM.</div>` : ""}
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${state.curveBuilt ? "" : "disabled"}>Continue to Stage 3</button></div>
  </div>`;
  const draw = () => drawMichaelis(document.getElementById("mmChart"), state.curveBuilt, state.halfGuide);
  draw();
  window.addEventListener("resize", draw, {passive:true});
  document.getElementById("buildCurve").addEventListener("click", () => { state.curveBuilt=true; saveState(); toast("Kinetics plot built and saved."); refreshStageView(renderRateCurve); });
  document.getElementById("halfGuide").addEventListener("click", () => { state.halfGuide=true; saveState(); refreshStageView(renderRateCurve); });
  document.getElementById("continueStage").addEventListener("click", () => navigate(3));
  bindStageReset(2);
  cleanupStage = () => window.removeEventListener("resize", draw);
}

function kineticRateRows() {
  return KINETICS.concentrations.map((s,i)=>`<tr><td><span class="color-key" style="--series:${COLORS.series[i]}"></span>${assayConcentrationLabel(s)}</td><td>${KINETICS.rates[i].toFixed(6)}</td></tr>`).join("");
}

function drawMichaelis(canvas, built, halfGuide) {
  const fit = [];
  for (let s=0;s<=40;s+=.2) fit.push({x:s,y:KINETICS.vmax*s/(KINETICS.km+s)});
  const series = built ? [
    {name:"Fit",color:COLORS.small,width:3,points:fit},
    {name:"Seven assay rates",color:COLORS.navy,width:0,markers:true,points:KINETICS.concentrations.map((x,i)=>({x,y:KINETICS.rates[i]}))}
  ] : [];
  if (built && halfGuide) {
    series.push({name:"half horizontal",color:COLORS.yellow,width:2,dash:[6,5],points:[{x:0,y:KINETICS.vmax/2},{x:KINETICS.km,y:KINETICS.vmax/2}]});
    series.push({name:"half vertical",color:COLORS.yellow,width:2,dash:[6,5],points:[{x:KINETICS.km,y:0},{x:KINETICS.km,y:KINETICS.vmax/2}]});
  }
  drawPlot(canvas,{xMin:0,xMax:42,yMin:0,yMax:.0027,xLabel:"Initial ONPG, C<sub>ONPG,0</sub> [mM]",yLabel:"v<sub>0</sub> [mM/s]",xTicks:[0,10,20,30,40],yTicks:[0,.0005,.001,.0015,.002,.0025],series});
}

function renderDesign() {
  const area = document.getElementById("stageArea");
  const d = state.designDiameter;
  const profile = solveBead(d);
  const eta = reportedEta(d, profile.eta);
  const assigned = getAssignedDesigns();
  area.innerHTML = `<div class="stage-shell">
    ${stageHeader(3, "Adjust bead diameter and compare two trials", "Save the required 0.6 mm and 0.3 mm trials, then explore any diameter from 0.1 to 10 mm using the slider or precise numeric entry. Save all results to compare their profiles and effectiveness factors.", "Target <span class='math-eta'>η<sub>i</sub></span> ≥ 0.95")}
    <div class="design-grid">
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>Adjustable diameter control</h3><p>Required: 0.6 and 0.3 mm. You can also enter and save any additional diameter from 0.1 to 10 mm.</p></div><span class="pass-badge ${eta>=.95?"pass":""}">${eta>=.95?"MEETS TARGET":"BELOW TARGET"}</span></div>
        <div class="slider-block">
          <div class="diameter-readout"><strong id="diameterValue">${formatDiameter(d)}</strong><span>mm diameter</span></div>
          <input class="range" id="diameterSlider" type="range" min="0.1" max="10" step="0.1" value="${d}" aria-label="Select bead diameter">
          <div class="range-scale"><span>0.1 mm</span><span>10 mm</span></div>
          <div class="exact-diameter-controls">
            <label for="diameterInput"><strong>Exact bead diameter [mm]</strong><small>Enter any value from 0.1 to 10 mm</small></label>
            <div class="exact-diameter-entry"><input id="diameterInput" type="number" min="0.1" max="10" step="any" value="${formatDiameter(d)}" aria-label="Exact bead diameter in millimeters"><button class="button button-secondary" id="applyDiameter" type="button">Calculate</button></div>
          </div>
          <div class="nudge-row"><button class="nudge" id="diameterDown" type="button" aria-label="Decrease diameter by 0.1 millimeter">−</button><button class="button" id="saveDiameter" type="button">Save result</button><button class="nudge" id="diameterUp" type="button" aria-label="Increase diameter by 0.1 millimeter">+</button></div>
          <p><strong>Required:</strong> 0.6 mm ${assigned.six?"✓ saved":"— not saved"} · 0.3 mm ${assigned.three?"✓ saved":"— not saved"}. <strong>Additional saved:</strong> ${state.designTrials.filter(t=>!isAssignedDiameter(t.diameter)).length}.</p>
        </div>
        <div class="metric-row">
          <div class="metric"><span>Internal effectiveness factor</span><strong id="etaValue">${eta.toFixed(4)}</strong></div>
          <div class="metric"><span>Surface ONPG concentration</span><strong id="surfaceValue">${format(profile.surface,3)}</strong> <small>mM</small></div>
          <div class="metric"><span>Center ONPG concentration</span><strong id="centerValue">${format(profile.center,3)}</strong> <small>mM</small></div>
        </div>
        <div class="target-track"><div class="target-fill" style="width:${Math.min(100,eta*100)}%"></div></div>
        <div class="target-label"><span>0</span><strong><span class='math-eta'>η<sub>i</sub></span> target = 0.95</strong><span>1.00</span></div>
        <div class="note"><strong>How it works:</strong> We use the same MATLAB reaction–diffusion equations applied to our laboratory experiments with 2.8 and 4.6 mm beads. The simulation extends this approach to predict ONPG concentration profiles and internal effectiveness factors for smaller and larger beads.</div>
      </section>
      <section class="panel chart-panel">
        <div class="panel-title"><div><h3>Surface-to-center ONPG profiles</h3><p>The graph shows every saved diameter, plus the current selection if it is not yet saved.</p></div></div>
        <div class="chart-frame"><canvas id="designProfileChart" aria-label="Radial ONPG concentration profiles for selected bead sizes"></canvas></div>
        <div class="legend" id="designLegend">${designLegend(assigned,d,profile)}</div>
        <div class="panel-title" style="margin-top:18px"><div><h3>Design table</h3><p>The two required rows stay visible, and additional saved diameters appear as new rows.</p></div></div>
        <div class="data-table-wrap"><table class="data-table result-table"><thead><tr><th>Result</th><th>Bead diameter [mm]</th><th>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> [-]</th><th>Surface ONPG concentration [mM]</th><th>Center ONPG concentration [mM]</th></tr></thead><tbody>${designRows(assigned)}</tbody></table></div>
      </section>
    </div>
    <div class="continue-row"><button class="button button-dark" id="continueStage" type="button" ${assigned.six && assigned.three ? "" : "disabled"}>Continue to Stage 4</button></div>
  </div>`;
  let currentProfile = profile;
  const slider = document.getElementById("diameterSlider");
  const draw=()=>drawProfiles(document.getElementById("designProfileChart"), designProfileSeries(assigned,d,currentProfile));
  draw();
  window.addEventListener("resize",draw,{passive:true});
  function setDiameter(value){
    const candidate=Number(value);
    if(!Number.isFinite(candidate)||candidate<0.1||candidate>10){
      toast("Enter a diameter between 0.1 and 10 mm.");
      document.getElementById("diameterInput").value=formatDiameter(d);return;
    }
    state.designDiameter=candidate;saveState();refreshStageView(renderDesign);
  }
  slider.addEventListener("change",event=>setDiameter(event.target.value));
  document.getElementById("applyDiameter").addEventListener("click",()=>{
    const input=document.getElementById("diameterInput");
    if(!input.value.trim()){toast("Enter a diameter to calculate.");return;}
    setDiameter(input.value);
  });
  document.getElementById("diameterInput").addEventListener("keydown",event=>{
    if(event.key==="Enter"){event.preventDefault();setDiameter(event.currentTarget.value);}
  });
  document.getElementById("diameterDown").addEventListener("click",()=>setDiameter(Number((d-0.1).toFixed(8))));
  document.getElementById("diameterUp").addEventListener("click",()=>setDiameter(Number((d+0.1).toFixed(8))));
  document.getElementById("saveDiameter").addEventListener("click",()=>{
    // Save the diameter currently typed in the exact-value box, even if
    // the student has not pressed Calculate or Enter first.
    const input = document.getElementById("diameterInput").value.trim();
    const selectedDiameter = Number(input);
    if(!input || !Number.isFinite(selectedDiameter) || selectedDiameter<0.1 || selectedDiameter>10){
      toast("Enter a diameter between 0.1 and 10 mm before saving.");return;
    }
    const selectedProfile = Math.abs(selectedDiameter-d)<1e-12 ? profile : solveBead(selectedDiameter);
    const trial={diameter:selectedDiameter,eta:reportedEta(selectedDiameter,selectedProfile.eta),
      surface:selectedProfile.surface,center:selectedProfile.center,profile:selectedProfile};
    state.designTrials=state.designTrials.filter(t=>Math.abs(t.diameter-selectedDiameter)>1e-9);
    state.designTrials.push(trial);state.designTrials.sort((a,b)=>a.diameter-b.diameter);
    state.designDiameter=selectedDiameter;
    saveState();toast(`${formatDiameter(selectedDiameter)} mm model result saved.`);refreshStageView(renderDesign);
  });
  document.getElementById("continueStage").addEventListener("click", () => navigate(4));
  bindStageReset(3);
  cleanupStage = () => window.removeEventListener("resize",draw);
}

function reportedEta(d, raw) { return raw; }

function getAssignedDesigns() {
  const trials = state.designTrials || [];
  return {three: trials.find(t=>Math.abs(t.diameter-0.3)<0.001) || null,
          six: trials.find(t=>Math.abs(t.diameter-0.6)<0.001) || null};
}

function formatDiameter(diameter) { return String(diameter); }
function isAssignedDiameter(diameter) { return Math.abs(diameter-0.3)<1e-9 || Math.abs(diameter-0.6)<1e-9; }

function designRows(assigned) {
  const small=solveBead(2.8,"small"), large=solveBead(4.6,"large");
  const row=(label,d,t)=>`<tr><td>${label}</td><td>${formatDiameter(d)}</td><td>${t?t.eta.toFixed(4):"—"}</td><td>${t?format(t.surface,3):"—"}</td><td>${t?format(t.center,3):"—"}</td></tr>`;
  const fixed=row("Large laboratory bead",4.6,large) +
    row("Small laboratory bead",2.8,small) +
    row("Required design",0.6,assigned.six) + row("Required design",0.3,assigned.three);
  const extras=state.designTrials.filter(t=>!isAssignedDiameter(t.diameter))
    .sort((a,b)=>a.diameter-b.diameter).map(t=>row("Additional saved design",t.diameter,t)).join("");
  return fixed+extras;
}

function designProfileSeries(assigned,d,currentProfile) {
  const trials=state.designTrials.slice().sort((a,b)=>a.diameter-b.diameter);
  const colors=[COLORS.navy,...COLORS.series];
  const result=trials.map((t,i)=>({
    name:`${formatDiameter(t.diameter)} mm`,
    color:Math.abs(t.diameter-0.6)<1e-9?COLORS.large:Math.abs(t.diameter-0.3)<1e-9?COLORS.small:colors[i%colors.length],
    profile:t.profile||solveBead(t.diameter)
  }));
  if(!trials.some(t=>Math.abs(t.diameter-d)<1e-9))result.push({name:`${formatDiameter(d)} mm (current)`,color:COLORS.yellow,profile:currentProfile});
  return result;
}

function designLegend(assigned,d,currentProfile) {
  return designProfileSeries(assigned,d,currentProfile).map(p=>
    `<span class="legend-item"><i class="legend-swatch" style="--swatch:${p.color}"></i>d = ${p.name}</span>`
  ).join("");
}

// Map diameter to inputs for the original MATLAB bead-scale boundary-value
// problem. Use only the previously established 2.8/4.6-mm model inputs
// (NOT numerical examples from the transport workbook).
//
// Outside the reference interval: phi is proportional to radius for unchanged
// kinetic properties and diffusivity; N_B is proportional to sqrt(diameter)
// from Re~d, Sh~Re^0.5 and k_c=Sh*D_water/d at constant fluid velocity.
// Inside: interpolate phi and N_B between the two independently calibrated
// reference input sets in log-diameter space. This is an empirical estimate
// for unmeasured bead sizes, not a claim of independently known properties.
// The endpoints are exact and continuous; no model switches at 2.8/4.6 mm.
function diameterModelInputs(diameter) {
  const small = LAB.small, large = LAB.large;
  if (diameter <= small.diameter) {
    const ratio = diameter / small.diameter;
    return {phi:small.phi*ratio, biot:small.biot*Math.sqrt(ratio)};
  }
  if (diameter >= large.diameter) {
    const ratio = diameter / large.diameter;
    return {phi:large.phi*ratio, biot:large.biot*Math.sqrt(ratio)};
  }
  const fraction = Math.log(diameter/small.diameter) /
    Math.log(large.diameter/small.diameter);
  return {
    phi:small.phi*Math.pow(large.phi/small.phi,fraction),
    biot:small.biot*Math.pow(large.biot/small.biot,fraction)
  };
}

function solveBead(diameter, fixedKey=null) {
  const cBulk = INITIAL_ONPG / PROFILE_CONCENTRATION_SCALE;
  // All diameters use the same MATLAB-equivalent nonlinear differential
  // equation and boundary conditions. Reference results use their exact
  // originally calibrated parameter sets.
  const inputs = fixedKey
    ? {phi:LAB[fixedKey].phi, biot:LAB[fixedKey].biot}
    : diameterModelInputs(diameter);
  const {phi,biot} = inputs;
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
  return {eta,surface:solved.c*PROFILE_CONCENTRATION_SCALE,center:(lo+hi)/2*PROFILE_CONCENTRATION_SCALE,points:solved.points,diameter,phi,biot};
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
      if(s.markerShape==="triangle"){ctx.moveTo(x,y-6);ctx.lineTo(x+5,y+4);ctx.lineTo(x-5,y+4);ctx.closePath();ctx.fillStyle=s.color;ctx.fill();ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.stroke();}
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
  if(state.kinetics.ratesShown) sections.push(`<div class="panel-title" style="margin-top:20px"><div><h3>Free-enzyme initial rates</h3></div></div><div class="data-table-wrap"><table class="data-table kinetics-table"><thead><tr><th>Initial ONPG concentration, C<sub>ONPG,0</sub> [mM]</th><th>Initial rate, v<sub>0</sub> [mM/s]</th></tr></thead><tbody>${kineticRateRows()}</tbody></table></div><p class="assay-source-note">Six supplied laboratory rates and one 39.8 mM simulated assay are included.</p>`);
  if(state.designTrials.length) sections.push(`<div class="panel-title" style="margin-top:20px"><div><h3>Saved bead designs</h3></div></div><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Bead diameter [mm]</th><th>Internal effectiveness factor, <span class='math-eta'>η<sub>i</sub></span> [-]</th><th>Surface ONPG concentration [mM]</th><th>Center ONPG concentration [mM]</th></tr></thead><tbody>${state.designTrials.map(t=>`<tr><td>${formatDiameter(t.diameter)}</td><td>${format(t.eta)}</td><td>${format(t.surface)}</td><td>${format(t.center)}</td></tr>`).join("")}</tbody></table></div>`);
  body.innerHTML=sections.length?sections.join(""):`<div class="empty-state"><h3>No results saved yet</h3><p>Begin in Stage 1 with the kinetic scan, or go to Stage 4 to collect the six bead-reactor readings.</p></div>`;
}

function sessionCsv() {
  const rows=[["section","condition","simulation_time_s","equivalent_reaction_time_min","ABS415","ONP_mM","initial_rate_mM_s","diameter_mm","eta_i","surface_ONPG_mM","center_ONPG_mM","source"]];
  for(const key of ["small","large"]) state.beadRuns[key].samples.forEach(s=>rows.push(["bead sample",`${LAB[key].diameter} mm`,s.simulationSeconds,s.laboratoryMinutes,s.a415,s.onp,"",LAB[key].diameter,"","","","supplied reactor data"]));
  if(state.kinetics.ratesShown) KINETICS.concentrations.forEach((s,i)=>rows.push(["free-enzyme kinetics",`${s} mM ONPG`,"","","","",KINETICS.rates[i],"","","","",i<6?"supplied laboratory assay":"simulated virtual assay"]));
  state.designTrials.forEach(t=>rows.push(["bead design",`${t.diameter} mm`,"","","","","",t.diameter,t.eta,t.surface,t.center,"bead-scale model"]));
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
