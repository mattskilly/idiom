import { readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productionFixture } from "./production-support.js";

export async function productFixture(directories: string[]) {
  const { directory, project } = await productionFixture();
  directories.push(directory);
  for (const name of await readdir(join(directory, ".idiom/flows")))
    await unlink(join(directory, ".idiom/flows", name));
  project.server.start = `node '${join(import.meta.dirname, "fixtures/sweep-all/server.mjs")}'`;
  project.capture.settleMs = 0;
  project.viewports = [
    { name: "desktop", width: 800, height: 600 },
    { name: "mobile", width: 360, height: 640 },
  ];
  project.model.maxFindings = 1;
  await writeFile(
    join(directory, ".idiom/project.json"),
    JSON.stringify(project),
  );
  for (const id of ["alpha", "beta"])
    await writeFile(
      join(directory, ".idiom/flows", `${id}.json`),
      JSON.stringify({
        id,
        title: id,
        setup: [],
        intent: [],
        viewports: id === "alpha" ? ["desktop", "mobile"] : ["desktop"],
        states: [{ id: "home", description: "Home", url: "/", expect: {} }],
      }),
    );
  return directory;
}
