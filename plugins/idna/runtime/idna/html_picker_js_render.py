"""JavaScript render functions for the IDNA picker page (state → DOM)."""

PICKER_JS_RENDER = r"""
let state = null, treeNodes = null, selected = null, pollTimer = null, confirming = false, artifactType = 'image', _failCount = 0;

window._cardW = parseInt(localStorage.getItem('idna-card-w') || '220');
function resizeCards(d) {
  window._cardW = Math.max(120, Math.min(480, window._cardW + d));
  document.documentElement.style.setProperty('--card-w', window._cardW + 'px');
  localStorage.setItem('idna-card-w', window._cardW);
  const lbl = document.getElementById('sizeLabel');
  if (lbl) lbl.textContent = window._cardW;
}
(function(){
  document.documentElement.style.setProperty('--card-w', window._cardW + 'px');
  const lbl = document.getElementById('sizeLabel');
  if (lbl) lbl.textContent = window._cardW;
})();

function toggleTheme() {
  document.documentElement.dataset.theme =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
}

document.addEventListener('keydown', e => {
  if (e.key === 't') { toggleTheme(); return; }
  if (e.key === 'Backspace' && e.altKey) { goBack(); return; }
  if (!state || !treeNodes) return;
  const variants = currentVariants();
  if (!variants) return;
  const readyVariants = variants.filter(n => n.status === 'ready');
  const keys = ['1','2','3','4','a','b','c','d'];
  const idx = keys.indexOf(e.key);
  if (idx >= 0 && idx < readyVariants.length) { pick(readyVariants[idx].id); return; }
  if (e.key === 'Enter') confirmPick();
  if (e.key === 'f') finalize();
});

function currentRound() {
  return state ? (state.path || []).length : 0;
}

function currentVariants() {
  if (!treeNodes) return null;
  const path = state.path || [];
  const round = path.length;
  if (round === 0) {
    return Object.values(treeNodes).filter(n => n.round === 0);
  }
  const parentId = path[path.length - 1];
  const parentNode = treeNodes[parentId];
  const children = Object.values(treeNodes).filter(n => n.parent === parentId);
  return parentNode ? [parentNode, ...children] : children;
}

function mutClass(m) {
  if (!m) return '';
  if (m.startsWith('axis:')) return 'mut-axis';
  return {amplify:'mut-amplify', blend:'mut-blend', refine:'mut-refine'}[m.toLowerCase()] || '';
}
function mutLabel(m) {
  if (!m) return '';
  if (m.startsWith('axis:')) {
    const parts = m.split(':');
    return parts[1] + (parts[2] === '+1' ? '\u2191' : '\u2193');
  }
  return m;
}

function smartUpdateCards(variants) {
  const grid = document.getElementById('grid');
  if (!grid) return false;
  if (variants.some(n => !document.getElementById('card-' + n.id))) return false;
  variants.forEach(node => {
    const card = document.getElementById('card-' + node.id);
    if (!card) return;
    const isReady = node.status === 'ready';
    const wasReady = card.classList.contains('ready');
    if (isReady === wasReady) return;
    if (isReady) {
      const spinner = card.querySelector('.mini-spinner');
      if (spinner) spinner.style.animationIterationCount = '1';
      setTimeout(() => {
        card.classList.remove('pending', 'encoding');
        card.classList.add('ready');
        card.onclick = () => pick(node.id);
        const wrap = card.querySelector('.card-img-wrap');
        if (wrap && node.artifact) {
          const img = document.createElement('img');
          img.src = node.artifact;
          img.alt = node.label;
          img.loading = 'eager';
          img.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 0.4s';
          img.onload = () => { requestAnimationFrame(() => { img.style.opacity = '1'; }); };
          wrap.innerHTML = '';
          wrap.appendChild(img);
        }
        card.querySelector('.card-placeholder')?.remove();
      }, 750);
    } else {
      card.className = `card ${node.status}`;
    }
  });
  return true;
}

function render() {
  if (!state || !treeNodes) return;
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2) {
    document.getElementById('proj-label').textContent = `${parts[0]} / ${parts[1]}`;
  }
  const backBtn = document.getElementById('back-btn');
  if (backBtn) backBtn.disabled = (state.path || []).length === 0;
  if (state.phase === 'done' || state.winner) { renderDone(); return; }
  renderPicker();
}

function renderPicker() {
  const path = state.path || [];
  const round = path.length;
  const parentId = round > 0 ? path[path.length - 1] : null;
  const variants = currentVariants() || [];
  const genStatus = state.gen_status || 'idle';
  const queueLen = state.queue_length || 0;
  const statusLabels = {building:'Building tree\u2026',encoding:'Encoding prompts\u2026',generating:'Generating images\u2026'};
  const isGenerating = ['building','encoding','generating'].includes(genStatus);

  if (document.getElementById('grid') && smartUpdateCards(variants)) {
    const pd = document.getElementById('pick-display');
    if (pd) {
      pd.className = 'pick-display ' + (selected ? 'has-pick' : '');
      pd.innerHTML = selected
        ? `Selected: <span class="pick-value">${selected.toUpperCase()}</span>`
        : `Click a variant \u00b7 or press ${(state.width||4)<=3?'a / b / c':'1 / 2 / 3 / 4'} \u00b7 Enter to confirm`;
    }
    const cb = document.getElementById('confirm-btn');
    if (cb) cb.className = 'confirm-btn ' + (selected ? 'ready' : '');
    const dw = document.getElementById('daemon-warn');
    if (dw) dw.style.display = (artifactType === 'image' && state.daemon_available === false) ? 'flex' : 'none';
    const gsBar = document.getElementById('gen-status-bar');
    if (gsBar) {
      gsBar.style.display = isGenerating ? 'flex' : 'none';
      const gsVal = document.getElementById('gen-status-val');
      if (gsVal) gsVal.textContent = statusLabels[genStatus] || genStatus;
    }
    return;
  }

  document.getElementById('title').innerHTML =
    round === 0 ? 'Explore <span>Round 0</span>' : `Converge <span>Round ${round}</span>`;
  document.getElementById('subtitle').textContent = round === 0
    ? 'Diverse starting points \u2014 pick the direction that resonates'
    : 'Axis exploration \u2014 each variant shifts one dimension';

  let html = `<div class="phasebar">
    <div class="phase-dot" style="background:${round>0?'var(--teal)':'var(--accent)'}"></div>
    <div class="phase ${round>0?'done':'active'}">Explore</div>
    <div class="phase-sep"></div>
    <div class="phase-dot" style="background:${round>=1?'var(--accent)':'var(--text-xdim)'}"></div>
    <div class="phase ${round>=1?'active':''}">Converge</div>
    <div class="phase-sep"></div>
    <div class="phase-dot"></div>
    <div class="phase">Finalize</div>
    <div class="round-badge">Round ${round}</div>
  </div>`;

  if (path.length > 0) {
    html += '<div class="breadcrumb"><span class="crumb">Root</span>';
    path.forEach((nid, i) => {
      const node = treeNodes[nid] || {};
      html += `<span class="crumb-sep">\u203a</span>
        <span class="crumb ${i===path.length-1?'active':''}">${node.label||nid}</span>`;
    });
    html += '</div>';
  }

  if (artifactType === 'image' && state.daemon_available === false) {
    html += `<div class="daemon-warn" id="daemon-warn"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="8"/><line x1="8" y1="11" x2="8.01" y2="11"/></svg> imageCLI daemon offline &mdash; run <code style="font-family:var(--mono);background:rgba(0,0,0,.3);padding:1px 5px;border-radius:3px">make gen start</code> to generate images</div>`;
  }

  html += `<div class="gen-status-bar" id="gen-status-bar" style="${isGenerating?'':'display:none'}">
    <div class="spinner"></div>
    <span class="gen-status-label">gen_status</span>
    <span class="gen-status-val" id="gen-status-val">${statusLabels[genStatus]||genStatus}</span>
    ${queueLen>0?`<span class="queue-count">${queueLen} in queue</span>`:''}
  </div>`;

  const infoByType = {
    image: `<div class="info-item"><span class="label">engine</span><span class="val">flux2-klein \u00b7 fp8</span></div>
    <div class="info-item"><span class="label">steps</span><span class="val">15</span></div>`,
    html: `<div class="info-item"><span class="label">type</span><span class="val">inline HTML</span></div>`,
    audio: `<div class="info-item"><span class="label">type</span><span class="val">voiceCLI audio</span></div>`,
    text: `<div class="info-item"><span class="label">type</span><span class="val">text</span></div>`,
  };
  html += `<div class="info-strip">
    ${infoByType[artifactType]||''}
    <div class="info-item"><span class="label">gen</span><span class="val">${genStatus}</span></div>
  </div>`;

  const childCount = parentId ? variants.length - 1 : variants.length;
  html += `<div class="${childCount <= 3 ? 'grid-3' : 'grid-4'}" id="grid">`;
  variants.forEach((node, i) => {
    const isParent = node.id === parentId;
    const isReady = node.status === 'ready';
    const childIndex = isParent ? -1 : (parentId ? i - 1 : i);
    const keyHint = childCount <= 3
      ? String.fromCharCode(97 + (isParent ? childCount : childIndex))
      : String(isParent ? childCount + 1 : childIndex + 1);
    const params = node.params || {};
    const variedAxis = params.varied_axis;
    const axisEntries = Object.entries(params).filter(([k]) =>
      !k.startsWith('_') && k !== 'pole_name' && k !== 'varied_axis'
    );
    let paramRows = '';
    if (variedAxis && variedAxis in params) {
      const v = params[variedAxis];
      const bar = `<span style="display:inline-block;width:${Math.round(Number(v)*36)}px;height:3px;background:var(--teal);border-radius:2px;vertical-align:middle;margin-left:4px;opacity:.8"></span>`;
      paramRows += `<div class="param-row" style="color:var(--teal)"><span class="param-key">${variedAxis}</span>${Number(v).toFixed(2)}${bar}</div>`;
    }
    paramRows += axisEntries.slice(0, 5).map(([k, val]) => {
      const isNum = typeof val === 'number';
      const bar = isNum ? `<span style="display:inline-block;width:${Math.round(val*36)}px;height:3px;background:var(--border2);border-radius:2px;vertical-align:middle;margin-left:4px"></span>` : '';
      return `<div class="param-row"><span class="param-key">${k}</span>${isNum ? val.toFixed(2) : val}${bar}</div>`;
    }).join('');
    const artifact = node.artifact || node.image || '';
    let cardContent = '';
    if (artifactType === 'html') {
      cardContent = `<div class="card-embed-wrap">
        ${isReady ? `<iframe src="${artifact}" sandbox="allow-scripts" loading="lazy" title="${node.label}"></iframe>` :
          `<div class="card-placeholder"><div class="mini-spinner"></div><div class="placeholder-label">${node.status||'pending'}</div></div>`}
      </div>`;
    } else if (artifactType === 'audio') {
      cardContent = `<div class="card-audio-wrap">
        <div class="audio-icon">\u266a</div>
        ${isReady ? `<audio controls src="${artifact}"></audio>` :
          `<div class="card-placeholder"><div class="mini-spinner"></div><div class="placeholder-label">${node.status||'pending'}</div></div>`}
      </div>`;
    } else {
      cardContent = `<div class="card-img-wrap">
        ${isReady ? `<img src="${artifact}" alt="${node.label}" loading="eager">` :
          `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">`}
        ${!isReady ? `<div class="card-placeholder"><div class="mini-spinner"></div><div class="placeholder-label">${node.status||'pending'}</div></div>` : ''}
      </div>`;
    }
    html += `<div class="card ${node.status||'pending'}${isParent?' card-parent':''}" id="card-${node.id}" onclick="pick('${node.id}')">
      ${isParent?'<div class="card-keep-badge">\u2190 Keep</div>':''}
      ${cardContent}
      <div class="card-label">${node.label} <span style="opacity:.5;font-size:.65rem">${isReady?'':'\u2026'}</span></div>
      ${!isParent&&node.mutation?`<div class="card-mutation ${mutClass(node.mutation)}">${mutLabel(node.mutation)}</div>`:''}
      <div class="card-check"><svg viewBox="0 0 16 16"><polyline points="3,8 6.5,11.5 13,5"/></svg></div>
      ${paramRows&&isReady?`<div class="card-params">${paramRows}</div>`:''}
    </div>`;
  });
  html += '</div>';

  html += `<div class="nudge-bar" id="nudge-bar">
    <input id="nudge-input" placeholder="Optional: nudge direction \u2014 'more dramatic', 'warmer colors'\u2026" autocomplete="off" onkeydown="if(event.key==='Enter')sendNudge()">
    <button class="nudge-btn" onclick="sendNudge()">Nudge \u2192</button>
  </div>`;

  html += `<div class="footer">
    <div class="pick-display ${selected?'has-pick':''}" id="pick-display">
      ${selected
        ? `Selected: <span class="pick-value">${selected.toUpperCase()}</span>`
        : `Click a variant \u00b7 or press ${childCount<=3?'a / b / c':'1 / 2 / 3 / 4'} \u00b7 Enter to confirm`}
    </div>
    ${round>0?`<button class="finalize-btn" onclick="finalize()">Finalize \u2713</button>`:''}
    <button class="confirm-btn ${selected?'ready':''}" id="confirm-btn" onclick="confirmPick()">Confirm \u2192</button>
  </div>`;

  document.getElementById('main-content').innerHTML = html;
  if (selected) document.getElementById('card-'+selected)?.classList.add('selected');
}

function renderDone() {
  const winnerId = state.winner;
  const w = (treeNodes && winnerId) ? treeNodes[winnerId] : null;
  document.getElementById('title').innerHTML = 'Selection <span>Locked</span>';
  document.getElementById('subtitle').textContent = 'Idea locked in.';
  const artifact = w ? (w.artifact || w.image || '') : '';
  let winnerMedia = '';
  if (w && artifact) {
    if (artifactType === 'html') {
      winnerMedia = `<iframe src="${artifact}" sandbox="allow-scripts" style="width:100%;max-width:480px;height:360px;border:2px solid var(--teal);border-radius:var(--radius)"></iframe>`;
    } else if (artifactType === 'audio') {
      winnerMedia = `<audio controls src="${artifact}" style="width:100%;max-width:320px"></audio>`;
    } else if (artifact) {
      winnerMedia = `<img src="${artifact}" alt="winner">`;
    }
  }
  document.getElementById('main-content').innerHTML = `<div class="done-panel visible">
    ${winnerMedia}
    <div class="done-title">${w?w.label:'Winner'} \u2014 Round ${w?w.round:0}</div>
    <div class="done-sub">${w&&w.params?Object.values(w.params).join(' \u00b7 '):''}</div>
  </div>`;
}
"""
