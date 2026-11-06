#!/usr/bin/env node

// src/node-version.ts
var MINIMUM_NODE_MAJOR = 22;
var MINIMUM_NODE_MINOR = 12;
var MINIMUM_NODE = `${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}`;
var NODE_UPGRADE_HINT = `Install Node ${MINIMUM_NODE}+ (https://nodejs.org) and run again.`;
function nodeVersionProblem(version) {
  const parsed = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (parsed === null) return void 0;
  const major = Number(parsed[1]);
  if (major > MINIMUM_NODE_MAJOR) return void 0;
  if (major === MINIMUM_NODE_MAJOR && (parsed[2] === void 0 || Number(parsed[2]) >= MINIMUM_NODE_MINOR))
    return void 0;
  return `Idiom needs Node ${MINIMUM_NODE} or newer; this is Node ${version}. ${NODE_UPGRADE_HINT}`;
}

// src/entry.ts
var problem = nodeVersionProblem(process.versions.node);
if (problem !== void 0) {
  process.stderr.write(`${problem}
`);
  process.exitCode = 2;
} else {
  const main = await import(new URL("./main.js", import.meta.url).href);
  process.exitCode = await main.run();
}
