const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
let currentState = null;

function send(message) {
  return new Promise((resolve) => api.runtime.sendMessage(message, resolve));
}

function render(state) {
  currentState = state;
  $('enabled').checked = state.enabled !== false;
  $('visibility').value = state.visibility || 'private';
  $('branchMode').value = state.branchMode || 'main';
  $('customBranch').value = state.customBranch || '';
  $('advanced-logs').checked = state.advancedLogs === true;
  $('custom-branch-wrap').classList.toggle('hidden', state.branchMode !== 'custom');
  $('github-account').textContent = state.owner ? `@${state.owner}` : 'Not connected yet';
  $('state-pill').textContent = state.enabled !== false && state.hasToken ? 'READY' : 'SETUP';
  $('state-pill').className = `state-pill ${state.enabled === false ? 'paused' : 'ready'}`;
  const events = state.lastEvents || [];
  $('recent-count').textContent = events.length;
  $('recent-list').innerHTML = events.length ? events.map((item) => `
    <div class="recent-item">
      <b>${escapeHtml(item.title || 'Websim project')} · v${escapeHtml(item.version)}</b>
      <small class="sha">${escapeHtml(item.sha?.slice(0, 7) || '')}</small>
      <a href="${escapeAttr(item.url || '#')}" target="_blank" rel="noreferrer">↗</a>
      <small>${escapeHtml(new Date(item.at || Date.now()).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }))}</small>
    </div>`).join('') : '<p class="empty">No commits yet. Pin a project to begin.</p>';
  $('logs-output').textContent = formatLogs(state.debugLogs || []);
}

async function refreshProjectLink() {
  const repoNode = $('linked-repo');
  const metaNode = $('linked-repo-meta');
  const linkNode = $('linked-repo-url');
  repoNode.textContent = 'Detecting Websim project…';
  metaNode.textContent = 'Checking the active tab';
  linkNode.hidden = true;
  try {
    const tabs = await new Promise((resolve) => api.tabs.query({ active: true, currentWindow: true }, resolve));
    const tab = tabs?.[0];
    const result = await send({ type: 'GET_PROJECT_LINK', url: tab?.url, title: tab?.title });
    if (result?.status === 'not-configured') {
      repoNode.textContent = 'Connect GitHub first';
      metaNode.textContent = 'The linked repository appears after setup';
      return;
    }
    if (result?.status === 'not-websim') {
      repoNode.textContent = 'No Websim project detected';
      metaNode.textContent = 'Open a Websim project in the active tab';
      return;
    }
    if (!result?.ok) throw new Error(result?.message || 'Could not inspect the project link');
    repoNode.textContent = `${result.owner}/${result.repo}`;
    metaNode.textContent = `${result.status === 'linked' ? 'Linked repository' : 'Planned repository'} · ${result.branch} branch`;
    linkNode.href = result.url;
    linkNode.hidden = false;
  } catch (error) {
    repoNode.textContent = 'Repository unavailable';
    metaNode.textContent = error.message || 'Could not check GitHub';
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function escapeAttr(value) { return escapeHtml(value).replace(/javascript:/gi, ''); }
function showMessage(text, error = false) { $('message').textContent = text || ''; $('message').className = `message${error ? ' error' : ''}`; }
function formatLogs(logs) {
  if (!logs.length) return 'No logs yet.';
  return logs.map((entry) => {
    const { at, event, ...detail } = entry;
    const suffix = Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
    return `[${at}] ${event}${suffix}`;
  }).join('\n');
}
async function copyLogs() {
  const text = $('logs-output').textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text; document.body.appendChild(area); area.select();
    document.execCommand('copy'); area.remove();
  }
  showMessage('Diagnostic logs copied to clipboard.');
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const existing = currentState || {};
  const tokenInput = $('token').value.trim();
  const result = await send({ type: 'SAVE_SETTINGS', settings: {
    ...existing,
    token: tokenInput || existing.token || '',
    visibility: $('visibility').value,
    branchMode: $('branchMode').value,
    customBranch: $('customBranch').value.trim(),
    enabled: $('enabled').checked
  }});
  if (result?.ok) { $('token').value = ''; showMessage('Saved locally. Pin a Websim project to sync.'); render(await send({ type: 'GET_STATE' })); refreshProjectLink(); }
  else showMessage(result?.message || 'Could not validate this token.', true);
});

$('branchMode').addEventListener('change', () => $('custom-branch-wrap').classList.toggle('hidden', $('branchMode').value !== 'custom'));
$('advanced-logs').addEventListener('change', async () => {
  const result = await send({ type: 'SET_DEBUG_MODE', enabled: $('advanced-logs').checked });
  if (result?.ok) showMessage(result.advancedLogs ? 'Advanced logs enabled. Clear logs, then pin a project.' : 'Advanced logs disabled.');
  else showMessage('Could not update advanced logging.', true);
});
$('copy-logs').addEventListener('click', copyLogs);
$('clear-logs').addEventListener('click', async () => {
  await send({ type: 'CLEAR_LOGS' });
  render(await send({ type: 'GET_STATE' }));
  showMessage('Diagnostic logs cleared.');
});

$('sync-current').addEventListener('click', async () => {
  showMessage('Reading the current Websim project…');
  const tabs = await new Promise((resolve) => api.tabs.query({ active: true, currentWindow: true }, resolve));
  const tab = tabs?.[0];
  const result = await send({ type: 'SYNC_CURRENT', tabId: tab?.id, url: tab?.url, title: tab?.title });
  showMessage(result?.message || 'Done.', !result?.ok);
  render(await send({ type: 'GET_STATE' }));
  refreshProjectLink();
});

send({ type: 'GET_STATE' }).then((state) => { render(state); refreshProjectLink(); });
