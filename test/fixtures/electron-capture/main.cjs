const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");

void (async () => {
  const fixturePath = process.env.FIXTURE_PATH;
  if (!fixturePath) throw new Error("FIXTURE_PATH is required");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

  await app.whenReady();

  const auxiliary = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
  });
  await auxiliary.loadURL(
    `data:text/html,${encodeURIComponent(`<!doctype html><title>Electron Fixture Auxiliary</title><script>console.error("auxiliary diagnostic"); setTimeout(() => { throw new Error("auxiliary exception") }, 0)</script>`)}`,
  );

  const capture = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  await capture.loadFile(join(__dirname, "renderer.html"), {
    query: {
      person: fixture.person,
      availability: fixture.availability,
    },
  });

  app.on("window-all-closed", () => app.quit());
})();
