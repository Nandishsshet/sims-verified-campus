// Apply the saved theme before first paint (no flash). This is a separate file, not an inline <script>,
// because the production Content-Security-Policy only allows scripts from our own origin.
try {
  var t = localStorage.getItem('sims-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) { /* storage blocked: fall back to the light theme */ }
