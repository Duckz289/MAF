import { recordProjectRename } from "../projections/project-stats-projection.mjs";

export function handleProjectUpdated(payload) {
  recordProjectRename(payload.projectId, payload.newName);
}
