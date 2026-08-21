import { FluentProvider } from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "./components/AppShell";
import { LoadingState } from "./components/LoadingState";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { DecisionsPage } from "./pages/DecisionsPage";
import { EvaluationPage } from "./pages/EvaluationPage";
import { HomePage } from "./pages/HomePage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsagePage } from "./pages/UsagePage";
import { mafDarkTheme } from "./theme";
import type { Agent, Connection, DecisionItem, HomeData, Project, Run } from "./types";
import { readJson } from "./utils";

export function App() {
  const [location, setLocation] = useState(
    () => `${window.location.pathname}${window.location.search}`,
  );
  const [runs, setRuns] = useState<Run[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [home, setHome] = useState<HomeData>();
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [technicalError, setTechnicalError] = useState<string>();
  const url = useMemo(() => new URL(location, window.location.origin), [location]);
  const path = url.pathname;

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    window.scrollTo({ top: 0, left: 0 });
    setLocation(`${window.location.pathname}${window.location.search}`);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextRuns, nextProjects, nextConnections, nextAgents, nextHome, nextDecisions] =
        await Promise.all([
          readJson<Run[]>("/api/v1/runs"),
          readJson<{ projects: Project[] }>("/api/v1/projects"),
          readJson<Connection[]>("/api/v1/connections"),
          readJson<Agent[]>("/api/v1/agents"),
          readJson<HomeData>("/api/v1/home"),
          readJson<DecisionItem[]>("/api/v1/decisions").catch(() => []),
        ]);
      setRuns(nextRuns);
      setProjects(nextProjects.projects);
      setConnections(nextConnections);
      setAgents(nextAgents);
      setHome(nextHome);
      setDecisions(nextDecisions);
      setTechnicalError(undefined);
    } catch (error) {
      setTechnicalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onPopState = () => setLocation(`${window.location.pathname}${window.location.search}`);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [refresh]);

  const hasActiveWork = runs.some((run) => run.state === "RUNNING" || run.state === "QUEUED");
  useEffect(() => {
    if (!hasActiveWork) return undefined;
    const timer = window.setInterval(() => void refresh(), 8_000);
    return () => window.clearInterval(timer);
  }, [hasActiveWork, refresh]);

  const selectedRunId = path.match(/^\/runs\/([^/]+)$/)?.[1];
  const selectedProjectId = path.match(/^\/projects\/([^/]+)$/)?.[1];
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const requestedProject = projects.find(
    (project) => project.id === url.searchParams.get("project"),
  );
  const runProject = selectedRun
    ? projects.find((project) => project.repositoryPath === selectedRun.repositoryPath)
    : undefined;
  const contextProject = selectedProject ?? requestedProject ?? runProject;

  useEffect(() => {
    if (!selectedRun || selectedRun.state !== "RUNNING") return undefined;
    const stream = new EventSource(`/api/v1/runs/${selectedRun.id}/events`);
    stream.onmessage = () => void refresh();
    stream.addEventListener("RunCompleted", () => void refresh());
    stream.addEventListener("RunFailed", () => void refresh());
    return () => stream.close();
  }, [refresh, selectedRun]);

  let content: React.ReactNode;
  if (loading) {
    content = <LoadingState />;
  } else if (path === "/projects") {
    content = (
      <ProjectsPage navigate={navigate} projects={projects} refresh={refresh} runs={runs} />
    );
  } else if (selectedProjectId) {
    content = <ProjectPage navigate={navigate} project={selectedProject} runs={runs} />;
  } else if (path === "/runs/new") {
    content = (
      <NewTaskPage
        agents={agents}
        defaultProjectId={requestedProject?.id}
        navigate={navigate}
        projects={projects}
        refresh={refresh}
      />
    );
  } else if (path === "/runs") {
    content = <RunsPage navigate={navigate} runs={runs} />;
  } else if (selectedRunId) {
    content = <RunPage navigate={navigate} refresh={refresh} run={selectedRun} />;
  } else if (path === "/decisions") {
    content = <DecisionsPage navigate={navigate} />;
  } else if (path === "/evaluation") {
    content = <EvaluationPage projects={projects} runs={runs} />;
  } else if (path === "/connections") {
    content = (
      <ConnectionsPage
        agents={agents}
        connections={connections}
        navigate={navigate}
        projects={projects}
        refresh={refresh}
      />
    );
  } else if (path === "/usage") {
    content = <UsagePage projects={projects} runs={runs} />;
  } else if (path === "/settings") {
    content = <SettingsPage agents={agents} />;
  } else {
    content = (
      <HomePage
        agents={agents}
        decisions={decisions}
        home={home}
        navigate={navigate}
        projects={projects}
        runs={runs}
      />
    );
  }

  return (
    <FluentProvider theme={mafDarkTheme}>
      <AppShell
        contextProject={contextProject}
        decisionCount={decisions.length}
        navigate={navigate}
        path={path}
        technicalError={technicalError}
      >
        {content}
      </AppShell>
    </FluentProvider>
  );
}
