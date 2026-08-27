(() => {
  function remixSessionUser(runtimeUser) {
    const root = window.__remixContext?.state?.loaderData?.root;
    const auth = root?.authUser;
    const profile = root?.user;
    const user = {
      id: auth?.id ?? profile?.id ?? runtimeUser?.id,
      email: auth?.email ?? runtimeUser?.email,
      username: profile?.username ?? runtimeUser?.username,
      avatar_url: profile?.avatar_url ?? runtimeUser?.avatar_url
    };
    return user.id || user.username ? user : null;
  }

  const report = async () => {
    try {
      const websim = window.websim;
      const [runtimeUser, project] = await Promise.all([
        websim?.getUser ? websim.getUser() : null,
        websim?.getCurrentProject ? websim.getCurrentProject().catch(() => null) : null
      ]);
      const user = remixSessionUser(runtimeUser);
      window.postMessage({
        source: 'pin-to-github',
        type: 'WEBSIM_SESSION',
        user: user ? { id: user.id, username: user.username } : null,
        projectId: project?.id || null,
        url: location.href
      }, location.origin);
      return Boolean(user);
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
