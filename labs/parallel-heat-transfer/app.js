    (() => {
      const root = document.getElementById('pht-review-preview');
      if (!root) return;

      const SIGMA = 5.670374419e-8;
      const AMBIENT_C = 25;
      const LIMIT_C = 60;
      const geometry = { diameter: 1, length: 6, wall: 0.025, steelK: 45 };
      const state = { stage: 1, stage1: [], stage2: [], safetyStep: 20, safetyRuns: [] };

      function cToK(c) { return Number(c) + 273.15; }
      function solve({ processC, insulationM, conductivity, emissivity, h }) {
        const processK = cToK(processC);
        const ambientK = cToK(AMBIENT_C);
        const t = Math.max(Number(insulationM), 0);
        const epsilon = Math.min(1, Math.max(0, Number(emissivity)));
        const convection = Math.max(Number(h), 0);
        const k = Math.max(Number(conductivity), 1e-12);
        const rInner = geometry.diameter / 2;
        const rSteel = rInner + geometry.wall;
        const rOuter = rSteel + t;
        const area = 2 * Math.PI * rOuter * geometry.length;
        const rWall = Math.log(rSteel / rInner) / (2 * Math.PI * geometry.length * geometry.steelK);
        const rIns = t <= 1e-12 ? 0 : Math.log(rOuter / rSteel) / (2 * Math.PI * geometry.length * k);
        const resistance = rWall + rIns;
        const outside = surfaceK => ({
          conv: convection * area * (surfaceK - ambientK),
          rad: epsilon * SIGMA * area * (surfaceK ** 4 - ambientK ** 4)
        });
        let lo = Math.min(processK, ambientK);
        let hi = Math.max(processK, ambientK);
        if (epsilon <= 1e-12 && convection <= 1e-12) {
          lo = processK;
          hi = processK;
        } else {
          for (let i = 0; i < 64; i += 1) {
            const mid = (lo + hi) / 2;
            const ext = outside(mid);
            const residual = (processK - mid) / resistance - ext.conv - ext.rad;
            if (residual > 0) lo = mid; else hi = mid;
          }
        }
        const surfaceK = (lo + hi) / 2;
        const ext = outside(surfaceK);
        const qCondW = (processK - surfaceK) / resistance;
        const wallOuterK = processK - qCondW * rWall;
        return {
          processC: Number(processC),
          wallOuterC: wallOuterK - 273.15,
          surfaceC: surfaceK - 273.15,
          qCondW,
          qConvW: ext.conv,
          qRadW: ext.rad,
          qTotalW: ext.conv + ext.rad,
          outerDiameterM: 2 * rOuter
        };
      }

      function fmt(value, digits) { return Number(value).toFixed(digits); }
      function kw(value) { return Number(value) / 1000; }
      function safetyInputs(step) { return { processC: 800, insulationM: step * 0.005, conductivity: 0.080, emissivity: 0.85, h: 8 }; }
      function temperatureColor(surfaceC) {
        if (!Number.isFinite(surfaceC)) return '#8ab4bc';
        const f = Math.min(1, Math.max(0, (surfaceC - 25) / 560));
        if (f < .35) {
          const x = f / .35;
          return `rgb(${Math.round(73 + 168*x)},${Math.round(166 + 45*x)},${Math.round(203 - 78*x)})`;
        }
        const x = (f - .35) / .65;
        return `rgb(${Math.round(241 - 13*x)},${Math.round(211 - 145*x)},${Math.round(125 - 80*x)})`;
      }
      function updateApparatus(stage, inputs, result, statusText) {
        const panel = root.querySelector(`[data-apparatus="${stage}"]`);
        const surfaceK = cToK(result.surfaceC);
        const ambientK = cToK(AMBIENT_C);
        const hRad = inputs.emissivity * SIGMA * (surfaceK + ambientK) * (surfaceK ** 2 + ambientK ** 2);
        panel.querySelector('.pht-h-value').textContent = fmt(inputs.h, 2);
        panel.querySelector('.pht-hrad-value').textContent = fmt(hRad, 2);
        const vessel = panel.querySelector('.pht-vessel');
        const wallCard = panel.querySelector('.pht-wall-card');
        const thickness = Math.max(0, Number(inputs.insulationM));
        const insulationPixels = thickness <= 0 ? 0 : Math.max(2, Math.round(Math.min(.5, thickness) / .5 * 28));
        const wallPixels = thickness <= 0 ? 0 : Math.max(4, Math.round(Math.min(.5, thickness) / .5 * 50));
        const interfaceColor = temperatureColor(result.wallOuterC);
        const surfaceColor = temperatureColor(result.surfaceC);
        vessel.style.setProperty('--pht-insulation', `${insulationPixels}px`);
        vessel.style.setProperty('--pht-ins-color', surfaceColor);
        wallCard.style.setProperty('--pht-wall-insulation', `${wallPixels}px`);
        wallCard.style.setProperty('--pht-ins-inner', interfaceColor);
        wallCard.style.setProperty('--pht-ins-outer', surfaceColor);
        panel.querySelector('.pht-insulation-label').innerHTML = `Insulation: t<sub>ins</sub> = ${fmt(thickness,3)} m · k<sub>ins</sub> = ${fmt(inputs.conductivity,3)} W/(m·K)`;
        panel.querySelector('.pht-wall-interface-temp').textContent = `${fmt(result.wallOuterC,1)} °C`;
        panel.querySelector('.pht-wall-surface-temp').textContent = `${fmt(result.surfaceC,1)} °C`;
        const sensor = panel.querySelector('.pht-sensor');
        if (sensor) {
          sensor.querySelector('strong').textContent = `${fmt(result.surfaceC,2)} °C`;
          sensor.querySelector('small').textContent = statusText || 'Calculated';
        }
        panel.querySelector('.pht-apparatus-q').innerHTML = `Total heat loss, Q̇<sub>total</sub>: ${fmt(kw(result.qTotalW),3)} kW`;
      }

      function updateSessionChrome() {
        const counts = { 1: state.stage1.length, 2: state.stage2.length, 3: state.safetyRuns.length };
        const total = counts[1] + counts[2] + counts[3];
        document.getElementById('dataCount').textContent = String(total);
        document.querySelectorAll('.step').forEach(tab => {
          const number = Number(tab.dataset.stage);
          const selected = number === state.stage;
          tab.classList.toggle('active', selected);
          tab.classList.toggle('complete', counts[number] > 0 && !selected);
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
        });
      }

      function switchStage(stage) {
        state.stage = Math.min(3, Math.max(1, Number(stage) || 1));
        [1,2,3].forEach(number => { root.querySelector(`#pht-stage-${number}`).hidden = number !== state.stage; });
        updateSessionChrome();
        requestAnimationFrame(drawAllCharts);
      }
      document.querySelectorAll('.step').forEach(tab => tab.addEventListener('click', () => switchStage(Number(tab.dataset.stage))));
      root.querySelectorAll('[data-next-stage]').forEach(button => button.addEventListener('click', () => {
        switchStage(Number(button.dataset.nextStage));
        document.getElementById('stageArea').focus({ preventScroll: true });
        document.getElementById('stageArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));

      function setText(id, value) { root.querySelector(`#${id}`).textContent = value; }
      function runStage1() {
        const epsilonText = root.querySelector('#pht-epsilon').value.trim();
        const hText = root.querySelector('#pht-h').value.trim();
        const error = root.querySelector('#pht-error-1');
        const epsilon = Number(epsilonText);
        const h = Number(hText);
        if (epsilonText === '' || hText === '' || !Number.isFinite(epsilon) || !Number.isFinite(h) || epsilon < 0 || epsilon > 1 || h < 0 || h > 50) {
          error.textContent = 'Enter emissivity from 0.00 to 1.00 and h from 0 to 50 W/(m²·K).';
          return;
        }
        error.textContent = '';
        const inputs = { processC: 800, insulationM: .100, conductivity: .080, emissivity: epsilon, h };
        const result = solve(inputs);
        state.stage1.push({ label: `Trial ${state.stage1.length + 1}`, inputs, result });
        setText('pht-m1-temp', `${fmt(result.surfaceC,2)} °C`);
        setText('pht-m1-conv', `${fmt(kw(result.qConvW),3)} kW`);
        setText('pht-m1-rad', `${fmt(kw(result.qRadW),3)} kW`);
        updateApparatus(1, inputs, result, 'Calculated');
        renderStage1Table();
      }
      function renderStage1Table() {
        const tbody = root.querySelector('#pht-table-1');
        const row = record => `<tr><td>${record.label}</td><td>${fmt(record.inputs.emissivity,2)}</td><td>${fmt(record.inputs.h,1)}</td><td>${fmt(record.result.surfaceC,2)}</td><td>${fmt(kw(record.result.qConvW),3)}</td><td>${fmt(kw(record.result.qRadW),3)}</td><td>${fmt(kw(record.result.qTotalW),3)}</td></tr>`;
        tbody.innerHTML = state.stage1.map(row).join('') || '<tr class="pht-empty-row"><td colspan="7">No trials recorded yet.</td></tr>';
        updateSessionChrome();
      }
      function resetStage1() {
        state.stage1 = [];
        root.querySelector('#pht-epsilon').value = '';
        root.querySelector('#pht-h').value = '';
        root.querySelector('#pht-error-1').textContent = '';
        ['pht-m1-temp','pht-m1-conv','pht-m1-rad'].forEach(id => setText(id,'—'));
        renderStage1Table();
        const panel = root.querySelector('[data-apparatus="1"]');
        panel.querySelector('.pht-vessel').style.cssText = '';
        panel.querySelector('.pht-wall-card').style.cssText = '';
        panel.querySelector('.pht-wall-interface-temp').textContent = '—';
        panel.querySelector('.pht-wall-surface-temp').textContent = '—';
        panel.querySelector('.pht-sensor strong').textContent = '—';
        panel.querySelector('.pht-sensor small').textContent = 'Run a trial';
        panel.querySelector('.pht-apparatus-q').innerHTML = 'Total heat loss, Q̇<sub>total</sub>: —';
        panel.querySelector('.pht-h-value').textContent = '—';
        panel.querySelector('.pht-hrad-value').textContent = '—';
      }

      function runStage2() {
        const text = root.querySelector('#pht-thickness-2').value.trim();
        const thickness = Number(text);
        const error = root.querySelector('#pht-error-2');
        if (text === '' || !Number.isFinite(thickness) || thickness < 0 || thickness > .5) {
          error.textContent = 'Enter an insulation thickness from 0.000 to 0.500 m.';
          return;
        }
        error.textContent = '';
        const inputs = { processC: 800, insulationM: thickness, conductivity: .080, emissivity: .85, h: 8 };
        const result = solve(inputs);
        state.stage2.push({ label: `Trial ${state.stage2.length + 4}`, inputs, result });
        setText('pht-m2-temp', `${fmt(result.surfaceC,2)} °C`);
        setText('pht-m2-total', `${fmt(kw(result.qTotalW),3)} kW`);
        setText('pht-m2-diameter', `${fmt(result.outerDiameterM,3)} m`);
        updateApparatus(2, inputs, result, 'Calculated');
        renderStage2Table();
        drawStage2Chart();
      }
      function renderStage2Table() {
        const tbody = root.querySelector('#pht-table-2');
        const row = record => `<tr><td>${record.label}</td><td>${fmt(record.inputs.insulationM,3)}</td><td>${fmt(record.result.surfaceC,2)}</td><td>${fmt(kw(record.result.qCondW),3)}</td><td>${fmt(kw(record.result.qConvW),3)}</td><td>${fmt(kw(record.result.qRadW),3)}</td><td>${fmt(kw(record.result.qTotalW),3)}</td></tr>`;
        tbody.innerHTML = state.stage2.map(row).join('') || '<tr class="pht-empty-row"><td colspan="7">No trials recorded yet.</td></tr>';
        updateSessionChrome();
      }
      function resetStage2() {
        state.stage2 = [];
        root.querySelector('#pht-thickness-2').value = '';
        root.querySelector('#pht-error-2').textContent = '';
        ['pht-m2-temp','pht-m2-total','pht-m2-diameter'].forEach(id => setText(id,'—'));
        renderStage2Table();
        const panel = root.querySelector('[data-apparatus="2"]');
        panel.querySelector('.pht-vessel').style.cssText = '--pht-insulation:0px';
        panel.querySelector('.pht-wall-card').style.cssText = '--pht-wall-insulation:0px';
        panel.querySelector('.pht-wall-interface-temp').textContent = '—';
        panel.querySelector('.pht-wall-surface-temp').textContent = '—';
        panel.querySelector('.pht-insulation-label').textContent = 'Enter an insulation thickness';
        panel.querySelector('.pht-sensor strong').textContent = '—';
        panel.querySelector('.pht-sensor small').textContent = 'Run a trial';
        panel.querySelector('.pht-apparatus-q').innerHTML = 'Total heat loss, Q̇<sub>total</sub>: —';
        panel.querySelector('.pht-h-value').textContent = '—';
        panel.querySelector('.pht-hrad-value').textContent = '—';
        drawStage2Chart();
      }

      function updateSafety() {
        const step = state.safetyStep;
        const inputs = safetyInputs(step);
        const result = solve(inputs);
        const safe = result.surfaceC <= LIMIT_C + 1e-9;
        setText('pht-safety-thickness', `${fmt(inputs.insulationM,3)} m`);
        root.querySelector('#pht-safety-range').value = String(step);
        root.querySelector('#pht-minus').disabled = step === 0;
        root.querySelector('#pht-plus').disabled = step === 100;
        const banner = root.querySelector('#pht-safety-banner');
        banner.classList.toggle('pht-pass', safe);
        banner.innerHTML = `<strong>${safe ? 'PASS · surface temperature is at or below the 60 °C limit' : 'FAIL · surface temperature exceeds the 60 °C limit'}</strong><span>Current: ${fmt(result.surfaceC,2)} °C</span>`;
        updateApparatus(3, inputs, result, safe ? '≤ 60 °C' : '> 60 °C');
        renderSafetyTable();
        drawSafetyChart();
      }
      function renderSafetyTable() {
        const row = record => {
          const safe = record.result.surfaceC <= LIMIT_C;
          return `<tr><td>${record.label}</td><td>${fmt(record.inputs.insulationM,3)}</td><td>${fmt(record.result.surfaceC,2)}</td><td>${fmt(kw(record.result.qConvW),3)}</td><td>${fmt(kw(record.result.qRadW),3)}</td><td>${fmt(kw(record.result.qTotalW),3)}</td><td class="${safe ? 'pht-status-pass' : 'pht-status-fail'}">${safe ? 'PASS' : 'FAIL'}</td></tr>`;
        };
        root.querySelector('#pht-table-3').innerHTML = state.safetyRuns.map(row).join('') || '<tr class="pht-empty-row"><td colspan="7">No trials recorded yet.</td></tr>';
        updateSessionChrome();
      }

      function canvasSetup(canvas) {
        if (!canvas || canvas.clientWidth < 40) return null;
        const width = canvas.clientWidth;
        const height = 150;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio,0,0,ratio,0,0);
        ctx.clearRect(0,0,width,height);
        const style = getComputedStyle(root);
        const resolveColor = property => {
          const probe = document.createElement('span');
          probe.style.color = `var(${property})`;
          probe.style.display = 'none';
          root.appendChild(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        };
        return { ctx, width, height, colors: {
          text: resolveColor('--pht-text') || style.color,
          muted: resolveColor('--pht-muted'),
          line: resolveColor('--pht-line'),
          navy: resolveColor('--pht-navy'),
          teal: resolveColor('--pht-teal'),
          blue: resolveColor('--pht-blue'),
          orange: resolveColor('--pht-orange'),
          red: resolveColor('--pht-red'),
          green: resolveColor('--pht-green'),
          yellow: resolveColor('--pht-yellow')
        }};
      }
      function chartFrame(prepared, xLabel, yLabel, yTicks) {
        const {ctx,width,height,colors} = prepared;
        const m = {left: 52,right: 14,top: 14,bottom: 38};
        const plot = {x:m.left,y:m.top,w:width-m.left-m.right,h:height-m.top-m.bottom};
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        yTicks.forEach(tick => {
          const py = plot.y + plot.h - tick.p * plot.h;
          ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(plot.x,py); ctx.lineTo(plot.x+plot.w,py); ctx.stroke();
          ctx.fillStyle = colors.muted; ctx.textAlign = 'right'; ctx.fillText(tick.label,plot.x-7,py);
        });
        ctx.strokeStyle = colors.muted; ctx.beginPath(); ctx.moveTo(plot.x,plot.y); ctx.lineTo(plot.x,plot.y+plot.h); ctx.lineTo(plot.x+plot.w,plot.y+plot.h); ctx.stroke();
        ctx.fillStyle = colors.text; ctx.textAlign = 'center'; ctx.fillText(xLabel,plot.x+plot.w/2,height-11);
        ctx.save(); ctx.translate(12,plot.y+plot.h/2); ctx.rotate(-Math.PI/2); ctx.fillText(yLabel,0,0); ctx.restore();
        return plot;
      }
      function drawEmpty(ctx, width, text, colors) { ctx.fillStyle = colors.muted; ctx.font = '12px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(text,width/2,105); }
      function drawStage2Chart() {
        const prepared = canvasSetup(root.querySelector('#pht-chart-2'));
        if (!prepared) return;
        const {ctx,width,colors} = prepared;
        if (!state.stage2.length) { drawEmpty(ctx,width,'Run thickness trials to build the comparison.',colors); return; }
        const records = [...state.stage2].sort((a,b)=>a.inputs.insulationM-b.inputs.insulationM);
        const maxY = Math.max(...records.map(r=>r.result.surfaceC),60)*1.08;
        const plot = chartFrame(prepared,'Insulation thickness (m)','Surface temperature (°C)',[0,.25,.5,.75,1].map(p=>({p,label:fmt(maxY*p,0)})));
        const x = value => plot.x + value/.5*plot.w;
        const y = value => plot.y+plot.h-value/maxY*plot.h;
        ctx.strokeStyle=colors.teal; ctx.fillStyle=colors.teal; ctx.lineWidth=2.5; ctx.beginPath();
        records.forEach((record,i)=>{ const px=x(record.inputs.insulationM),py=y(record.result.surfaceC); if(i===0)ctx.moveTo(px,py);else ctx.lineTo(px,py); }); ctx.stroke();
        records.forEach(record=>{ctx.beginPath();ctx.arc(x(record.inputs.insulationM),y(record.result.surfaceC),4.5,0,Math.PI*2);ctx.fill();});
        ctx.fillStyle=colors.muted;ctx.textAlign='center';[0,.1,.2,.3,.4,.5].forEach(v=>ctx.fillText(v.toFixed(1),x(v),plot.y+plot.h+14));
      }
      function drawSafetyChart() {
        const prepared = canvasSetup(root.querySelector('#pht-chart-3'));
        if (!prepared) return;
        const {ctx,colors} = prepared;
        const yMin=20,yMax=800;
        const plot=chartFrame(prepared,'Insulation thickness (m)','Surface temperature (°C)',[20,60,200,400,600,800].map(v=>({p:(v-yMin)/(yMax-yMin),label:String(v)})));
        const x=value=>plot.x+value/.5*plot.w;
        const y=value=>plot.y+plot.h-(value-yMin)/(yMax-yMin)*plot.h;
        ctx.strokeStyle=colors.red;ctx.lineWidth=2;ctx.setLineDash([6,5]);ctx.beginPath();ctx.moveTo(plot.x,y(60));ctx.lineTo(plot.x+plot.w,y(60));ctx.stroke();ctx.setLineDash([]);
        ctx.strokeStyle=colors.teal;ctx.lineWidth=2.5;ctx.beginPath();
        for(let step=0;step<=100;step+=1){const t=step*.005;const s=solve(safetyInputs(step)).surfaceC;if(step===0)ctx.moveTo(x(t),y(s));else ctx.lineTo(x(t),y(s));}ctx.stroke();
        state.safetyRuns.forEach(record=>{
          const safe=record.result.surfaceC<=LIMIT_C;
          ctx.fillStyle=safe?colors.green:colors.red;
          ctx.beginPath();ctx.arc(x(record.inputs.insulationM),y(record.result.surfaceC),4.5,0,Math.PI*2);ctx.fill();
        });
        const current=solve(safetyInputs(state.safetyStep));
        ctx.fillStyle=colors.yellow;ctx.strokeStyle=colors.navy;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x(state.safetyStep*.005),y(current.surfaceC),6,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.fillStyle=colors.muted;ctx.textAlign='center';[0,.1,.2,.3,.4,.5].forEach(v=>ctx.fillText(v.toFixed(1),x(v),plot.y+plot.h+14));
      }
      function drawAllCharts(){drawStage2Chart();drawSafetyChart();}

      function allRecords() {
        return [
          ...state.stage1.map(record => ({ experiment: 'Parallel paths', ...record })),
          ...state.stage2.map(record => ({ experiment: 'Series conduction', ...record })),
          ...state.safetyRuns.map(record => ({ experiment: 'Safety limit', ...record }))
        ];
      }

      function dataDialogHtml() {
        const records = allRecords();
        if (!records.length) {
          return '<div class="empty-state"><strong>No trials recorded yet.</strong><br>Run an experiment to add data. This tab starts empty and never shares results with another student.</div>';
        }
        const rows = records.map(record => {
          const safety = record.experiment === 'Safety limit' ? (record.result.surfaceC <= LIMIT_C + 1e-9 ? 'PASS' : 'FAIL') : '—';
          return `<tr><td>${record.experiment}</td><td>${record.label}</td><td>${fmt(record.inputs.insulationM,3)}</td><td>${fmt(record.inputs.emissivity,2)}</td><td>${fmt(record.inputs.h,1)}</td><td>${fmt(record.result.surfaceC,2)}</td><td>${fmt(kw(record.result.qTotalW),3)}</td><td>${safety}</td></tr>`;
        }).join('');
        return `<p class="note" style="margin-top:0">These results exist only in this open tab. Refreshing or closing the page clears them.</p><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Experiment</th><th>Trial</th><th>t<sub>ins</sub> (m)</th><th>ε</th><th>h (W/m²·K)</th><th>T<sub>s</sub> (°C)</th><th>Q̇<sub>total</sub> (kW)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }

      function escapeCsv(value) {
        const text = String(value ?? '');
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }

      function downloadCsv() {
        const records = allRecords();
        if (!records.length) {
          showToast('Record at least one trial before downloading data.');
          return;
        }
        const header = ['experiment','trial','process_C','ambient_C','insulation_m','conductivity_W_mK','emissivity','h_W_m2K','wall_outer_C','surface_C','q_cond_kW','q_conv_kW','q_rad_kW','q_total_kW','outer_diameter_m','safety_status'];
        const rows = records.map(record => {
          const status = record.experiment === 'Safety limit' ? (record.result.surfaceC <= LIMIT_C + 1e-9 ? 'PASS' : 'FAIL') : '';
          return [
            record.experiment,
            record.label,
            fmt(record.inputs.processC,2),
            fmt(AMBIENT_C,2),
            fmt(record.inputs.insulationM,3),
            fmt(record.inputs.conductivity,3),
            fmt(record.inputs.emissivity,2),
            fmt(record.inputs.h,1),
            fmt(record.result.wallOuterC,6),
            fmt(record.result.surfaceC,6),
            fmt(kw(record.result.qCondW),6),
            fmt(kw(record.result.qConvW),6),
            fmt(kw(record.result.qRadW),6),
            fmt(kw(record.result.qTotalW),6),
            fmt(record.result.outerDiameterM,6),
            status
          ];
        });
        const csv = [header, ...rows].map(row => row.map(escapeCsv).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = 'parallel_heat_transfer_student_trials.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      let toastTimer;
      function showToast(message) {
        const toast = document.getElementById('toast');
        window.clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('show');
        toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
      }

      function resetSession() {
        state.stage1 = [];
        state.stage2 = [];
        state.safetyRuns = [];
        state.safetyStep = 20;
        resetStage1();
        resetStage2();
        updateSafety();
        switchStage(1);
      }

      function bindDialogs() {
        const dataDialog = document.getElementById('dataDialog');
        const modelDialog = document.getElementById('modelDialog');
        const aboutDialog = document.getElementById('aboutDialog');
        document.getElementById('openAbout').addEventListener('click', () => aboutDialog.showModal());
        document.getElementById('closeAbout').addEventListener('click', () => aboutDialog.close());
        document.getElementById('openData').addEventListener('click', () => {
          document.getElementById('dataDialogBody').innerHTML = dataDialogHtml();
          dataDialog.showModal();
        });
        document.getElementById('closeData').addEventListener('click', () => dataDialog.close());
        document.getElementById('openModel').addEventListener('click', () => modelDialog.showModal());
        document.getElementById('closeModel').addEventListener('click', () => modelDialog.close());
        document.getElementById('downloadCsv').addEventListener('click', downloadCsv);
        document.getElementById('clearData').addEventListener('click', () => {
          const count = allRecords().length;
          if (count && !window.confirm(`Clear all ${count} recorded trial${count === 1 ? '' : 's'} from this tab?`)) return;
          resetSession();
          dataDialog.close();
          showToast('This tab has been reset.');
        });
        [dataDialog, modelDialog, aboutDialog].forEach(dialog => dialog.addEventListener('click', event => {
          const bounds = dialog.getBoundingClientRect();
          const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
          if (outside) dialog.close();
        }));
      }

      root.querySelector('#pht-run-1').addEventListener('click',runStage1);
      root.querySelector('#pht-reset-1').addEventListener('click',resetStage1);
      root.querySelector('#pht-run-2').addEventListener('click',runStage2);
      root.querySelector('#pht-reset-2').addEventListener('click',resetStage2);
      root.querySelector('#pht-safety-range').addEventListener('input',event=>{state.safetyStep=Number(event.target.value);updateSafety();});
      root.querySelector('#pht-minus').addEventListener('click',()=>{state.safetyStep=Math.max(0,state.safetyStep-1);updateSafety();});
      root.querySelector('#pht-plus').addEventListener('click',()=>{state.safetyStep=Math.min(100,state.safetyStep+1);updateSafety();});
      root.querySelector('#pht-record-safety').addEventListener('click',()=>{
        const inputs=safetyInputs(state.safetyStep);
        state.safetyRuns.push({label:`Trial ${state.safetyRuns.length+7}`,step:state.safetyStep,inputs,result:solve(inputs)});
        updateSafety();
      });

      if ('ResizeObserver' in window) {
        const resizeObserver = new ResizeObserver(() => drawAllCharts());
        resizeObserver.observe(root);
      } else {
        window.addEventListener('resize', drawAllCharts);
      }
      bindDialogs();
      updateSafety();
      switchStage(1);
      requestAnimationFrame(drawAllCharts);
    })();
