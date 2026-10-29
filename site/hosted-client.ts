import { initBotId } from "botid/client/core";

async function start() {
  const section = document.querySelector<HTMLElement>("#hosted-review");
  const config = await fetch("/api/hosted-config", { cache: "no-store" })
    .then((r) => r.json())
    .catch(() => ({ enabled: false }));
  if (!section || config.enabled !== true) return;
  initBotId({ protect: [{ path: "/api/hosted-review", method: "POST" }] });
  section.hidden = false;
  const form = document.querySelector<HTMLFormElement>("#hosted-form");
  const kind = document.querySelector<HTMLSelectElement>("#hosted-design-kind");
  const progress = document.querySelector<HTMLElement>("#hosted-progress");
  const submit = document.querySelector<HTMLButtonElement>("#hosted-submit");
  const result = document.querySelector<HTMLElement>("#hosted-result");
  const link = document.querySelector<HTMLAnchorElement>("#hosted-report-link");
  if (!form || !kind || !progress || !submit || !result || !link) return;
  if (config.available === false) {
    // Same wording as the server's failure envelope for the same condition.
    progress.textContent =
      config.reason === "cap-reached"
        ? "The hosted review budget has been reached. Run locally: npm install -g @mattskilly/idiom"
        : "Hosted review is temporarily unavailable. Run locally: npm install -g @mattskilly/idiom";
    submit.disabled = true;
    return;
  }
  kind.addEventListener("change", () => {
    for (const name of ["image", "reference"]) {
      const fields = document.querySelector<HTMLElement>(
        `#hosted-${name}-fields`,
      );
      const input = document.querySelector<HTMLInputElement>(`#hosted-${name}`);
      if (fields && input) {
        fields.hidden = kind.value !== name;
        input.disabled = fields.hidden;
        if (input.disabled) input.value = "";
      }
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    for (const name of ["target", "reference", "image"]) {
      document
        .querySelector(`#hosted-${name}`)
        ?.removeAttribute("aria-invalid");
      const error = document.querySelector(`#hosted-${name}-error`);
      if (error) error.textContent = "";
    }
    const image =
      document.querySelector<HTMLInputElement>("#hosted-image")?.files?.[0];
    if (kind.value === "image" && image && image.size > 2 * 1024 * 1024) {
      progress.textContent = "Choose an image up to 2 MiB.";
      return;
    }
    submit.disabled = true;
    result.hidden = true;
    progress.textContent = "Validating your request…";
    let completed = false;
    const receive = (entry: {
      type?: string;
      message?: string;
      field?: string;
      id?: string;
      deleteToken?: string;
      url?: string;
    }) => {
      if (entry.type === "error") {
        progress.textContent =
          entry.message ?? "The review failed. Please try again.";
        if (["target", "reference", "image"].includes(entry.field ?? "")) {
          const input = document.querySelector<HTMLInputElement>(
            `#hosted-${entry.field}`,
          );
          const error = document.querySelector(`#hosted-${entry.field}-error`);
          if (input && error) {
            input.setAttribute("aria-invalid", "true");
            error.textContent = progress.textContent;
            input.focus();
          }
        }
        completed = true;
      } else if (entry.type === "progress")
        progress.textContent = entry.message ?? "Review in progress.";
      else if (
        entry.type === "result" &&
        entry.id &&
        /^[a-f0-9]{64}$/.test(entry.id) &&
        entry.deleteToken &&
        /^[a-f0-9]{64}$/.test(entry.deleteToken)
      ) {
        const path = `/r/${entry.id}`;
        try {
          localStorage.setItem(`idiom-delete:${entry.id}`, entry.deleteToken);
        } catch {
          /* fragment is an equivalent creator capability */
        }
        link.href = `${path}#delete=${entry.deleteToken}`;
        link.dataset.shareUrl = new URL(path, location.origin).href;
        result.hidden = false;
        progress.textContent =
          "Report ready. The share link excludes your deletion key.";
        completed = true;
      }
    };
    try {
      const response = await fetch("/api/hosted-review", {
        method: "POST",
        body: new FormData(form),
      });
      if (!response.ok) {
        receive(await response.json());
        return;
      }
      if (!response.body) throw new Error("missing stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const next = await reader.read();
        pending += decoder.decode(next.value, { stream: !next.done });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) receive(JSON.parse(line));
        if (next.done) {
          if (pending.trim()) receive(JSON.parse(pending));
          break;
        }
      }
      if (!completed) throw new Error("incomplete stream");
    } catch {
      progress.textContent =
        "The connection ended before a complete report arrived. Please try again; an admitted attempt still counts toward today's limit.";
    } finally {
      submit.disabled = false;
    }
  });
  document
    .querySelector("#hosted-copy-link")
    ?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(link.dataset.shareUrl ?? "");
        progress.textContent = "Share link copied.";
      } catch {
        progress.textContent = `Share link: ${link.dataset.shareUrl ?? ""}`;
      }
    });
}
void start();
