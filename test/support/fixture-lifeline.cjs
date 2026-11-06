// Preloaded into every test-started fixture server (`node --require`): the
// fixture exits when the test process that owns it is gone, even when that
// process was killed before its afterAll could stop the fixture.
//
// FIXTURE_OWNER_PID=<pid>   exit once that pid no longer exists
// FIXTURE_STDIN_LIFELINE=1  exit as soon as stdin closes (a direct spawn's pipe)
const installed = Symbol.for("idiom.fixtureLifeline");
if (!globalThis[installed]) {
  globalThis[installed] = true;
  const owner = Number(process.env.FIXTURE_OWNER_PID);
  if (Number.isInteger(owner) && owner > 0) {
    const timer = setInterval(() => {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === "ESRCH") process.exit(0);
      }
    }, 200);
    timer.unref();
  }
  if (process.env.FIXTURE_STDIN_LIFELINE === "1") {
    const exit = () => process.exit(0);
    process.stdin.on("end", exit);
    process.stdin.on("close", exit);
    process.stdin.on("error", exit);
    process.stdin.resume();
    process.stdin.unref?.();
  }
}
