/* ============================================================
   ui.js — shared UI utilities for the Test Portal
   ============================================================
   Loaded by admin.html, home.html and quiz-engine.html so the
   toast, confirm dialog and HTML-escaping behave identically
   everywhere. Styles for the toast/confirm live in styles.css.
   ============================================================ */

// HTML-escape a value for safe interpolation. Exposed under the three
// names the pages historically used, so existing call sites keep working.
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
window.pEsc = esc;
window.escapeHtml = esc;

// Transient bottom-right toast. type: undefined | 'success' | 'error'.
function toast(message, type){
  let wrap = document.getElementById('toastWrap');
  if (!wrap){ wrap = document.createElement('div'); wrap.id = 'toastWrap'; wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = message;
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .2s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 220); },
    type === 'error' ? 4500 : 2800);
}

// Styled confirm. Returns a Promise<boolean>.
// opts: { title, message, confirmText, danger }
function confirmDialog(opts){
  opts = opts || {};
  return new Promise(resolve => {
    const ov = document.createElement('div'); ov.className = 'confirm-overlay';
    const box = document.createElement('div'); box.className = 'confirm-box';
    const ttl = document.createElement('div'); ttl.className = 'confirm-title'; ttl.textContent = opts.title || 'Are you sure?';
    const msg = document.createElement('div'); msg.className = 'confirm-msg'; msg.textContent = opts.message || '';
    const acts = document.createElement('div'); acts.className = 'confirm-actions';
    const cancel = document.createElement('button'); cancel.className = 'cbtn cancel'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.className = 'cbtn ok' + (opts.danger ? ' danger' : ''); ok.textContent = opts.confirmText || 'Confirm';
    acts.appendChild(cancel); acts.appendChild(ok);
    box.appendChild(ttl); box.appendChild(msg); box.appendChild(acts); ov.appendChild(box); document.body.appendChild(ov);
    function done(v){ ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
    function onKey(e){ if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); }
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    ov.addEventListener('click', e => { if (e.target === ov) done(false); });
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}

/* ============================================================
   Sheet — turn an existing inline editor card into a centered
   popup. openSheet(el) moves the element into a shared backdrop
   overlay and shows it; closeSheet() hides it again. The element
   keeps its id + event handlers (DOM moves preserve listeners),
   so existing editor code keeps working unchanged.
   Styles: .sheet-overlay in styles.css.
   ============================================================ */
function _sheetOverlay(){
  let ov = document.getElementById('sheetOverlay');
  if (!ov){
    ov = document.createElement('div');
    ov.id = 'sheetOverlay'; ov.className = 'sheet-overlay hidden';
    ov.addEventListener('mousedown', e => { if (e.target === ov) closeSheet(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.classList.contains('hidden')) closeSheet(); });
    document.body.appendChild(ov);
  }
  return ov;
}
function openSheet(el){
  if (typeof el === 'string') el = document.getElementById(el);
  if (!el) return;
  const ov = _sheetOverlay();
  if (el.parentNode !== ov) ov.appendChild(el);   // portal it in (once)
  ov._current = el;
  el.classList.remove('hidden');
  ov.classList.remove('hidden');
  document.documentElement.style.overflow = 'hidden';   // freeze background scroll
  const f = el.querySelector('input:not([type=file]):not([type=hidden]),select,textarea');
  if (f) setTimeout(() => { try { f.focus(); } catch (_) {} }, 30);
}
function closeSheet(el){
  const ov = document.getElementById('sheetOverlay');
  if (!ov) return;
  el = (typeof el === 'string' ? document.getElementById(el) : el) || ov._current;
  if (el) el.classList.add('hidden');
  ov._current = null;
  ov.classList.add('hidden');
  document.documentElement.style.overflow = '';
}
