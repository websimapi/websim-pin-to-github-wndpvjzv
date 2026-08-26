(() => {
  const api = globalThis.browser || globalThis.chrome;
  const GH_API = 'https://api.github.com', WS_API = 'https://websim.com/api/v1';
  const defaults = { enabled:true, token:'', owner:'', branchMode:'main', customBranch:'', visibility:'private', lastEvents:[], syncedVersions:{}, projectMap:{}, debugLogs:[], advancedLogs:false };
  const storageGet = (keys) => new Promise((resolve) => api.storage.local.get(keys, resolve));
  const storageSet = (value) => new Promise((resolve) => api.storage.local.set(value, resolve));
  let logQueue = Promise.resolve();
  const trackedWebsimRequests = new Map();
  const syncInFlight = new Set();
  function debugLog(event, detail = {}) {
    const entry = { at:new Date().toISOString(), event, ...detail };
    logQueue = logQueue.then(async () => { const stored = await storageGet({ debugLogs:[] }); await storageSet({ debugLogs:[...(stored.debugLogs || []), entry].slice(-160) }); }).catch(() => {});
    return logQueue;
  }
  function safeDebugDetail(detail = {}) { return Object.fromEntries(Object.entries(detail).slice(0,24).map(([key,value]) => { if (typeof value === 'string') return [key,value.replace(/([?&](?:token|access_token|authorization|code|key)=)[^&]*/gi,'$1[redacted]').slice(0,400)]; if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key,value]; return [key,String(value).slice(0,400)]; })); }
  function websimNetworkUrl(value) { try { const url = new URL(value); if (!/(^|\.)websim\.com$/i.test(url.hostname)) return null; if (!/\/api\//i.test(url.pathname) && !/(pin|pinned|bookmark|collection|save)/i.test(url.pathname)) return null; return `${url.origin}${url.pathname}`; } catch { return null; } }
  function projectMutation(value) { try { const url=new URL(value), match=url.pathname.match(/\/api\/v1\/projects\/([^/]+)$/i); return match ? { projectId:decodeURIComponent(match[1]) } : null; } catch { return null; } }
  function requestBodySummary(body) { if (!body) return { kind:null, keys:[], versionFields:{} }; let parsed=body.formData || null; if (!parsed && body.raw?.length) { try { const bytes=body.raw.find((part) => part.bytes)?.bytes, text=bytes ? new TextDecoder().decode(bytes) : ''; parsed=text ? JSON.parse(text) : null; } catch {} } if (!parsed || typeof parsed !== 'object') return { kind:'raw', keys:[], versionFields:{} }; const versionFields=Object.fromEntries(Object.entries(parsed).filter(([key]) => /pin|version|revision/i.test(key)).map(([key,value]) => [key,typeof value === 'string' ? value.slice(0,80) : value])); return { kind:body.formData ? 'formData' : 'json', keys:Object.keys(parsed).slice(0,40), versionFields }; }
  function setSyncIndicator(active) { const action=api.action || api.browserAction; if (!action) return; Promise.resolve(action.setBadgeText?.({ text:active ? '…' : '' })).catch(() => {}); Promise.resolve(action.setBadgeBackgroundColor?.({ color:active ? '#d9ee65' : '#11131a' })).catch(() => {}); Promise.resolve(action.setTitle?.({ title:active ? 'Pin to GitHub · syncing…' : 'Pin to GitHub' })).catch(() => {}); }
  async function config() { return { ...defaults, ...(await storageGet(defaults)) }; }
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers:{ Accept:'application/vnd.github+json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.message || data?.error?.message || data?.error || `Request failed (${response.status})`); error.status = response.status; error.url = url; throw error; }
    return data;
  }
  async function wsJson(path) {
    await debugLog('websim.request', { method:'GET', path });
    try { const data = await request(`${WS_API}${path}`, { credentials:'include', headers:{ Accept:'application/json' } }); await debugLog('websim.response', { method:'GET', path, status:200 }); return data; }
    catch (error) { await debugLog('websim.error', { method:'GET', path, status:error.status || null, message:error.message }); throw error; }
  }
  async function gh(path, token, options = {}) {
    const method = options.method || 'GET'; await debugLog('github.request', { method, path });
    try { const data = await request(`${GH_API}${path}`, { ...options, headers:{ Authorization:`Bearer ${token}`, 'X-GitHub-Api-Version':'2022-11-28', ...(options.headers || {}) } }); await debugLog('github.response', { method, path, status:200 }); return data; }
    catch (error) { await debugLog('github.error', { method, path, status:error.status || null, message:error.message }); throw error; }
  }
  function unwrap(data, key) { if (data?.[key]?.data) return data[key].data; if (Array.isArray(data?.[key])) return data[key]; if (Array.isArray(data?.data)) return data.data; return []; }
  function rev(item) { return item?.project_revision || item?.revision || item; }
  function repoPath(owner, repo) { return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`; }
  function generatedRepoName(id, title) {
    const readable = String(title || 'websim-project').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,54) || 'project';
    const suffix = String(id || 'backup').replace(/[^a-z0-9]/gi,'').slice(-8).toLowerCase() || 'backup';
    return `websim-${readable}-${suffix}`.slice(0,100);
  }
  function branchName(settings, repository) {
    if (settings.branchMode === 'default') return repository.default_branch || 'main';
    if (settings.branchMode === 'custom') return String(settings.customBranch || 'main').trim().replace(/[^a-zA-Z0-9._/-]/g,'-').replace(/^\/|\/$/g,'') || 'main';
    return settings.branchMode || 'main';
  }
  async function findExistingRepository(owner, token, projectId, repoNames) {
    for (const repoName of repoNames) {
      try {
        const repository = await gh(repoPath(owner, repoName), token);
        await debugLog('repository.resolve.found', { owner, repo:repository.name || repoName, source:repoName === repoNames[0] ? 'project-map' : 'generated-name', size:repository.size ?? null, defaultBranch:repository.default_branch || null });
        return repository;
      } catch (error) { if (!/not found/i.test(error.message)) throw error; }
    }
    for (let page = 1; page <= 10; page += 1) {
      const repositories = await gh(`/user/repos?per_page=100&page=${page}&sort=updated`, token);
      const suffix = String(projectId || '').replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
      const match = (Array.isArray(repositories) ? repositories : []).find((repository) => {
        const name = String(repository.name || '').toLowerCase();
        return repoNames.some((candidate) => name === String(candidate).toLowerCase()) ||
          (suffix && name.endsWith(`-${suffix}`) && name.startsWith('websim-')) ||
          String(repository.description || '').includes(String(projectId || ''));
      });
      if (match) {
        await debugLog('repository.resolve.found', { owner, repo:match.name, source:'repository-list', size:match.size ?? null, defaultBranch:match.default_branch || null });
        return match;
      }
      if (!Array.isArray(repositories) || repositories.length < 100) break;
    }
    return null;
  }
  function projectIdFromWebsimUrl(value) { if (!value) return null; try { const url=new URL(value), route=url.pathname.match(/\/([cp])\/([a-zA-Z0-9_-]+)/), host=url.hostname.match(/^([a-zA-Z0-9_-]+)\.c\.websim\.com$/i); return route?.[2] || host?.[1] || null; } catch { return null; } }
  async function resolveProjectId(payload) {
    if (payload?.projectId) return payload.projectId;
    const directProjectId = projectIdFromWebsimUrl(payload?.url);
    if (directProjectId) return directProjectId;
    try {
      const route = new URL(payload?.url || ''), match = route.pathname.match(/^\/@([^/]+)\/([^/]+)/);
      if (!match) return null;
      const projects = unwrap(await wsJson(`/users/${encodeURIComponent(match[1])}/projects?first=100`), 'projects').map((item) => item?.project || item).filter(Boolean);
      const slug = decodeURIComponent(match[2]).toLowerCase();
      const found = projects.find((project) => String(project.slug || '').toLowerCase() === slug) || projects.find((project) => String(project.title || '').toLowerCase() === String(payload.title || '').toLowerCase());
      return found?.id || null;
    } catch { return null; }
  }
  async function currentRevision(id) {
    let project = {}; try { project = await wsJson(`/projects/${encodeURIComponent(id)}`); } catch {}
    const data = project.project || project.site || project, direct = data.current_revision || data.currentRevision || data.revision, directVersion = data.current_version ?? data.currentVersion ?? direct?.version;
    if (directVersion !== undefined && directVersion !== null) return { version:directVersion, revision:rev(direct || { version:directVersion }) };
    const list = unwrap(await wsJson(`/projects/${encodeURIComponent(id)}/revisions?first=50`), 'revisions').map(rev).filter(Boolean).sort((a,b) => Number(a.version ?? a.revision_number ?? 0) - Number(b.version ?? b.revision_number ?? 0));
    if (!list.length) throw new Error('No Websim revision was found for this project');
    return { version:list.at(-1).version ?? list.at(-1).revision_number, revision:list.at(-1) };
  }
  async function ensureRepository(payload, revision, settings) {
    const user = await gh('/user', settings.token), owner = user.login, mapped = settings.projectMap?.[payload.projectId];
    const generatedName = generatedRepoName(payload.projectId, payload.title || revision.title);
    const repoNames = [...new Set([mapped?.repo, generatedName].filter(Boolean))];
    let repository = await findExistingRepository(owner, settings.token, payload.projectId, repoNames), created = false;
    const name = generatedName;
    if (!repository) {
      repository = await gh('/user/repos', settings.token, { method:'POST', body:JSON.stringify({ name, description:`Websim backup for ${payload.title || payload.projectId}`, private:settings.visibility !== 'public', auto_init:false }), headers:{'Content-Type':'application/json'} }); created = true;
    }
    const mappedRepository = mapped?.repo && String(repository.name || name).toLowerCase() === String(mapped.repo).toLowerCase();
    return { owner, repo:repository.name || name, branch:mappedRepository && mapped.branch ? mapped.branch : branchName(settings, repository), defaultBranch:repository.default_branch || 'main', empty:!repository.default_branch, created };
  }
  function b64(bytes) { let binary=''; for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(binary); }
  async function filesFor(id, version, revision) {
    const files = {}, base = `https://${id}.c.websim.com`; let html = revision.html || (typeof revision.content === 'string' ? revision.content : null) || revision.source;
    if (!html) { const response = await fetch(`${base}/index.html?v=${encodeURIComponent(version)}`); if (response.ok) html = await response.text(); }
    if (html) files['index.html'] = new TextEncoder().encode(html);
    let assets = []; try { assets = unwrap(await wsJson(`/projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}/assets`), 'assets'); } catch {}
    await Promise.all(assets.filter((a) => a?.path && a.path !== 'index.html').slice(0,80).map(async (asset) => {
      const path = String(asset.path).replace(/^[/\\.]+/,'');
      if (asset.content) { files[path] = new TextEncoder().encode(asset.content); return; }
      try { const response = await fetch(`${base}/${path.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(version)}`); if (response.ok) files[path] = new Uint8Array(await response.arrayBuffer()); } catch {}
    }));
    if (!Object.keys(files).length) throw new Error('The revision did not expose any files');
    return files;
  }
  async function commit(files, payload, revision, settings, target) {
    const base = repoPath(target.owner, target.repo), branch = encodeURIComponent(target.branch);
    await debugLog('git.bootstrap.start', { owner:target.owner, repo:target.repo, branch:target.branch, emptyRepository:Boolean(target.empty), fileCount:Object.keys(files).length });
    let parentSha = null;
    let branchExists = false;
    if (!target.empty) try { parentSha = (await gh(`${base}/git/ref/heads/${branch}`, settings.token)).object?.sha || null; branchExists = Boolean(parentSha); } catch (error) {
      if (!/not found|empty/i.test(error.message) && error.status !== 409) throw error;
      if (target.branch !== (target.defaultBranch || 'main')) { try { parentSha = (await gh(`${base}/git/ref/heads/${encodeURIComponent(target.defaultBranch || 'main')}`, settings.token)).object?.sha || null; } catch (fallback) { if (!/not found|empty/i.test(fallback.message) && fallback.status !== 409) throw fallback; } }
    }
    const parent = parentSha ? await gh(`${base}/git/commits/${parentSha}`, settings.token) : null;
    const entries = await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({ path, mode:'100644', type:'blob', sha:(await gh(`${base}/git/blobs`, settings.token, { method:'POST', body:JSON.stringify({ content:b64(bytes), encoding:'base64' }), headers:{'Content-Type':'application/json'} })).sha })));
    const tree = await gh(`${base}/git/trees`, settings.token, { method:'POST', body:JSON.stringify({ base_tree:parent?.tree?.sha, tree:entries }), headers:{'Content-Type':'application/json'} });
    await debugLog('git.tree.created', { owner:target.owner, repo:target.repo, treeSha:tree.sha, parentSha:parentSha || null });
    const version = revision.version ?? revision.revision_number ?? '?', title = String(payload.title || revision.title || payload.projectId || 'Websim project').replace(/[\r\n]+/g,' ').slice(0,120);
    const created = await gh(`${base}/git/commits`, settings.token, { method:'POST', body:JSON.stringify({ message:`v${version}: ${title}`, tree:tree.sha, ...(parentSha ? { parents:[parentSha] } : {}) }), headers:{'Content-Type':'application/json'} });
    await debugLog('git.commit.created', { owner:target.owner, repo:target.repo, branch:target.branch, commitSha:created.sha, parentSha:parentSha || null });
    if (parentSha && branchExists) await gh(`${base}/git/refs/heads/${branch}`, settings.token, { method:'PATCH', body:JSON.stringify({ sha:created.sha, force:false }), headers:{'Content-Type':'application/json'} });
    else await gh(`${base}/git/refs`, settings.token, { method:'POST', body:JSON.stringify({ ref:`refs/heads/${target.branch}`, sha:created.sha }), headers:{'Content-Type':'application/json'} });
    await debugLog('git.branch.ready', { owner:target.owner, repo:target.repo, branch:target.branch, commitSha:created.sha });
    return { sha:created.sha, version, title, url:created.html_url || `https://github.com/${target.owner}/${target.repo}/commit/${created.sha}` };
  }
  async function sync(payload, tabId) {
    const settings = await config(); await debugLog('sync.request.received', { tabId:tabId || null, projectId:payload?.projectId || null, url:payload?.url ? String(payload.url).split(/[?#]/)[0] : null, title:payload?.title || null }); if (!settings.enabled) { await debugLog('sync.blocked', { reason:'auto-sync-disabled' }); throw new Error('Auto-sync is paused in the extension popup'); } if (!settings.token) { await debugLog('sync.blocked', { reason:'github-token-missing' }); throw new Error('Open the extension popup and finish GitHub setup'); }
    let stage = 'resolve-project'; await debugLog('sync.start', { projectId:payload?.projectId || null, url:payload?.url || null, title:payload?.title || null });
    let projectId = null;
    try {
      projectId = await resolveProjectId(payload); if (!projectId) throw new Error('Could not identify the pinned project');
      if (syncInFlight.has(projectId)) { await debugLog('sync.skipped-in-flight', { projectId }); return { ok:true, inProgress:true, message:'A sync for this project is already in progress' }; }
      syncInFlight.add(projectId);
      stage = 'fetch-current-revision';
      const { version, revision } = await currentRevision(projectId); await debugLog('websim.revision.selected', { projectId, version });
      stage = 'resolve-or-create-repository';
      const target = await ensureRepository({ ...payload, projectId }, revision, settings), key = `${target.owner}/${target.repo}:${projectId}:${target.branch}`;
      if (String(settings.syncedVersions?.[key]) === String(version)) { await debugLog('sync.skipped-duplicate', { projectId, version, owner:target.owner, repo:target.repo, branch:target.branch }); return { ok:true, message:`v${version} is already in ${target.owner}/${target.repo}` }; }
      stage = 'fetch-revision-files'; const files = await filesFor(projectId, version, revision);
      stage = 'create-github-commit'; const result = await commit(files, { ...payload, projectId }, revision, settings, target), stored = await config();
      await storageSet({ owner:target.owner, projectMap:{ ...(stored.projectMap || {}), [projectId]:{ repo:target.repo, branch:target.branch } }, lastEvents:[{ title:result.title, version:result.version, projectId, repo:target.repo, branch:target.branch, sha:result.sha, url:result.url, at:Date.now() }, ...(stored.lastEvents || [])].slice(0,12), syncedVersions:{ ...(stored.syncedVersions || {}), [key]:result.version } });
      await debugLog('sync.complete', { projectId, version, owner:target.owner, repo:target.repo, branch:target.branch, commitSha:result.sha });
      return { ok:true, message:`${target.created ? 'Created repo and committed' : 'Committed'} v${result.version} to ${target.owner}/${target.repo} · ${target.branch}`, commit:result };
    } catch (error) { await debugLog('sync.failed', { stage, status:error.status || null, message:error.message }); throw error; }
    finally { if (projectId) syncInFlight.delete(projectId); }
  }
  async function triggerAutoSync(details, mutation, body) { const tabId=Number.isInteger(details.tabId) && details.tabId >= 0 ? details.tabId : null; await debugLog('pin.candidate.response', { tabId, projectId:mutation.projectId, status:details.statusCode, body }); if (details.statusCode < 200 || details.statusCode >= 300) return; await new Promise((resolve) => setTimeout(resolve,350)); let tab=null; if (tabId !== null) { try { tab=await api.tabs.get(tabId); } catch {} } const payload={ projectId:mutation.projectId, url:tab?.url || details.documentUrl || `https://websim.com/p/${mutation.projectId}`, title:null }; await debugLog('pin.autosync.trigger', { tabId, ...payload }); setSyncIndicator(true); if (tabId !== null) api.tabs.sendMessage(tabId, { type:'SYNC_STARTED', source:'project-patch' }).catch(() => {}); sync(payload,tabId).then((result) => notify(tabId,result)).catch((error) => notify(tabId,{ ok:false, message:error.message })); }
  function notify(tabId, result) { if (!result.inProgress) setSyncIndicator(false); if (Number.isInteger(tabId) && tabId >= 0) api.tabs.sendMessage(tabId, { type:'SYNC_RESULT', ...result }).catch(() => {}); if (result.ok && api.notifications) api.notifications.create(`pin-${Date.now()}`, { type:'basic', title:'Pin to GitHub', message:result.message, iconUrl:api.runtime.getURL('icon-128.png') }).catch(() => {}); }
  if (api.webRequest?.onBeforeRequest) {
    const requestFilter = { urls:['https://websim.com/*','https://*.websim.com/*'] };
    try {
      api.webRequest.onBeforeRequest.addListener((details) => { const url=websimNetworkUrl(details.url); if (!url) return; const mutation=details.method === 'PATCH' ? projectMutation(details.url) : null, body=requestBodySummary(details.requestBody); if (mutation) { trackedWebsimRequests.set(details.requestId, { mutation, body, tabId:details.tabId }); debugLog('pin.candidate.request', { tabId:details.tabId, projectId:mutation.projectId, method:details.method, body }); } config().then((state) => state.advancedLogs && debugLog('network.request', { requestId:details.requestId, method:details.method, type:details.type, url, ...(mutation ? { projectId:mutation.projectId, body } : {}) })); }, requestFilter, ['requestBody']);
      api.webRequest.onCompleted?.addListener((details) => { const url=websimNetworkUrl(details.url); if (!url) return; const tracked=trackedWebsimRequests.get(details.requestId); if (tracked) { trackedWebsimRequests.delete(details.requestId); triggerAutoSync(details, tracked.mutation, tracked.body).catch((error) => debugLog('pin.autosync.failed', { tabId:details.tabId, projectId:tracked.mutation.projectId, message:error.message })); } config().then((state) => state.advancedLogs && debugLog('network.response', { requestId:details.requestId, status:details.statusCode, type:details.type, url })); }, requestFilter);
      api.webRequest.onErrorOccurred?.addListener((details) => { const url=websimNetworkUrl(details.url); if (!url) return; const tracked=trackedWebsimRequests.get(details.requestId); if (tracked) { trackedWebsimRequests.delete(details.requestId); debugLog('pin.candidate.failed', { tabId:details.tabId, projectId:tracked.mutation.projectId, error:details.error, body:tracked.body }); } config().then((state) => state.advancedLogs && debugLog('network.error', { requestId:details.requestId, error:details.error, type:details.type, url })); }, requestFilter);
      debugLog('network.monitor.ready', { watches:['PATCH /api/v1/projects/{id}', 'Websim API requests'] });
    } catch (error) { debugLog('network.monitor.unavailable', { message:error.message }); }
  }
  async function projectLink(payload) { const settings=await config(); if (!settings.token) return { ok:true, status:'not-configured' }; const projectId=await resolveProjectId(payload); if (!projectId) return { ok:true, status:'not-websim' }; const mapped=settings.projectMap?.[projectId], user=await gh('/user', settings.token), generatedName=generatedRepoName(projectId, payload?.title), names=[...new Set([mapped?.repo, generatedName].filter(Boolean))], repository=await findExistingRepository(user.login, settings.token, projectId, names), repo=repository?.name || generatedName, mappedRepository=mapped?.repo && repo.toLowerCase() === String(mapped.repo).toLowerCase(), branch=mappedRepository && mapped.branch ? mapped.branch : branchName(settings, repository || {}); await debugLog('repository.link.preview', { projectId, owner:user.login, repo, branch, status:repository ? 'linked' : 'planned' }); return { ok:true, status:repository ? 'linked' : 'planned', projectId, owner:user.login, repo, branch, url:`https://github.com/${user.login}/${repo}` }; }
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_STATE') { config().then((state) => sendResponse({ ...state, token:'', hasToken:Boolean(state.token) })); return true; }
    if (message?.type === 'GET_LOGS') { config().then((state) => sendResponse({ logs:state.debugLogs || [] })); return true; }
    if (message?.type === 'GET_PROJECT_LINK') { projectLink(message).then(sendResponse).catch((error) => sendResponse({ ok:false, message:error.message })); return true; }
    if (message?.type === 'CLEAR_LOGS') { storageSet({ debugLogs:[] }).then(() => sendResponse({ok:true})); return true; }
    if (message?.type === 'SET_DEBUG_MODE') { storageSet({ advancedLogs:Boolean(message.enabled) }).then(() => sendResponse({ ok:true, advancedLogs:Boolean(message.enabled) })); return true; }
    if (message?.type === 'DEBUG_EVENT') { config().then((stored) => { if (!stored.advancedLogs) return sendResponse({ ok:true, recorded:false }); debugLog(message.event || 'content.debug', safeDebugDetail(message.detail)).then(() => sendResponse({ ok:true, recorded:true })); }); return true; }
    if (message?.type === 'SAVE_SETTINGS') { config().then((state) => storageSet({ ...state, ...message.settings, token:message.settings.token || state.token })).then(async () => { const saved = await config(); let owner = saved.owner || ''; if (saved.token) { const user = await gh('/user', saved.token); owner = user.login; await storageSet({ owner }); } sendResponse({ ok:true, owner }); }).catch((error) => sendResponse({ ok:false, message:error.message })); return true; }
    if (message?.type === 'PIN_DETECTED') { debugLog('pin.message.received', { tabId:sender.tab?.id || null, senderUrl:sender.url ? String(sender.url).split(/[?#]/)[0] : null, payload:safeDebugDetail(message.payload || {}) }); setSyncIndicator(true); sync(message.payload, sender.tab?.id).then((result) => { notify(sender.tab?.id,result); sendResponse(result); }).catch((error) => { const result={ok:false,message:error.message}; notify(sender.tab?.id,result); sendResponse(result); }); return true; }
    if (message?.type === 'SYNC_CURRENT') { const url=message.url || '', id=url.match(/\/(?:c|p)\/([a-zA-Z0-9_-]+)/)?.[1] || url.match(/^https:\/\/([a-zA-Z0-9_-]+)\.c\.websim\.com/)?.[1]; setSyncIndicator(true); sync({ projectId:id, url, title:message.title }, message.tabId).then((result) => { notify(message.tabId,result); sendResponse(result); }).catch((error) => { const result={ok:false,message:error.message}; notify(message.tabId,result); sendResponse(result); }); return true; }
  });
  api.runtime.onInstalled?.addListener(() => storageGet(defaults).then((stored) => storageSet({ ...defaults, ...stored })));
})();
