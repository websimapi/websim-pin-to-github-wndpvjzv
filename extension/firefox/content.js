(() => {
  const api = globalThis.browser || globalThis.chrome;
  let lastPin = 0;
  function projectIdFromUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/\/(?:c|p)\/([a-zA-Z0-9_-]+)/);
      if (match) return match[1];
      const host = url.hostname.match(/^([a-zA-Z0-9_-]+)\.c\.websim\.com$/);
      return host ? host[1] : null;
    } catch { return null; }
  }
  function contextFor(element) {
    const card = element.closest('[data-project-id], article, li, [class*="project"], [class*="card"]');
    const link = card?.querySelector('a[href*="/c/"], a[href*="/p/"]') || element.closest('a');
    const frame = document.querySelector('iframe[src*=".c.websim.com"]');
    const href = link?.href || frame?.src || location.href;
    const title = card?.querySelector('h1,h2,h3,[aria-label="Project title"]') || document.querySelector('[aria-label="Project title"],h1');
    return { projectId: element.closest('[data-project-id]')?.dataset.projectId || card?.dataset?.projectId || projectIdFromUrl(href) || projectIdFromUrl(location.href), url: href, title: title?.textContent?.trim() || document.title, detectedAt: Date.now() };
  }
  function debug(event, detail = {}) { api.runtime.sendMessage({ type:'DEBUG_EVENT', event, detail }).catch(() => {}); }
  function interactiveTarget(event) { const path=event.composedPath?.() || []; return path.find((node) => node?.matches?.('button,a,[role="button"],[data-project-id]')) || path.find((node) => node?.getAttribute && /\b(pin|pinned|bookmark|collection)\b/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`)) || event.target.closest?.('button,a,[role="button"],[data-project-id]'); }
  function targetSummary(element) { return { tag:element?.tagName || null, id:element?.id || null, className:String(element?.className || '').slice(0,180), ariaLabel:element?.getAttribute?.('aria-label') || null, title:element?.getAttribute?.('title') || null, text:element?.textContent?.replace(/\s+/g,' ').trim().slice(0,180) || null, href:element?.href ? String(element.href).split(/[?#]/)[0] : null, dataAttributes:element?.dataset ? Object.fromEntries(Object.entries(element.dataset).slice(0,12)) : {} }; }
  function looksLikePin(element) {
    const text = [element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.textContent, element.className, ...Object.values(element.dataset || {})].filter(Boolean).join(' ').trim();
    return text.length <= 240 && /\b(pin|pinned|bookmark|save\s+(?:to|this|project|version|collection)|collection)\b/i.test(text);
  }
  function showToast(message, kind = 'info') {
    document.querySelector('#pin-to-github-toast')?.remove();
    const toast = document.createElement('div'); toast.id = 'pin-to-github-toast';
    if (kind === 'loading') {
      const spinner = document.createElement('span'); spinner.className = 'pin-to-github-spinner';
      const label = document.createElement('span'); label.textContent = message; toast.append(spinner, label);
      Object.assign(spinner.style, { width:'14px', height:'14px', flex:'0 0 14px', borderRadius:'50%', border:'2px solid rgba(217,238,101,.3)', borderTopColor:'#d9ee65', animation:'pin-to-github-spin .75s linear infinite' });
      if (!document.querySelector('#pin-to-github-spinner-style')) { const style=document.createElement('style'); style.id='pin-to-github-spinner-style'; style.textContent='@keyframes pin-to-github-spin { to { transform: rotate(360deg); } }'; document.head.appendChild(style); }
    } else toast.textContent = message;
    Object.assign(toast.style, { position:'fixed', zIndex:'2147483647', right:'18px', bottom:'18px', maxWidth:'min(360px,calc(100vw - 36px))', padding:'12px 15px', borderRadius:'9px', background:kind === 'error' ? '#3a1d24' : '#17221d', color:'#f4f1e8', border:`1px solid ${kind === 'error' ? '#d76b72' : '#b9df61'}`, font:'500 13px/1.35 system-ui,sans-serif', boxShadow:'0 12px 30px rgba(0,0,0,.25)', display:'flex', alignItems:'center', gap:'9px' });
    document.documentElement.appendChild(toast);
    if (kind !== 'loading') window.setTimeout(() => toast.remove(), 6000);
  }
  document.addEventListener('click', (event) => {
    const target = interactiveTarget(event); if (!target) return;
    const pinLike=looksLikePin(target); debug('content.click.inspect', { ...targetSummary(target), pinLike, page:location.href.split(/[?#]/)[0] });
    if (!pinLike) return;
    if (Date.now() - lastPin < 1200) { debug('content.pin.ignored', { reason:'debounced', sincePreviousMs:Date.now() - lastPin, ...targetSummary(target) }); return; }
    lastPin = Date.now(); const payload=contextFor(target); debug('content.pin.detected', payload); showToast('Syncing revision to GitHub…', 'loading');
    api.runtime.sendMessage({ type:'PIN_DETECTED', payload }).then((result) => debug('content.pin.message.response', { ok:Boolean(result?.ok), message:result?.message || null })).catch((error) => { debug('content.pin.message.error', { message:error.message }); showToast('Pin to GitHub: extension background unavailable', 'error'); });
  }, true);
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SYNC_STARTED') showToast('Syncing revision to GitHub…', 'loading');
    if (message?.type === 'SYNC_RESULT') { debug('content.sync.result', { ok:Boolean(message.ok), message:message.message || null }); showToast(message.ok ? `✓ ${message.message}` : `Pin to GitHub: ${message.message}`, message.ok ? 'success' : 'error'); }
  });
  debug('content.ready', { page:location.href.split(/[?#]/)[0], isFrame:window.top !== window.self, pinCandidates:[...document.querySelectorAll('button,a,[role="button"]')].filter(looksLikePin).slice(0,12).map(targetSummary) });
})();
