const projects = new Map();

export const projectRepository = {
  save(project) {
    projects.set(project.id, project);
    return project;
  },
  get(id) {
    return projects.get(id) ?? null;
  },
  all() {
    return Array.from(projects.values());
  },
};
