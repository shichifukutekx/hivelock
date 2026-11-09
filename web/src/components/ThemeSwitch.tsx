import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

/** What the page shows now. Before anyone chooses, that follows the device; after, the choice is kept. */
const current = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

/** One switch between light and dark. Collapsed, it is a single button that shows what a press changes to. */
export function ThemeSwitch({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const follow = () => setTheme(current());
    addEventListener("hivelock-theme", follow);
    addEventListener("storage", follow);
    return () => { removeEventListener("hivelock-theme", follow); removeEventListener("storage", follow); };
  }, []);
  const dark = theme === "dark";
  const flip = () => {
    const next = dark ? "light" : "dark";
    try { localStorage.setItem("hivelock-theme", next); } catch {}
    // theme.js applies it; this event also tells other switches on the page.
    dispatchEvent(new Event("hivelock-theme"));
    setTheme(next);
  };

  if (compact) {
    return (
      <button type="button" onClick={flip} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        className="press flex h-8 w-full items-center justify-center rounded-lg text-rail-ink hover:bg-rail-active hover:text-white">
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
    );
  }
  return (
    <button type="button" role="switch" aria-checked={dark} onClick={flip}
      className="press group mb-1 flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-rail-ink hover:bg-rail-active hover:text-white">
      {dark ? <Moon size={15} className="shrink-0" /> : <Sun size={15} className="shrink-0" />}
      <span className="flex-1 text-left">Dark mode</span>
      <span aria-hidden="true" className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200 ${dark ? "bg-honey" : "bg-white/20"}`}>
        <span className={`absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ${dark ? "translate-x-3.5" : ""}`} />
      </span>
    </button>
  );
}
