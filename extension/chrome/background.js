(() => {
  const api = globalThis.browser || globalThis.chrome;
  const GH_API = 'https://api.github.com';
  const WS_API = 'https://websim.com/api/v1';
  const defaults = {
    enabled: true, token: '', owner: '', branchMode: 'main', customBranch: '',
    visibility: 'private', lastEvents: [], syncedVersions: {}, projectMap: {}, debugLogs: [],
    advancedLogs: true, advancedLogsConfigured: false
  };

  const storageGet = (keys) => new Promise((resolve) => api.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => api.storage.local.set(value, resolve));
  let logQueue = Promise.resolve();
  const trackedWebsimRequests = new Map();
  const syncInFlight = new Set();
  const activeSyncs = new Set();
  const projectLogScopes = new Map();
  const repoLogScopes = new Map();
  const automaticSyncChecks = new Set();
  const readinessRetryTimers = new Map();
  const readinessRetryDelays = [1000, 2000, 4000, 8000, 15000, 30000, 60000];

  function normalizedTabId(tabId) {
    return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
  }

  function syncKey(projectId, tabId) {
    const scope = normalizedTabId(tabId);
    return `${scope === null ? 'background' : `tab:${scope}`}:${projectId}`;
  }

  function activeSyncForTab(tabId) {
    const scope = normalizedTabId(tabId);
    const prefix = `${scope === null ? 'background' : `tab:${scope}`}:`;
    return [...activeSyncs].some((key) => key.startsWith(prefix));
  }

  function requestKey(details) {
    return `${normalizedTabId(details.tabId) ?? 'background'}:${details.requestId}`;
  }

  function rememberProjectLogScope(projectId, tabId) {
    if (projectId) projectLogScopes.set(String(projectId), normalizedTabId(tabId));
  }

  function rememberRepoLogScope(owner, repo, projectId, tabId) {
    if (owner && repo && projectId) repoLogScopes.set(`${owner}/${repo}`.toLowerCase(), { projectId: String(projectId), tabId: normalizedTabId(tabId) });
  }

  function scopedLogDetail(detail = {}) {
    let projectId = detail.projectId || null;
    let tabId = normalizedTabId(detail.tabId);
    const path = String(detail.path || detail.url || detail.page || detail.senderUrl || '');
    const projectMatch = path.match(/\/projects\/([^/?]+)/i);
    if (!projectId && projectMatch) projectId = decodeURIComponent(projectMatch[1]);
    const repoMatch = path.match(/\/repos\/([^/]+)\/([^/?]+)/i);
    const repoKey = repoMatch ? `${decodeURIComponent(repoMatch[1])}/${decodeURIComponent(repoMatch[2])}`.toLowerCase() :
      detail.owner && detail.repo ? `${detail.owner}/${detail.repo}`.toLowerCase() : null;
    const repoScope = repoKey ? repoLogScopes.get(repoKey) : null;
    if (!projectId && repoScope) projectId = repoScope.projectId;
    if (projectId && tabId === null) tabId = projectLogScopes.get(String(projectId)) ?? repoScope?.tabId ?? null;
    return {
      ...detail,
      ...(projectId ? { projectId: String(projectId) } : {}),
      ...(tabId !== null ? { tabId } : {})
    };
  }

  function debugLog(event, detail = {}) {
    const entry = { at: new Date().toISOString(), event, ...scopedLogDetail(detail) };
    logQueue = logQueue.then(async () => {
      const stored = await storageGet({ debugLogs: [] });
      await storageSet({ debugLogs: [...(stored.debugLogs || []), entry].slice(-160) });
    }).catch(() => {});
    return logQueue;
  }

  function safeDebugDetail(detail = {}) {
    return Object.fromEntries(Object.entries(detail).slice(0, 24).map(([key, value]) => {
      if (typeof value === 'string') return [key, value.replace(/([?&](?:token|access_token|authorization|code|key)=)[^&]*/gi, '$1[redacted]').slice(0, 400)];
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value];
      return [key, String(value).slice(0, 400)];
    }));
  }

  function websimNetworkUrl(value) {
    try {
      const url = new URL(value);
      if (!/(^|\.)websim\.com$/i.test(url.hostname)) return null;
      if (!/\/api\//i.test(url.pathname) && !/(pin|pinned|bookmark|collection|save)/i.test(url.pathname)) return null;
      return `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }

  function projectMutation(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/\/api\/v1\/projects\/([^/]+)$/i);
      return match ? { projectId: decodeURIComponent(match[1]) } : null;
    } catch {
      return null;
    }
  }

  function projectRead(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/\/api\/v[12]\/projects\/([^/]+)$/i);
      return match ? { projectId: decodeURIComponent(match[1]) } : null;
    } catch {
      return null;
    }
  }

  function projectRevisionRead(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/\/api\/v1\/projects\/([^/]+)\/revisions\/([^/]+)\/assets$/i);
      return match ? { projectId: decodeURIComponent(match[1]), version: decodeURIComponent(match[2]) } : null;
    } catch {
      return null;
    }
  }

  function projectActivityRead(value) {
    return projectRead(value) || projectRevisionRead(value);
  }

  function decodeRequestBytes(bytes) {
    try {
      if (!bytes) return '';
      if (Array.isArray(bytes)) return new TextDecoder().decode(new Uint8Array(bytes));
      return new TextDecoder().decode(bytes);
    } catch {
      return '';
    }
  }

  function requestFieldEntries(value, prefix = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 3) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) return [[path, `[${child.length} items]`]];
        return requestFieldEntries(child, path, depth + 1);
      }
      return [[path, child]];
    });
  }

  function requestBodySummary(body) {
    if (!body) return { kind: null, keys: [], versionFields: {} };
    let parsed = body.formData || null;
    if (!parsed && body.raw?.length) {
      for (const part of body.raw) {
        const text = decodeRequestBytes(part.bytes);
        if (!text) continue;
        try {
          parsed = JSON.parse(text);
          break;
        } catch {
          try {
            const params = new URLSearchParams(text);
            if ([...params.keys()].length) {
              parsed = Object.fromEntries(params.entries());
              break;
            }
          } catch {}
        }
      }
    }
    if (!parsed || typeof parsed !== 'object') return { kind: 'raw', keys: [], versionFields: {} };
    const entries = requestFieldEntries(parsed);
    const versionFields = Object.fromEntries(entries
      .filter(([key]) => /pin|version|revision/i.test(key))
      .slice(0, 24)
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 80) : value]));
    return {
      kind: body.formData ? 'formData' : 'json',
      keys: entries.map(([key]) => key).slice(0, 40),
      versionFields
    };
  }

  function mutationStateEntries(value, prefix = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth > 3) return [];
    return Object.entries(value).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (/pin|bookmark|version|revision/i.test(key)) return [[path, child]];
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        return mutationStateEntries(child, path, depth + 1);
      }
      return [];
    });
  }

  function projectMutationState(data) {
    const project = data?.project || data?.site || data || {};
    const revision = data?.project_revision || data?.revision ||
      project.current_revision || project.currentRevision || project.revision || {};
    const fields = Object.fromEntries(
      [...mutationStateEntries(project), ...mutationStateEntries(revision)]
        .sort(([a], [b]) => a.localeCompare(b))
    );
    return {
      version: project.current_version ?? project.currentVersion ?? revision.version ?? revision.revision_number ?? null,
      fingerprint: JSON.stringify(fields)
    };
  }

  async function readProjectMutationState(projectId) {
    try {
      return projectMutationState(await wsJson(`/projects/${encodeURIComponent(projectId)}`));
    } catch {
      return null;
    }
  }

  function knownSyncedVersion(settings, projectId) {
    const mapped = settings.projectMap?.[projectId];
    if (!mapped?.repo) return null;
    const branch = mapped.branch || branchName(settings, {});
    const versions = settings.syncedVersions || {};
    const directKey = `${settings.owner || ''}/${mapped.repo}:${projectId}:${branch}`;
    if (versions[directKey] !== undefined && versions[directKey] !== null) return versions[directKey];
    const suffix = `/${mapped.repo}:${projectId}:${branch}`;
    const matchingKey = Object.keys(versions).find((key) => key.endsWith(suffix));
    return matchingKey ? versions[matchingKey] : null;
  }

  function setSyncIndicator(active, tabId = null) {
    const action = api.action || api.browserAction;
    if (!action) return;
    const scope = normalizedTabId(tabId);
    const target = scope === null ? {} : { tabId: scope };
    Promise.resolve(action.setBadgeText?.({ ...target, text: active ? '…' : '' })).catch(() => {});
    Promise.resolve(action.setBadgeBackgroundColor?.({ ...target, color: active ? '#d9ee65' : '#11131a' })).catch(() => {});
    Promise.resolve(action.setTitle?.({ ...target, title: active ? 'Pin to GitHub · syncing…' : 'Pin to GitHub' })).catch(() => {});
  }

  async function config() {
    const stored = await storageGet(defaults);
    if (stored.advancedLogsConfigured !== true) {
      await storageSet({ advancedLogs: true, advancedLogsConfigured: true });
      return { ...defaults, ...stored, advancedLogs: true, advancedLogsConfigured: true };
    }
    return { ...defaults, ...stored };
  }

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { ...options, cache: options.cache || 'no-store', headers: {
      Accept: 'application/vnd.github+json',
      ...(options.headers || {})
    }});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.url = url;
      throw error;
    }
    return data;
  }

  async function wsJson(path) {
    await debugLog('websim.request', { method: 'GET', path });
    try {
      const response = await fetch(`${WS_API}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data?.error?.message || data?.error || `Websim request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      await debugLog('websim.response', { method: 'GET', path, status: response.status });
      return data;
    } catch (error) {
      await debugLog('websim.error', { method: 'GET', path, status: error.status || null, message: error.message });
      throw error;
    }
  }

  function unwrap(data, key) {
    if (data?.[key]?.data) return data[key].data;
    if (Array.isArray(data?.[key])) return data[key];
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  function normalizedRevision(item) {
    return item?.project_revision || item?.revision || item;
  }

  function projectIdFromWebsimUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      const route = url.pathname.match(/\/([cp])\/([a-zA-Z0-9_-]+)/);
      if (route) return route[2];
      const host = url.hostname.match(/^([a-zA-Z0-9_-]+)\.c\.websim\.com$/i);
      return host ? host[1] : null;
    } catch {
      return null;
    }
  }

  async function resolveProjectId(payload) {
    if (payload?.projectId) return payload.projectId;
    const directProjectId = projectIdFromWebsimUrl(payload?.url);
    if (directProjectId) return directProjectId;
    try {
      const route = new URL(payload?.url || '');
      const match = route.pathname.match(/^\/@([^/]+)\/([^/]+)/);
      if (!match) return null;
      const response = await wsJson(`/users/${encodeURIComponent(match[1])}/projects?first=100`);
      const projects = unwrap(response, 'projects').map((item) => item?.project || item).filter(Boolean);
      const slug = decodeURIComponent(match[2]).toLowerCase();
      const found = projects.find((project) => String(project.slug || '').toLowerCase() === slug) ||
        projects.find((project) => String(project.title || '').toLowerCase() === String(payload.title || '').toLowerCase());
      return found?.id || null;
    } catch {
      return null;
    }
  }

  function projectIdForLog(entry, projectMap = {}) {
    if (entry?.projectId) return String(entry.projectId);
    const path = String(entry?.path || entry?.url || '');
    const projectMatch = path.match(/\/projects\/([^/?]+)/i);
    if (projectMatch) return decodeURIComponent(projectMatch[1]);
    const repoMatch = path.match(/\/repos\/[^/]+\/([^/?]+)/i);
    if (!repoMatch) return null;
    const repo = decodeURIComponent(repoMatch[1]).toLowerCase();
    return Object.entries(projectMap).find(([, mapped]) => String(mapped?.repo || '').toLowerCase() === repo)?.[0] || null;
  }

  function belongsToContext(entry, projectId, tabId, projectMap) {
    if (projectIdForLog(entry, projectMap) !== String(projectId || '')) return false;
    const entryTabId = normalizedTabId(entry?.tabId);
    const activeTabId = normalizedTabId(tabId);
    // Once the popup identifies an active tab, only show entries recorded by
    // that tab. Entries without a tab scope are intentionally hidden here so
    // diagnostics from another tab cannot bleed into the current page.
    return activeTabId === null ? true : entryTabId === activeTabId;
  }

  function logsForProject(logs, projectId, tabId, projectMap) {
    if (!projectId) return [];
    return (logs || []).filter((entry) => belongsToContext(entry, projectId, tabId, projectMap));
  }

  function eventsForProject(events, projectId, tabId) {
    if (!projectId) return [];
    return (events || []).filter((entry) => belongsToContext(entry, projectId, tabId, {}));
  }

  async function stateForContext(message = {}) {
    const stored = await config();
    const projectId = await resolveProjectId(message);
    const tabId = normalizedTabId(message.tabId);
    return {
      ...stored,
      activeTabId: tabId,
      activeProjectId: projectId,
      lastEvents: eventsForProject(stored.lastEvents, projectId, tabId),
      debugLogs: logsForProject(stored.debugLogs, projectId, tabId, stored.projectMap),
      token: '',
      hasToken: Boolean(stored.token)
    };
  }

  async function clearLogsForContext(message = {}) {
    const stored = await config();
    const projectId = await resolveProjectId(message);
    if (!projectId) return;
    const tabId = normalizedTabId(message.tabId);
    await storageSet({
      debugLogs: (stored.debugLogs || []).filter((entry) => !belongsToContext(entry, projectId, tabId, stored.projectMap))
    });
  }

  function projectReadiness(data) {
    const project = data?.project || data?.site || data || {};
    const revision = data?.project_revision || data?.revision ||
      project.current_revision || project.currentRevision || project.revision || {};
    const version = project.current_version ?? project.currentVersion ?? revision.version ?? revision.revision_number ?? null;
    const hasSlug = Boolean(String(project.slug || '').trim());
    return {
      project,
      revision,
      version,
      hasSlug,
      // A revision is eligible only after Websim has assigned its canonical
      // slug. This prevents v1 drafts and slug-less v2 revisions from being
      // committed to a temporary ID/title-based repository.
      ready: hasSlug && version !== null && revision.draft !== true
    };
  }

  function readinessRetryKey(projectId, tabId) {
    return syncKey(projectId, tabId);
  }

  function cancelReadinessRetry(projectId, tabId) {
    const key = readinessRetryKey(projectId, tabId);
    const retry = readinessRetryTimers.get(key);
    if (!retry) return;
    clearTimeout(retry.timer);
    readinessRetryTimers.delete(key);
  }

  function scheduleReadinessRetry(payload, tabId) {
    const projectId = payload?.projectId;
    if (!projectId) return;
    const key = readinessRetryKey(projectId, tabId);
    const pending = readinessRetryTimers.get(key);
    if (pending?.timer) return;
    const attempt = pending?.attempt || 0;
    const delay = readinessRetryDelays[attempt];
    if (delay === undefined) {
      debugLog('sync.page-ready.retry.exhausted', {
        projectId,
        tabId: normalizedTabId(tabId),
        attempts: readinessRetryDelays.length
      });
      return;
    }
    const retry = {
      attempt: attempt + 1,
      timer: setTimeout(() => {
        readinessRetryTimers.set(key, { attempt: retry.attempt, timer: null });
        autoSyncNewProject(payload, tabId).then((result) => {
          if (!result?.skipped) notify(tabId, result);
        }).catch((error) => {
          debugLog('sync.page-ready.failed', {
            tabId: normalizedTabId(tabId),
            projectId,
            message: error.message
          });
        });
      }, delay)
    };
    readinessRetryTimers.set(key, retry);
    debugLog('sync.page-ready.retry.scheduled', {
      projectId,
      tabId: normalizedTabId(tabId),
      attempt: retry.attempt,
      delayMs: delay,
      reason: 'project-not-ready'
    });
  }

  async function autoSyncNewProject(payload, tabId) {
    const settings = await config();
    if (!settings.enabled || !settings.token) return { ok: true, skipped: 'not-configured' };
    let projectId = null;
    for (let attempt = 0; attempt < 3 && !projectId; attempt += 1) {
      projectId = await resolveProjectId(payload);
      if (!projectId && attempt < 2) {
        await debugLog('sync.page-ready.retry', { tabId: normalizedTabId(tabId), attempt: attempt + 1, reason: 'project-not-found' });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!projectId) return { ok: true, skipped: 'project-not-found' };
    const checkKey = syncKey(projectId, tabId);
    if (automaticSyncChecks.has(checkKey)) return { ok: true, skipped: 'check-in-progress', projectId };
    automaticSyncChecks.add(checkKey);
    try {
      const linked = settings.projectMap?.[projectId];
      const projectResponse = await wsJson(`/projects/${encodeURIComponent(projectId)}`);
      const { project, revision, version, ready } = projectReadiness(projectResponse);
      if (!ready) {
        await debugLog('sync.page-ready.skipped', {
          projectId,
          tabId: normalizedTabId(tabId),
          reason: 'project-not-ready',
          slug: project.slug || null,
          version,
          draft: revision.draft ?? null
        });
        scheduleReadinessRetry({ ...payload, projectId }, tabId);
        return { ok: true, skipped: 'project-not-ready', projectId };
      }
      cancelReadinessRetry(projectId, tabId);
      await debugLog('sync.page-ready.ready', {
        projectId,
        tabId: normalizedTabId(tabId),
        slug: project.slug,
        version
      });
      if (linked && String(knownSyncedVersion(settings, projectId)) === String(version)) {
        await debugLog('sync.page-ready.skipped', { projectId, tabId: normalizedTabId(tabId), reason: 'version-already-synced', version });
        cancelReadinessRetry(projectId, tabId);
        return { ok: true, skipped: 'version-already-synced', projectId };
      }
      const readyPayload = {
        ...payload,
        projectId,
        title: payload.title || project.title || null,
        slug: project.slug || null
      };
      rememberProjectLogScope(projectId, tabId);
      setSyncIndicator(true, tabId);
      if (normalizedTabId(tabId) !== null) api.tabs.sendMessage(normalizedTabId(tabId), { type: 'SYNC_STARTED', source: 'project-page-ready' }).catch(() => {});
      return await sync(readyPayload, tabId);
    } finally {
      automaticSyncChecks.delete(checkKey);
    }
  }

  async function currentRevision(projectId) {
    let project = {};
    try { project = await wsJson(`/projects/${encodeURIComponent(projectId)}`); } catch {}
    const projectData = project.project || project.site || project;
    const direct = projectData.current_revision || projectData.currentRevision || projectData.revision;
    const directVersion = projectData.current_version ?? projectData.currentVersion ?? direct?.version;
    if (directVersion !== undefined && directVersion !== null) {
      return { version: directVersion, revision: normalizedRevision(direct || { version: directVersion }) };
    }
    const revisionsResponse = await wsJson(`/projects/${encodeURIComponent(projectId)}/revisions?first=50`);
    const revisions = unwrap(revisionsResponse, 'revisions').map(normalizedRevision).filter(Boolean);
    revisions.sort((a, b) => Number(a.version ?? a.revision_number ?? 0) - Number(b.version ?? b.revision_number ?? 0));
    const revision = revisions[revisions.length - 1];
    if (!revision) throw new Error('No Websim revision was found for this project');
    return { version: revision.version ?? revision.revision_number, revision };
  }

  async function revisionFiles(projectId, version, revision) {
    const files = {};
    let html = revision.html || (typeof revision.content === 'string' ? revision.content : null) || revision.source || null;
    const cdnBase = `https://${projectId}.c.websim.com`;
    if (!html) {
      const htmlResponse = await fetch(`${cdnBase}/index.html?v=${encodeURIComponent(version)}`);
      if (htmlResponse.ok) html = await htmlResponse.text();
    }
    if (html) files['index.html'] = new TextEncoder().encode(html);

    let assets = [];
    try {
      assets = unwrap(await wsJson(`/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(version)}/assets`), 'assets');
    } catch {}
    const selected = assets.filter((asset) => asset?.path && asset.path !== 'index.html').slice(0, 80);
    await Promise.all(selected.map(async (asset) => {
      const path = String(asset.path).replace(/^[/\\.]+/, '');
      if (typeof asset.content === 'string' && asset.content) {
        files[path] = new TextEncoder().encode(asset.content);
        return;
      }
      try {
        const response = await fetch(`${cdnBase}/${path.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(version)}`);
        if (response.ok) files[path] = new Uint8Array(await response.arrayBuffer());
      } catch {}
    }));
    if (!Object.keys(files).length) throw new Error('The revision did not expose any files');
    return files;
  }

  function toBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  function generatedRepoName(projectId, title, slug) {
    const readable = String(slug || title || 'websim-project').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 54) || 'project';
    const suffix = String(projectId || 'backup').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase() || 'backup';
    return `websim-${readable}-${suffix}`.slice(0, 100);
  }

  function branchName(settings, repository) {
    if (settings.branchMode === 'default') return repository.default_branch || 'main';
    if (settings.branchMode === 'custom') {
      return String(settings.customBranch || 'main').trim()
        .replace(/[^a-zA-Z0-9._/-]/g, '-').replace(/^\/|\/$/g, '') || 'main';
    }
    return settings.branchMode || 'main';
  }

  async function findExistingRepository(owner, token, projectId, repoNames) {
    for (const repoName of repoNames) {
      try {
        const repository = await githubRequest(repoPath(owner, repoName), token);
        await debugLog('repository.resolve.found', {
          owner,
          repo: repository.name || repoName,
          source: repoName === repoNames[0] ? 'project-map' : 'generated-name',
          size: repository.size ?? null,
          defaultBranch: repository.default_branch || null
        });
        return repository;
      } catch (error) {
        if (!/not found/i.test(error.message)) throw error;
      }
    }

    for (let page = 1; page <= 10; page += 1) {
      const repositories = await githubRequest(`/user/repos?per_page=100&page=${page}&sort=updated`, token);
      const match = (Array.isArray(repositories) ? repositories : []).find((repository) => {
        const name = String(repository.name || '').toLowerCase();
        const projectSuffix = String(projectId || '').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
        return repoNames.some((candidate) => name === String(candidate).toLowerCase()) ||
          (projectSuffix && name.endsWith(`-${projectSuffix}`) && name.startsWith('websim-')) ||
          String(repository.description || '').includes(String(projectId || ''));
      });
      if (match) {
        await debugLog('repository.resolve.found', {
          owner,
          repo: match.name,
          source: 'repository-list',
          size: match.size ?? null,
          defaultBranch: match.default_branch || null
        });
        return match;
      }
      if (!Array.isArray(repositories) || repositories.length < 100) break;
    }
    return null;
  }

  async function ensureRepository(payload, revision, settings) {
    await debugLog('repository.resolve.start', {
      projectId: payload.projectId,
      requestedName: generatedRepoName(payload.projectId, payload.title || revision.title, payload.slug || revision.slug)
    });
    const user = await githubRequest('/user', settings.token);
    const owner = user.login;
    const mapped = settings.projectMap?.[payload.projectId];
    const generatedName = generatedRepoName(payload.projectId, payload.title || revision.title, payload.slug || revision.slug);
    const repoNames = [...new Set([mapped?.repo, generatedName].filter(Boolean))];
    let repository = await findExistingRepository(owner, settings.token, payload.projectId, repoNames);
    let created = false;
    const repoName = generatedName;
    if (!repository) {
      repository = await githubRequest('/user/repos', settings.token, {
        method: 'POST',
        body: JSON.stringify({
          name: repoName,
          description: `Websim backup for ${payload.title || payload.projectId}`,
          private: settings.visibility !== 'public',
          auto_init: false
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      created = true;
      await debugLog('repository.created', {
        owner,
        repo: repoName,
        visibility: settings.visibility === 'public' ? 'public' : 'private'
      });
    }
    const mappedRepository = mapped?.repo && String(repository.name || repoName).toLowerCase() === String(mapped.repo).toLowerCase();
    return {
      owner,
      repo: repository.name || repoName,
      branch: mappedRepository && mapped.branch ? mapped.branch : branchName(settings, repository),
      defaultBranch: repository.default_branch || 'main',
      empty: repository.size === 0 || !repository.default_branch,
      created
    };
  }

  async function githubRequest(path, token, options = {}) {
    const method = options.method || 'GET';
    await debugLog('github.request', { method, path });
    try {
      const data = await jsonRequest(`${GH_API}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {}) }
      });
      await debugLog('github.response', { method, path, status: 200 });
      return data;
    } catch (error) {
      await debugLog('github.error', { method, path, status: error.status || null, message: error.message });
      throw error;
    }
  }

  async function commitToGithub(files, project, revision, settings, target) {
    const basePath = repoPath(target.owner, target.repo);
    const branch = encodeURIComponent(target.branch);
    const version = revision.version ?? revision.revision_number ?? project.version ?? '?';
    const title = String(project.title || revision.title || project.projectId || 'Websim project').replace(/[\r\n]+/g, ' ').slice(0, 120);
    await debugLog('git.bootstrap.start', {
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      emptyRepository: Boolean(target.empty),
      fileCount: Object.keys(files).length
    });
    if (target.empty) {
      const bootstrapPath = files['index.html'] ? 'index.html' : Object.keys(files)[0];
      let bootstrap = null;
      try {
        bootstrap = await githubRequest(`${basePath}/contents/${bootstrapPath.split('/').map(encodeURIComponent).join('/')}`, settings.token, {
          method: 'PUT',
          body: JSON.stringify({
            message: `v${version}: ${title}`,
            content: toBase64(files[bootstrapPath]),
            branch: target.defaultBranch || 'main'
          }),
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        if (![409, 422].includes(error.status)) throw error;
        const refreshed = await githubRequest(basePath, settings.token);
        if (!refreshed.default_branch) throw error;
        target.empty = false;
      }
      const bootstrapSha = bootstrap?.commit?.sha;
      if (bootstrapSha) {
        await debugLog('git.repository.initialized', {
          owner: target.owner,
          repo: target.repo,
          branch: target.defaultBranch || 'main',
          commitSha: bootstrapSha,
          bootstrapPath
        });
        target.empty = false;
        if (Object.keys(files).length === 1 && bootstrapPath === 'index.html') {
          await debugLog('git.branch.ready', { owner: target.owner, repo: target.repo, branch: target.branch, commitSha: bootstrapSha });
          return {
            sha: bootstrapSha,
            version,
            title,
            url: bootstrap.commit.html_url || `https://github.com/${target.owner}/${target.repo}/commit/${bootstrapSha}`
          };
        }
      }
    }
    let parentSha = null;
    let branchExists = false;
    if (!target.empty) {
      try {
        const ref = await githubRequest(`${basePath}/git/ref/heads/${branch}`, settings.token);
        parentSha = ref.object?.sha || null;
        branchExists = Boolean(parentSha);
      } catch (error) {
        if (!/not found|empty/i.test(error.message) && error.status !== 409) throw error;
        if (target.branch !== target.defaultBranch) {
          try {
            const defaultRef = await githubRequest(`${basePath}/git/ref/heads/${encodeURIComponent(target.defaultBranch || 'main')}`, settings.token);
            parentSha = defaultRef.object?.sha || null;
          } catch (fallbackError) {
            if (!/not found|empty/i.test(fallbackError.message) && fallbackError.status !== 409) throw fallbackError;
          }
        }
      }
    }
    const parentCommit = parentSha ? await githubRequest(`${basePath}/git/commits/${parentSha}`, settings.token) : null;
    const blobEntries = await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({
      path, mode: '100644', type: 'blob',
      sha: (await githubRequest(`${basePath}/git/blobs`, settings.token, {
        method: 'POST', body: JSON.stringify({ content: toBase64(bytes), encoding: 'base64' }),
        headers: { 'Content-Type': 'application/json' }
      })).sha
    })));
    const tree = await githubRequest(`${basePath}/git/trees`, settings.token, {
      method: 'POST', body: JSON.stringify({ base_tree: parentCommit?.tree?.sha, tree: blobEntries }),
      headers: { 'Content-Type': 'application/json' }
    });
    await debugLog('git.tree.created', {
      owner: target.owner,
      repo: target.repo,
      treeSha: tree.sha,
      parentSha: parentSha || null
    });
    let commit = await githubRequest(`${basePath}/git/commits`, settings.token, {
      method: 'POST',
      body: JSON.stringify({
        message: `v${version}: ${title}`,
        tree: tree.sha,
        ...(parentSha ? { parents: [parentSha] } : {})
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    await debugLog('git.commit.created', {
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      commitSha: commit.sha,
      parentSha: parentSha || null
    });
    let refParentSha = parentSha;
    let refExists = branchExists;
    let refUpdated = false;
    for (let attempt = 0; attempt < 3 && !refUpdated; attempt += 1) {
      try {
        if (refParentSha && refExists) {
          await githubRequest(`${basePath}/git/refs/heads/${branch}`, settings.token, {
            method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          await githubRequest(`${basePath}/git/refs`, settings.token, {
            method: 'POST', body: JSON.stringify({ ref: `refs/heads/${target.branch}`, sha: commit.sha }),
            headers: { 'Content-Type': 'application/json' }
          });
        }
        refUpdated = true;
      } catch (error) {
        if (error.status !== 422 || !/fast.?forward/i.test(error.message) || attempt === 2) throw error;
        const latestRef = await githubRequest(`${basePath}/git/ref/heads/${branch}`, settings.token);
        const latestParentSha = latestRef.object?.sha || null;
        if (!latestParentSha) throw error;
        if (latestParentSha === commit.sha) {
          refUpdated = true;
          break;
        }
        const latestParent = await githubRequest(`${basePath}/git/commits/${latestParentSha}`, settings.token);
        const retryTree = await githubRequest(`${basePath}/git/trees`, settings.token, {
          method: 'POST',
          body: JSON.stringify({ base_tree: latestParent.tree?.sha, tree: blobEntries }),
          headers: { 'Content-Type': 'application/json' }
        });
        commit = await githubRequest(`${basePath}/git/commits`, settings.token, {
          method: 'POST',
          body: JSON.stringify({
            message: `v${version}: ${title}`,
            tree: retryTree.sha,
            parents: [latestParentSha]
          }),
          headers: { 'Content-Type': 'application/json' }
        });
        refParentSha = latestParentSha;
        refExists = true;
        await debugLog('git.ref.retry', {
          owner: target.owner,
          repo: target.repo,
          branch: target.branch,
          attempt: attempt + 1,
          previousParentSha: parentSha || null,
          latestParentSha,
          retryCommitSha: commit.sha
        });
      }
    }
    if (!refUpdated) {
      throw new Error('GitHub branch ref could not be updated after concurrent changes');
    }
    await debugLog('git.branch.ready', {
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      commitSha: commit.sha
    });
    return { sha: commit.sha, version, title, url: commit.html_url || `https://github.com/${target.owner}/${target.repo}/commit/${commit.sha}` };
  }

  async function remember(event, versionKey) {
    const stored = await config();
    const events = [event, ...(stored.lastEvents || [])].slice(0, 12);
    await storageSet({ lastEvents: events, syncedVersions: { ...(stored.syncedVersions || {}), [versionKey]: event.version } });
  }

  async function sync(payload, tabId) {
    const settings = await config();
    await debugLog('sync.request.received', { tabId: normalizedTabId(tabId), projectId: payload?.projectId || null, url: payload?.url ? String(payload.url).split(/[?#]/)[0] : null, title: payload?.title || null });
    if (!settings.enabled) {
      await debugLog('sync.blocked', { reason: 'auto-sync-disabled' });
      throw new Error('Auto-sync is paused in the extension popup');
    }
      if (!settings.token) {
      await debugLog('sync.blocked', { reason: 'github-token-missing' });
      throw new Error('Open the extension popup and finish GitHub setup');
    }
    let stage = 'resolve-project';
    await debugLog('sync.start', { projectId: payload?.projectId || null, url: payload?.url || null, title: payload?.title || null });
    let projectId = null;
    try {
      projectId = await resolveProjectId(payload);
      if (!projectId) throw new Error('Could not identify the pinned project');
      rememberProjectLogScope(projectId, tabId);
      const runKey = syncKey(projectId, tabId);
      if (syncInFlight.has(runKey)) {
        await debugLog('sync.skipped-in-flight', { projectId, tabId: normalizedTabId(tabId) });
        return {
          ok: true,
          inProgress: true,
          skipped: 'in-progress',
          message: 'This project is already being synced'
        };
      }
      syncInFlight.add(runKey);
      activeSyncs.add(runKey);
      setSyncIndicator(true, tabId);
      const readiness = projectReadiness(await wsJson(`/projects/${encodeURIComponent(projectId)}`));
      if (!readiness.ready) {
        await debugLog('sync.skipped', {
          projectId,
          reason: 'project-not-ready',
          slug: readiness.project.slug || null,
          version: readiness.version,
          draft: readiness.revision.draft ?? null
        });
        return { ok: true, skipped: 'project-not-ready', message: 'Websim has not finalized this draft revision yet' };
      }
      stage = 'fetch-current-revision';
      const { version, revision } = await currentRevision(projectId);
      await debugLog('websim.revision.selected', { projectId, version });
      stage = 'resolve-or-create-repository';
      const target = await ensureRepository({
        ...payload,
        projectId,
        title: payload.title || readiness.project.title || null,
        slug: readiness.project.slug || null
      }, revision, settings);
      rememberRepoLogScope(target.owner, target.repo, projectId, tabId);
      const versionKey = `${target.owner}/${target.repo}:${projectId}:${target.branch}`;
      if (String(settings.syncedVersions?.[versionKey]) === String(version)) {
        await debugLog('sync.skipped-duplicate', { projectId, version, owner: target.owner, repo: target.repo, branch: target.branch });
        return { ok: true, message: `v${version} is already in ${target.owner}/${target.repo}` };
      }
      stage = 'fetch-revision-files';
      const files = await revisionFiles(projectId, version, revision);
      stage = 'create-github-commit';
      const commit = await commitToGithub(files, { ...payload, projectId }, revision, settings, target);
      const stored = await config();
      await storageSet({
        owner: target.owner,
        projectMap: { ...(stored.projectMap || {}), [projectId]: { repo: target.repo, branch: target.branch } }
      });
      await remember({ title: commit.title, version: commit.version, projectId, tabId: normalizedTabId(tabId), repo: target.repo, branch: target.branch, sha: commit.sha, url: commit.url, at: Date.now() }, versionKey);
      await debugLog('sync.complete', { projectId, version, owner: target.owner, repo: target.repo, branch: target.branch, commitSha: commit.sha });
      return { ok: true, message: `${target.created ? 'Created repo and committed' : 'Committed'} v${commit.version} to ${target.owner}/${target.repo} · ${target.branch}`, commit };
    } catch (error) {
      await debugLog('sync.failed', { stage, status: error.status || null, message: error.message });
      throw error;
    } finally {
      if (projectId) {
        const runKey = syncKey(projectId, tabId);
        syncInFlight.delete(runKey);
        activeSyncs.delete(runKey);
        setSyncIndicator(activeSyncForTab(tabId), tabId);
      }
    }
  }

  async function triggerAutoSync(details, mutation, body, beforeState) {
    const tabId = Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null;
    rememberProjectLogScope(mutation.projectId, tabId);
    await debugLog('pin.candidate.response', { tabId, projectId: mutation.projectId, status: details.statusCode, body });
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const settings = await config();
    const afterState = await readProjectMutationState(mutation.projectId);
    if (!beforeState || !afterState) {
      await debugLog('pin.candidate.ignored', {
        projectId: mutation.projectId,
        reason: 'pin-state-unavailable'
      });
      return;
    }
    if (beforeState.version === afterState.version && beforeState.fingerprint === afterState.fingerprint) {
      await debugLog('pin.candidate.ignored', {
        projectId: mutation.projectId,
        reason: 'pin-state-unchanged',
        version: afterState.version
      });
      return;
    }
    if (afterState && knownSyncedVersion(settings, mutation.projectId) !== null &&
      String(knownSyncedVersion(settings, mutation.projectId)) === String(afterState.version)) {
      await debugLog('pin.candidate.ignored', {
        projectId: mutation.projectId,
        reason: 'version-already-synced',
        version: afterState.version
      });
      return;
    }
    let tab = null;
    if (tabId !== null) {
      try { tab = await api.tabs.get(tabId); } catch {}
    }
    const payload = { projectId: mutation.projectId, url: tab?.url || details.documentUrl || `https://websim.com/p/${mutation.projectId}`, title: null };
    await debugLog('pin.autosync.trigger', { tabId, ...payload });
    setSyncIndicator(true, tabId);
    if (tabId !== null) api.tabs.sendMessage(tabId, { type: 'SYNC_STARTED', source: 'project-patch' }).catch(() => {});
    sync(payload, tabId).then((result) => { notify(tabId, result); }).catch((error) => {
      const result = { ok: false, message: error.message };
      notify(tabId, result);
    });
  }

  async function notify(tabId, result) {
    setSyncIndicator(activeSyncForTab(tabId), tabId);
    if (result?.inProgress || result?.skipped === 'in-progress') return;
    if (Number.isInteger(tabId) && tabId >= 0) api.tabs.sendMessage(tabId, { type: 'SYNC_RESULT', ...result }).catch(() => {});
    if (result.ok && api.notifications) {
      api.notifications.create(`pin-${Date.now()}`, { type: 'basic', title: 'Pin to GitHub', message: result.message, iconUrl: api.runtime.getURL('icon-128.png') }).catch(() => {});
    }
  }

  async function projectLink(payload) {
    const settings = await config();
    if (!settings.token) return { ok: true, status: 'not-configured' };
    const projectId = await resolveProjectId(payload);
    if (!projectId) return { ok: true, status: 'not-websim' };
    rememberProjectLogScope(projectId, payload.tabId);
    const mapped = settings.projectMap?.[projectId];
    const user = await githubRequest('/user', settings.token);
    let project = {};
    try {
      const response = await wsJson(`/projects/${encodeURIComponent(projectId)}`);
      project = projectReadiness(response).project;
    } catch {}
    const generatedName = generatedRepoName(projectId, payload?.title || project.title, project.slug);
    const names = [...new Set([mapped?.repo, generatedName].filter(Boolean))];
    const repository = await findExistingRepository(user.login, settings.token, projectId, names);
    const repo = repository?.name || generatedName;
    rememberRepoLogScope(user.login, repo, projectId, payload.tabId);
    const mappedRepository = mapped?.repo && repo.toLowerCase() === String(mapped.repo).toLowerCase();
    const branch = mappedRepository && mapped.branch ? mapped.branch : branchName(settings, repository || {});
    await debugLog('repository.link.preview', { projectId, owner: user.login, repo, branch, status: repository ? 'linked' : 'planned' });
    return { ok: true, status: repository ? 'linked' : 'planned', projectId, owner: user.login, repo, branch, url: `https://github.com/${user.login}/${repo}` };
  }

  if (api.webRequest?.onBeforeRequest) {
    const requestFilter = { urls: ['https://websim.com/*', 'https://*.websim.com/*'] };
    try {
      api.webRequest.onBeforeRequest.addListener((details) => {
        const url = websimNetworkUrl(details.url);
        if (!url) return;
        const mutation = details.method === 'PATCH' ? projectMutation(details.url) : null;
        const body = requestBodySummary(details.requestBody);
        const tabId = normalizedTabId(details.tabId);
        const read = details.method === 'GET' ? projectActivityRead(details.url) : null;
        if (mutation) {
          const beforeState = readProjectMutationState(mutation.projectId);
          trackedWebsimRequests.set(requestKey(details), { mutation, body, beforeState, tabId: details.tabId });
          debugLog('pin.candidate.request', { tabId: details.tabId, projectId: mutation.projectId, method: details.method, body });
        }
        if (read && tabId !== null) {
          autoSyncNewProject({ projectId: read.projectId, url: details.documentUrl || details.url, title: null }, tabId).then((result) => {
            if (!result?.skipped) notify(tabId, result);
          }).catch((error) => {
            debugLog('sync.page-ready.failed', { tabId, projectId: read.projectId, message: error.message });
          });
        }
        config().then((state) => state.advancedLogs && debugLog('network.request', {
          requestId: details.requestId,
          tabId: normalizedTabId(details.tabId),
          method: details.method,
          type: details.type,
          url,
          ...(mutation ? { projectId: mutation.projectId, body } : {})
        }));
      }, requestFilter, ['requestBody']);
      api.webRequest.onCompleted?.addListener((details) => {
        const url = websimNetworkUrl(details.url);
        if (!url) return;
        const tracked = trackedWebsimRequests.get(requestKey(details));
        if (tracked) {
          trackedWebsimRequests.delete(requestKey(details));
          Promise.resolve(tracked.beforeState).then((beforeState) =>
            triggerAutoSync(details, tracked.mutation, tracked.body, beforeState)
          ).catch((error) => {
            debugLog('pin.autosync.failed', { tabId: details.tabId, projectId: tracked.mutation.projectId, message: error.message });
          });
        }
        config().then((state) => state.advancedLogs && debugLog('network.response', {
          requestId: details.requestId,
          tabId: normalizedTabId(details.tabId),
          status: details.statusCode,
          type: details.type,
          url
        }));
      }, requestFilter);
      api.webRequest.onErrorOccurred?.addListener((details) => {
        const url = websimNetworkUrl(details.url);
        if (!url) return;
        const tracked = trackedWebsimRequests.get(requestKey(details));
        if (tracked) {
          trackedWebsimRequests.delete(requestKey(details));
          debugLog('pin.candidate.failed', { tabId: details.tabId, projectId: tracked.mutation.projectId, error: details.error, body: tracked.body });
        }
        config().then((state) => state.advancedLogs && debugLog('network.error', {
          requestId: details.requestId,
          tabId: normalizedTabId(details.tabId),
          error: details.error,
          type: details.type,
          url
        }));
      }, requestFilter);
      debugLog('network.monitor.ready', { watches: ['PATCH /api/v1/projects/{id}', 'Websim API requests'] });
    } catch (error) {
      debugLog('network.monitor.unavailable', { message: error.message });
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_STATE') {
      stateForContext(message).then(sendResponse).catch(() => stateForContext().then(sendResponse));
      return true;
    }
    if (message?.type === 'GET_LOGS') {
      stateForContext(message).then((state) => sendResponse({ logs: state.debugLogs || [], activeProjectId: state.activeProjectId, activeTabId: state.activeTabId }));
      return true;
    }
    if (message?.type === 'GET_PROJECT_LINK') {
      projectLink(message).then(sendResponse).catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (message?.type === 'CLEAR_LOGS') {
      clearLogsForContext(message).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === 'PROJECT_PAGE_READY') {
      const tabId = normalizedTabId(sender.tab?.id);
      autoSyncNewProject(message.payload || message, tabId).then((result) => {
        if (!result?.skipped) notify(tabId, result);
        sendResponse(result);
      }).catch((error) => {
        const result = { ok: false, message: error.message };
        notify(tabId, result);
        sendResponse(result);
      });
      return true;
    }
    if (message?.type === 'SET_DEBUG_MODE') {
      storageSet({ advancedLogs: Boolean(message.enabled) }).then(() => sendResponse({ ok: true, advancedLogs: Boolean(message.enabled) }));
      return true;
    }
    if (message?.type === 'DEBUG_EVENT') {
      config().then((stored) => {
        if (!stored.advancedLogs) return sendResponse({ ok: true, recorded: false });
        const detail = safeDebugDetail(message.detail);
        if (sender.tab?.id !== undefined) detail.tabId = normalizedTabId(sender.tab.id);
        debugLog(message.event || 'content.debug', detail).then(() => sendResponse({ ok: true, recorded: true }));
      });
      return true;
    }
    if (message?.type === 'SAVE_SETTINGS') {
      config().then((stored) => storageSet({
        ...stored,
        ...message.settings,
        token: message.settings.token || stored.token
      })).then(async () => {
        const saved = await config();
        let owner = saved.owner || '';
        if (saved.token) {
          const user = await githubRequest('/user', saved.token);
          owner = user.login;
          await storageSet({ owner });
        }
        sendResponse({ ok: true, owner });
      }).catch((error) => sendResponse({ ok: false, message: error.message }));
      return true;
    }
    if (message?.type === 'PIN_DETECTED') {
      debugLog('pin.message.received', { tabId: sender.tab?.id || null, senderUrl: sender.url ? String(sender.url).split(/[?#]/)[0] : null, payload: safeDebugDetail(message.payload || {}) });
      setSyncIndicator(true, sender.tab?.id);
      sync(message.payload, sender.tab?.id).then((result) => { notify(sender.tab?.id, result); sendResponse(result); })
        .catch((error) => { const result = { ok: false, message: error.message }; notify(sender.tab?.id, result); sendResponse(result); });
      return true;
    }
    if (message?.type === 'SYNC_CURRENT') {
      const tabId = message.tabId;
      const url = message.url || '';
      const projectId = url.match(/\/(?:c|p)\/([a-zA-Z0-9_-]+)/)?.[1] || url.match(/^https:\/\/([a-zA-Z0-9_-]+)\.c\.websim\.com/)?.[1];
      setSyncIndicator(true, tabId);
      sync({ projectId, url, title: message.title }, tabId).then((result) => { notify(tabId, result); sendResponse(result); })
        .catch((error) => { const result = { ok: false, message: error.message }; notify(tabId, result); sendResponse(result); });
      return true;
    }
  });

  api.runtime.onInstalled.addListener(() => storageGet(defaults).then((stored) => storageSet({ ...defaults, ...stored })));
})();
