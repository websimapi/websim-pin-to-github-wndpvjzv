(() => {
  const report = async () => {
    try {
      const websim = window.websim;
      if (!websim?.getUser) return false;
      const [user, project] = await Promise.all([
        websim.getUser(),
        websim.getCurrentProject?.().catch(() => null)
      ]);
      window.postMessage({
        source: 'pin-to-github',
        type: 'WEBSIM_SESSION',
        user: user ? { id: user.id, username: user.username } : null,
        projectId: project?.id || null,
        url: location.href
      }, location.origin);
      return true;
    } catch {
      return false;
    }
  };

  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    if (await report() || attempts >= 20) clearInterval(timer);
  }, 300);
})();
