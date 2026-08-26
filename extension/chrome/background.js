(() => {
  const api = globalThis.browser || globalThis.chrome;
  const GH_API = 'https://api.github.com';
  const WS_API = 'https://websim.com/api/v1';
  const defaults = {
    enabled: true, token: '', owner: '', branchMode: 'main', customBranch: '',
    visibility: 'private', lastEvents: [], syncedVersions: {}, projectMap: {}, debugLogs: []
  };

  const storageGet = (keys) => new Promise((resolve) => api.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => api.storage.local.set(value, resolve));
  let logQueue = Promise.resolve();

  function debugLog(event, detail = {}) {
    const entry = { at: new Date().toISOString(), event, ...detail };
    logQueue = logQueue.then(async () => {
      const stored = await storageGet({ debugLogs: [] });
      await storageSet({ debugLogs: [...(stored.debugLogs || []), entry].slice(-160) });
    }).catch(() => {});
    return logQueue;
  }

  async function config() {
    const stored = await storageGet(defaults);
    return { ...defaults, ...stored };
  }

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, { ...options, headers: {
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

  async function resolveProjectId(payload) {
    if (payload?.projectId) return payload.projectId;
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

  function generatedRepoName(projectId, title) {
    const readable = String(title || 'websim-project').toLowerCase()
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

  async function ensureRepository(payload, revision, settings) {
    await debugLog('repository.resolve.start', {
      projectId: payload.projectId,
      requestedName: generatedRepoName(payload.projectId, payload.title || revision.title)
    });
    const user = await githubRequest('/user', settings.token);
    const owner = user.login;
    const mapped = settings.projectMap?.[payload.projectId];
    const repoName = mapped?.repo || generatedRepoName(payload.projectId, payload.title || revision.title);
    let repository;
    let created = false;
    try {
      repository = await githubRequest(repoPath(owner, repoName), settings.token);
      await debugLog('repository.resolve.found', {
        owner,
        repo: repoName,
        size: repository.size ?? null,
        defaultBranch: repository.default_branch || null
      });
    } catch (error) {
      if (!/not found|empty/i.test(error.message)) throw error;
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
    return {
      owner,
      repo: repository.name || repoName,
      branch: mapped?.branch || branchName(settings, repository),
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
    await debugLog('git.bootstrap.start', {
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      emptyRepository: Boolean(target.empty),
      fileCount: Object.keys(files).length
    });
    let parentSha = null;
    let branchExists = false;
    if (target.empty) {
      const seedPath = files['index.html'] ? 'index.html' : Object.keys(files)[0];
      await debugLog('git.empty.seed.start', { owner: target.owner, repo: target.repo, branch: target.branch, path: seedPath });
      const seed = await githubRequest(`${basePath}/contents/${seedPath.split('/').map(encodeURIComponent).join('/')}`, settings.token, {
        method: 'PUT',
        body: JSON.stringify({
          message: `Initialize Websim repository`,
          content: toBase64(files[seedPath]),
          branch: target.branch
        }),
        headers: { 'Content-Type': 'application/json' }
      });
      await debugLog('git.empty.seed.complete', { owner: target.owner, repo: target.repo, branch: target.branch, commitSha: seed.commit?.sha || null });
      target.empty = false;
    }
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
    const version = revision.version ?? revision.revision_number ?? project.version ?? '?';
    const title = String(project.title || revision.title || project.projectId || 'Websim project').replace(/[\r\n]+/g, ' ').slice(0, 120);
    const commit = await githubRequest(`${basePath}/git/commits`, settings.token, {
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
    if (parentSha) {
      if (branchExists) {
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
    } else {
      await githubRequest(`${basePath}/git/refs`, settings.token, {
        method: 'POST', body: JSON.stringify({ ref: `refs/heads/${target.branch}`, sha: commit.sha }),
        headers: { 'Content-Type': 'application/json' }
      });
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
    if (!settings.enabled) throw new Error('Auto-sync is paused in the extension popup');
    if (!settings.token) throw new Error('Open the extension popup and finish GitHub setup');
    let stage = 'resolve-project';
    await debugLog('sync.start', { projectId: payload?.projectId || null, url: payload?.url || null, title: payload?.title || null });
    try {
      const projectId = await resolveProjectId(payload);
      if (!projectId) throw new Error('Could not identify the pinned project');
      stage = 'fetch-current-revision';
      const { version, revision } = await currentRevision(projectId);
      await debugLog('websim.revision.selected', { projectId, version });
      stage = 'resolve-or-create-repository';
      const target = await ensureRepository({ ...payload, projectId }, revision, settings);
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
      await remember({ title: commit.title, version: commit.version, projectId, repo: target.repo, branch: target.branch, sha: commit.sha, url: commit.url, at: Date.now() }, versionKey);
      await debugLog('sync.complete', { projectId, version, owner: target.owner, repo: target.repo, branch: target.branch, commitSha: commit.sha });
      return { ok: true, message: `${target.created ? 'Created repo and committed' : 'Committed'} v${commit.version} to ${target.owner}/${target.repo} · ${target.branch}`, commit };
    } catch (error) {
      await debugLog('sync.failed', { stage, status: error.status || null, message: error.message });
      throw error;
    }
  }

  async function notify(tabId, result) {
    if (tabId) api.tabs.sendMessage(tabId, { type: 'SYNC_RESULT', ...result }).catch(() => {});
    if (result.ok && api.notifications) {
      api.notifications.create(`pin-${Date.now()}`, { type: 'basic', title: 'Pin to GitHub', message: result.message, iconUrl: api.runtime.getURL('icon.svg') }).catch(() => {});
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_STATE') {
      config().then((stored) => sendResponse({ ...stored, token: '', hasToken: Boolean(stored.token) }));
      return true;
    }
    if (message?.type === 'GET_LOGS') {
      config().then((stored) => sendResponse({ logs: stored.debugLogs || [] }));
      return true;
    }
    if (message?.type === 'CLEAR_LOGS') {
      storageSet({ debugLogs: [] }).then(() => sendResponse({ ok: true }));
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
      sync(message.payload, sender.tab?.id).then((result) => { notify(sender.tab?.id, result); sendResponse(result); })
        .catch((error) => { const result = { ok: false, message: error.message }; notify(sender.tab?.id, result); sendResponse(result); });
      return true;
    }
    if (message?.type === 'SYNC_CURRENT') {
      const tabId = message.tabId;
      const url = message.url || '';
      const projectId = url.match(/\/(?:c|p)\/([a-zA-Z0-9_-]+)/)?.[1] || url.match(/^https:\/\/([a-zA-Z0-9_-]+)\.c\.websim\.com/)?.[1];
      sync({ projectId, url, title: message.title }, tabId).then((result) => { notify(tabId, result); sendResponse(result); })
        .catch((error) => { const result = { ok: false, message: error.message }; notify(tabId, result); sendResponse(result); });
      return true;
    }
  });

  api.runtime.onInstalled.addListener(() => storageGet(defaults).then((stored) => storageSet({ ...defaults, ...stored })));
})();
