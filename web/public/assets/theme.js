// Runs before the page paints, so a saved theme never flashes the wrong colours.
(() => {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      return localStorage.getItem("hivelock-theme") ?? "system";
    } catch {
      return "system";
    }
  };
  const apply = () => {
    const choice = saved();
    document.documentElement.dataset.theme = choice === "system" ? (dark.matches ? "dark" : "light") : choice;
  };
  apply();
  dark.addEventListener("change", apply);
  addEventListener("storage", apply);
  addEventListener("hivelock-theme", apply);
})();
