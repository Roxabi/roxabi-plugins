"""JavaScript action/state functions for the IDNA picker page (API calls, polling)."""

PICKER_JS_ACTIONS = r"""
function pick(id) {
  const node = treeNodes && treeNodes[id];
  if (!node || node.status !== 'ready') return;
  if (selected && selected !== id) document.getElementById('card-'+selected)?.classList.remove('selected');
  selected = id;
  document.getElementById('card-'+id)?.classList.add('selected');
  const d = document.getElementById('pick-display');
  if (d) { d.innerHTML = `Selected: <span class="pick-value">${id.toUpperCase()}</span>`; d.classList.add('has-pick'); }
  document.getElementById('confirm-btn')?.classList.add('ready');
}

async function goBack() {
  if (!state || (state.path||[]).length === 0) return;
  try {
    const r = await fetch('api/back', {method:'POST'});
    if (!r.ok) { showError('Back failed'); return; }
    selected = null;
    await loadStatus();
  } catch(e) { showError('Server error: '+e.message); }
}

async function confirmPick() {
  if (!selected || confirming) return;
  confirming = true;
  try {
    const path = state.path || [];
    const isRerollParent = path.length > 0 && selected === path[path.length - 1];
    if (isRerollParent) {
      const r = await fetch('api/reroll', {method:'POST'});
      if (!r.ok) { showError('Reroll failed: '+((await r.json()).error||r.status)); return; }
      selected = null;
      await loadStatus();
      startPolling();
      return;
    }
    const r = await fetch('api/pick', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({node_id: selected}),
    });
    if (!r.ok) { showError('Pick failed: '+((await r.json()).error||r.status)); return; }
    selected = null;
    await loadStatus();
    startPolling();
    const nb = document.getElementById('nudge-bar');
    if (nb) { nb.style.display = 'flex'; document.getElementById('nudge-input')?.focus(); }
  } catch(e) { showError('Server error: '+e.message); }
  finally { confirming = false; }
}

async function sendNudge() {
  const input = document.getElementById('nudge-input');
  const text = input?.value?.trim();
  if (!text) return;
  try {
    const r = await fetch('api/nudge', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({text}),
    });
    const data = await r.json();
    if (!data.ok) { showError('Nudge failed: ' + (data.error || r.status)); return; }
    const nb = document.getElementById('nudge-bar');
    if (nb) { nb.style.display = 'none'; if (input) input.value = ''; }
    startPolling();
  } catch(e) { showError('Nudge error: ' + e.message); }
}

async function finalize() {
  try {
    await fetch('api/finalize', {method:'POST'});
    await loadStatus();
  } catch(e) { showError('Server error: '+e.message); }
}

async function loadStatus() {
  try {
    const [statusRes, treeRes] = await Promise.all([
      fetch('api/status'),
      treeNodes ? Promise.resolve(null) : fetch('api/tree'),
    ]);
    if (!statusRes.ok) throw new Error('HTTP '+statusRes.status);
    const data = await statusRes.json();
    state = data;
    if (treeRes) {
      if (!treeRes.ok) throw new Error('tree HTTP '+treeRes.status);
      treeNodes = await treeRes.json();
    } else {
      if (data.nodes) treeNodes = data.nodes;
    }
    if (data.artifact_type) artifactType = data.artifact_type;
    if (data.ratio) document.documentElement.style.setProperty('--card-ratio', data.ratio.replace(':', '/'));
    _failCount = 0;
    hideError();
    render();
    const variants = currentVariants() || [];
    const allReady = variants.length > 0 && variants.every(n => n.status === 'ready');
    if (data.gen_status === 'idle' && allReady) stopPolling();
  } catch(e) {
    if (++_failCount >= 3) showError('IDNA server offline \u2014 run: make idna start');
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(loadStatus, 2000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function showError(msg) {
  const e = document.getElementById('error-bar');
  e.textContent = msg; e.classList.add('visible');
}
function hideError() {
  document.getElementById('error-bar').classList.remove('visible');
}

function toggleMenu() {
  const w = document.getElementById('menu-wrap');
  if (w.classList.toggle('open')) {
    document.getElementById('menu-confirm').classList.remove('visible');
    setTimeout(() => document.addEventListener('click', _menuOutside, {once:true}), 0);
  }
}
function closeMenu() {
  document.getElementById('menu-wrap').classList.remove('open');
}
function _menuOutside(e) {
  if (!document.getElementById('menu-wrap')?.contains(e.target)) closeMenu();
}
function menuAction(action) {
  const confirm = document.getElementById('menu-confirm');
  const msg = document.getElementById('menu-confirm-msg');
  const ok = document.getElementById('menu-confirm-ok');
  const labels = {
    reset: {msg: 'Reset to round 0?', ok: 'Reset'},
    delete: {msg: 'Delete this session?', ok: 'Delete'},
  };
  msg.textContent = labels[action].msg;
  ok.textContent = labels[action].ok;
  ok.onclick = action === 'reset' ? resetSession : deleteSession;
  confirm.classList.add('visible');
}
async function resetSession() {
  closeMenu();
  try {
    const r = await fetch('api/reset', {method:'POST'});
    if (!r.ok) { showError('Reset failed: '+((await r.json()).error||r.status)); return; }
    selected = null; treeNodes = null;
    await loadStatus();
    startPolling();
  } catch(e) { showError('Server error: '+e.message); }
}
async function deleteSession() {
  closeMenu();
  try {
    const r = await fetch('api/delete', {method:'POST'});
    if (!r.ok) { showError('Delete failed: '+((await r.json()).error||r.status)); return; }
    location.href = '/';
  } catch(e) { showError('Server error: '+e.message); }
}

loadStatus();
startPolling();
"""
