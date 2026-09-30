// Files the OS or a drop hands the app may include a project (.phyto). A
// project is OPENED (it replaces the scene), never imported, so it is split
// off before the importer sees the rest.

import { isProjectPath } from '@shared/constants';

export interface ProjectPathSplit {
  /** The project to open, if any (the first, when several were given). */
  project: string | null;
  /** Everything else, for the importer. Empty when a project is opened:
   *  the open replaces the scene, so importing first would be thrown away. */
  imports: string[];
  /** Files set aside because a project is being opened instead. */
  skipped: string[];
}

export function splitProjectPaths(paths: readonly string[]): ProjectPathSplit {
  const projects = paths.filter(isProjectPath);
  if (projects.length === 0) return { project: null, imports: [...paths], skipped: [] };
  return { project: projects[0], imports: [], skipped: paths.filter((p) => p !== projects[0]) };
}
