/**
 * Resolves when the document is visible (or after `maxMs`). A PWA that was backgrounded (screen lock, camera,
 * app switch) must not fire its recovery request while the OS has the network suspended: the request would fail
 * for the same reason the first one did.
 */
export function waitUntilPageVisible(maxMs = 15000): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState !== "hidden") finish();
    };
    const timer = setTimeout(finish, maxMs);
    document.addEventListener("visibilitychange", onChange);
  });
}
