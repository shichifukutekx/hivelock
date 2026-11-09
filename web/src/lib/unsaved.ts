import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

/** Asks before leaving a page with unsaved work, by link, by the back button, or by closing the tab. */
export function useUnsavedWarning(dirty: boolean, message = "You have unsaved changes. Leave without saving?") {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
}
