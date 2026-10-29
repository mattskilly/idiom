export {};

const id = document.body.dataset.reportId;
const status = document.querySelector<HTMLElement>("#report-status");
const button = document.querySelector<HTMLButtonElement>("#delete-report");
let token = new URLSearchParams(location.hash.slice(1)).get("delete");
if (id && /^[a-f0-9]{64}$/.test(id)) {
  try {
    if (token && /^[a-f0-9]{64}$/.test(token))
      localStorage.setItem(`idiom-delete:${id}`, token);
    token ??= localStorage.getItem(`idiom-delete:${id}`);
  } catch {
    /* creator fragment remains usable in memory */
  }
  history.replaceState(null, "", location.pathname);
  if (button && token && /^[a-f0-9]{64}$/.test(token)) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/hosted-delete?id=${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!response.ok) throw new Error("delete failed");
        try {
          localStorage.removeItem(`idiom-delete:${id}`);
        } catch {}
        document.querySelector("main")?.replaceChildren(
          Object.assign(document.createElement("p"), {
            textContent: "Report deleted. Its content is no longer available.",
          }),
        );
      } catch {
        if (status)
          status.textContent =
            "Deletion could not be completed. Please try again.";
        button.disabled = false;
      }
    });
  }
  document
    .querySelector("#copy-report")
    ?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`${location.origin}/r/${id}`);
        if (status) status.textContent = "Share link copied.";
      } catch {
        if (status)
          status.textContent = `Share link: ${location.origin}/r/${id}`;
      }
    });
}
