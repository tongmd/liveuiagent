(() => {
  // Preserve legacy storage and app bridges while the public product moves to /liveui/.
  const base = /^\/liveui(?:\/|$)/.test(location.pathname) ? '/liveui' : '';
  window.__liveuiPath = path => {
    const value = String(path);
    return base && value.startsWith('/') && !value.startsWith('//')
      && value !== base && !value.startsWith(base + '/') ? base + value : value;
  };
  window.addEventListener('liveui:settings', event => {
    if (typeof window.__liveuiApplySettings === 'function') window.__liveuiApplySettings(event.detail);
  });
})();
