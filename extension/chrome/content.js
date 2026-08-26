(() => {
  const api = globalThis.browser || globalThis.chrome;
  let lastPin = 0;

  function projectIdFromUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      const routeMatch = url.pathname.match(/\/(?:c|p)\/([a-zA-Z0-9_-]+)/);
      if (routeMatch) return routeMatch[1];
      const hostMatch = url.hostname.match(/^([a-zA-Z0-9_-]+)\.c\.websim\.com$/);
      return hostMatch ? hostMatch[1] : null;
    } catch {
      return null;
    }
  }

  function contextFor(element) {
    const card = element.closest('[data-project-id], article, li, [class*="project"], [class*="card"]');
    const link = card?.querySelector('a[href*="/c/"], a[href*="/p/"]') || element.closest('a');
    const frame = document.querySelector('iframe[src*=".c.websim.com"]');
    const href = link?.href || frame?.src || location.href;
    const projectId = element.closest('[data-project-id]')?.dataset.projectId ||
      card?.dataset?.projectId || projectIdFromUrl(href) || projectIdFromUrl(location.href);
    const titleNode = card?.querySelector('h1, h2, h3, [aria-label="Project title"]') ||
      document.querySelector('[aria-label="Project title"], h1');
    return {
      projectId: projectId || null,
      url: href,
      title: titleNode?.textContent?.trim() || document.title.replace(/\s*[|·—-]\s*Websim.*$/i, '').trim(),
      detectedAt: Date.now()
    };
  }

  function looksLikePin(element) {
    const text = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.textContent
    ].filter(Boolean).join(' ').trim();
    if (!text || text.length > 90) return false;
    return /\b(pin|pinned|bookmark|save to collection)\b/i.test(text);
  }

  function showToast(message, kind = 'info') {
    document.querySelector('#pin-to-github-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'pin-to-github-toast';
    toast.textContent = message;
    toast.dataset.kind = kind;
    Object.assign(toast.style, {
      position: 'fixed', zIndex: '2147483647', right: '18px', bottom: '18px',
      maxWidth: 'min(360px, calc(100vw - 36px))', padding: '12px 15px',
      borderRadius: '9px', background: kind === 'error' ? '#3a1d24' : '#17221d',
      color: '#f4f1e8', border: `1px solid ${kind === 'error' ? '#d76b72' : '#b9df61'}`,
      font: '500 13px/1.35 system-ui, sans-serif', boxShadow: '0 12px 30px rgba(0,0,0,.25)'
    });
    document.documentElement.appendChild(toast);
    window.setTimeout(() => toast.remove(), 6000);
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest?.('button, a, [role="button"], [data-project-id]');
    if (!target || !looksLikePin(target) || Date.now() - lastPin < 1200) return;
    lastPin = Date.now();
    const payload = contextFor(target);
    api.runtime.sendMessage({ type: 'PIN_DETECTED', payload }).catch(() => {});
  }, true);

  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SYNC_RESULT') {
      showToast(message.ok ? `✓ ${message.message}` : `Pin to GitHub: ${message.message}`, message.ok ? 'success' : 'error');
    }
  });
})();
