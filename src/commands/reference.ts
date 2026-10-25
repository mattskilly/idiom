import { resolve } from "node:path";
import type {
  ManagedReference,
  ReferencePolarity,
} from "../references/catalog.js";
import {
  addReference,
  listManagedReferences,
  type ReferenceDependencies,
  type RemovedReference,
  removeReference,
} from "../references/run.js";
import { validateProjectConfiguration } from "../validation.js";

function polarity(anti: boolean | undefined): ReferencePolarity {
  return anti === true ? "anti-reference" : "reference";
}

export async function addReferenceCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  name: string;
  note: string;
  url?: string | undefined;
  file?: string | undefined;
  viewport?: string | undefined;
  anti?: boolean | undefined;
  dependencies?: ReferenceDependencies | undefined;
}): Promise<ManagedReference> {
  const validated = await validateProjectConfiguration(options);
  return await addReference({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    cwd: resolve(options.cwd ?? process.cwd()),
    name: options.name,
    note: options.note,
    url: options.url,
    file: options.file,
    viewport: options.viewport,
    polarity: polarity(options.anti),
    dependencies: options.dependencies,
  });
}

export async function listReferencesCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
}): Promise<ManagedReference[]> {
  const validated = await validateProjectConfiguration(options);
  return await listManagedReferences(validated.projectDirectory);
}

export async function removeReferenceCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  name: string;
  anti?: boolean | undefined;
}): Promise<RemovedReference> {
  const validated = await validateProjectConfiguration(options);
  return await removeReference({
    projectDirectory: validated.projectDirectory,
    name: options.name,
    polarity: polarity(options.anti),
  });
}
