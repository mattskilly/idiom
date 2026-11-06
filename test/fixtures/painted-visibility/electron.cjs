// Exit with the test process that launched this fixture (test/support/fixture-lifeline.cjs).
if (process.env.FIXTURE_LIFELINE) require(process.env.FIXTURE_LIFELINE);
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false });
  window.loadFile(join(__dirname, "entrance.html"));
});
app.on("window-all-closed", () => app.quit());
