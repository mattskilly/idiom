(() => {
  let fired = false;
  const log = (reason) => console.log(`idiom-probe-observed ${reason}`);
  const react = (reason) => {
    if (fired) return;
    fired = true;
    observer.disconnect();
    log(reason);
    const overlay = document.createElement("div");
    overlay.id = "reaction";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgb(255,0,0)";
    document.documentElement.append(overlay);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList" && record.target === document.body) {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.some((n) => n.nodeName === "SPAN" || n.nodeName === "DIV"))
          return react("body-child");
      }
      if (
        record.type === "attributes" &&
        record.target === document.documentElement &&
        record.attributeName === "style"
      )
        return react("root-style");
    }
  });
  const start = () => {
    observer.observe(document.body, { childList: true });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
  };
  for (const type of ["blur", "focus"])
    window.addEventListener(type, () => log(type));
  document.addEventListener("visibilitychange", () => log("visibilitychange"));
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
