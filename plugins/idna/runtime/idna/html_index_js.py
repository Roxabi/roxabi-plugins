"""JavaScript for the IDNA index page (new session modal + SSE)."""

INDEX_JS = r"""
let _mode = 'random';

function setMode(m) {
  _mode = m;
  document.getElementById('mode-prompt').classList.toggle('active', m === 'prompt');
  document.getElementById('mode-random').classList.toggle('active', m === 'random');
  document.getElementById('field-intent').style.display  = m === 'prompt' ? '' : 'none';
  document.getElementById('field-anchor').style.display  = m === 'random' ? '' : 'none';
  document.getElementById('template-required').textContent = m === 'random' ? '(required)' : '(optional)';
  const autoOpt = document.getElementById('template-auto');
  if (autoOpt) autoOpt.disabled = m === 'random';
  if (m === 'random' && !document.getElementById('f-template').value) {
    document.getElementById('f-template').value = 'avatar';
  }
}

function openModal() {
  document.getElementById('overlay').classList.add('open');
  if (_mode === 'prompt') document.getElementById('f-intent').focus();
  else document.getElementById('f-anchor').focus();
  ['project','subject','intent','template'].forEach(k => {
    const el = document.getElementById('f-' + k);
    if (el) el.addEventListener('input', () => {
      const err = document.getElementById('err-' + k);
      if (err) err.textContent = '';
    }, {once: true});
  });
}
function closeModal() {
  if (document.getElementById('btn-create').disabled) return;
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('steps-ui').style.display = 'none';
  ['vocabulary','tree','generate','ready'].forEach(s => {
    const el = document.getElementById('step-'+s);
    el.className = 'step';
    el.querySelector('.step-icon,.step-spinner') && (el.querySelector('.step-icon,.step-spinner').outerHTML = '<span class="step-icon">&#9679;</span>');
  });
}
function maybeClose(e) {
  if (e.target === document.getElementById('overlay')) closeModal();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

const STEP_ICONS = {
  done: '<svg class="step-icon" viewBox="0 0 18 18" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,9 7,13 15,5"/></svg>',
  error: '<svg class="step-icon" viewBox="0 0 18 18" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="4" x2="14" y2="14"/><line x1="14" y1="4" x2="4" y2="14"/></svg>',
};

function setStep(name, status, message) {
  const el = document.getElementById('step-'+name);
  if (!el) return;
  el.className = 'step ' + (status === 'running' ? 'active' : status === 'done' ? 'done' : status === 'error' ? 'error' : '');
  const iconEl = el.querySelector('.step-icon,.step-spinner');
  if (iconEl) iconEl.outerHTML = status === 'running'
    ? '<span class="step-spinner"></span>'
    : status === 'done' ? STEP_ICONS.done
    : status === 'error' ? STEP_ICONS.error
    : '<span class="step-icon">&#9679;</span>';
  const detail = document.getElementById('detail-'+name);
  if (detail && message) detail.textContent = message;
}

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

async function createSession() {
  const project  = document.getElementById('f-project').value.trim();
  const subject  = document.getElementById('f-subject').value.trim();
  const template = document.getElementById('f-template').value;
  const depth    = 3;
  const width    = parseInt(document.getElementById('f-width').value);
  const ratio    = document.getElementById('f-ratio').value;
  const isRandom = _mode === 'random';
  const intent   = isRandom
    ? (document.getElementById('f-anchor').value.trim())
    : document.getElementById('f-intent').value.trim();

  document.getElementById('err-project').textContent  = '';
  document.getElementById('err-subject').textContent  = '';
  document.getElementById('err-intent').textContent   = '';
  document.getElementById('err-template').textContent = '';
  let hasErr = false;
  if (!project) { document.getElementById('err-project').textContent = 'Required'; hasErr = true; }
  if (!subject) { document.getElementById('err-subject').textContent = 'Required'; hasErr = true; }
  if (!isRandom && !intent) { document.getElementById('err-intent').textContent = 'Required'; hasErr = true; }
  if (isRandom && !template) { document.getElementById('err-template').textContent = 'Required for random mode'; hasErr = true; }
  if (hasErr) return;

  const btn = document.getElementById('btn-create');
  btn.disabled = true;
  document.getElementById('steps-ui').style.display = 'flex';

  try {
    const body = isRandom
      ? { project, subject, intent, template, depth, width, ratio, random: true }
      : { project, subject, intent, template, depth, width, ratio };
    const response = await fetch('/api/new', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(part.slice(6));
          if (ev.step === 'ready') {
            setStep('ready', 'done', ev.message);
            setTimeout(() => window.location.href = ev.url, 600);
          } else if (ev.status === 'error') {
            if (ev.step) setStep(ev.step, 'error', ev.message);
            btn.disabled = false;
          } else {
            setStep(ev.step, ev.status, ev.message);
          }
        } catch(e) {}
      }
    }
  } catch(e) {
    setStep('vocabulary', 'error', 'Network error: ' + e.message);
    btn.disabled = false;
  }
}
"""
