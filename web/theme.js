// Theme: system / light / dark. Persists in localStorage, applies data-theme on <html>.
(function () {
  const STORAGE_KEY = "ccglass-theme";
  const MODES = ["system", "light", "dark"];

  function getStoredTheme() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (MODES.includes(v)) return v;
    } catch {}
    return "system";
  }

  function setStoredTheme(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {}
  }

  function resolvedTheme(mode) {
    if (mode === "light" || mode === "dark") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(mode) {
    const resolved = resolvedTheme(mode);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    return resolved;
  }

  function initTheme(onChange) {
    let mode = getStoredTheme();
    applyTheme(mode);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      if (mode !== "system") return;
      const resolved = applyTheme("system");
      onChange?.(mode, resolved);
    });

    return {
      getMode: () => mode,
      setMode(next) {
        if (!MODES.includes(next)) return;
        mode = next;
        setStoredTheme(mode);
        const resolved = applyTheme(mode);
        onChange?.(mode, resolved);
      },
    };
  }

  window.ccglassTheme = { initTheme, applyTheme, getStoredTheme, MODES };
  applyTheme(getStoredTheme());
})();
