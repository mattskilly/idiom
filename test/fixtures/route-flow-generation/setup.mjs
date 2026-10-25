// Run from the fixture project root, before starting its capture server.
import { writeFileSync } from "node:fs";

writeFileSync(".fixture-auth", "enabled\n");
