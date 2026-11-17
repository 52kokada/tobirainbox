// Applied before first paint so the console never flashes the wrong theme. 'light' | 'dark' | unset (= follow the device).
try { const t = localStorage.getItem('tbi.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* private mode */ }
