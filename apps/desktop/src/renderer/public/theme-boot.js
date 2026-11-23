// Runs before the first paint (a classic script in <head>). index.html already says
// data-theme="dark"; this switches to light only if the operator chose it. The key
// matches THEME_STORAGE_KEY in src/theme.ts.
(function () {
  try {
    if (window.localStorage.getItem('ticket.theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch {
    // Storage unavailable: stay dark.
  }
})();
