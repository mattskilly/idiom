const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false });
  window.loadFile(join(__dirname, "entrance.html"));
});
app.on("window-all-closed", () => app.quit());
