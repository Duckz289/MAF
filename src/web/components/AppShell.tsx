import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  mergeClasses,
  Text,
  tokens,
} from "@fluentui/react-components";
import {
  Add20Regular,
  BookOpen20Regular,
  BranchFork20Regular,
  DataUsage20Regular,
  Folder20Regular,
  Home20Regular,
  Important20Regular,
  Person20Regular,
  PlugDisconnected20Regular,
  ScaleFill20Regular,
  Settings20Regular,
  TaskListSquareLtr20Regular,
  TasksApp20Regular,
} from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { isNavigationSelected } from "../presentation";
import type { Navigate, Project } from "../types";

const useStyles = makeStyles({
  shell: {
    minHeight: "100dvh",
    backgroundColor: "#0c0d0e",
    color: "#f3f5f7",
  },
  layout: {
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    minHeight: "100dvh",
    "@media (max-width: 1040px)": { gridTemplateColumns: "76px minmax(0, 1fr)" },
    "@media (max-width: 700px)": { display: "block" },
  },
  sidebar: {
    position: "sticky",
    top: 0,
    alignSelf: "start",
    zIndex: 2,
    height: "100dvh",
    padding: "18px 12px 14px",
    borderRight: "1px solid #22272c",
    backgroundColor: "#0f1113",
    display: "flex",
    flexDirection: "column",
    gap: "22px",
    "@media (max-width: 700px)": {
      position: "static",
      height: "auto",
      padding: "10px 12px",
      borderRight: 0,
      borderBottom: "1px solid #22272c",
      gap: "10px",
    },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minHeight: "38px",
    padding: "0 8px",
  },
  brandMark: {
    width: "30px",
    height: "30px",
    borderRadius: "8px",
    backgroundColor: "#3979d9",
    color: "white",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
  },
  brandCopy: {
    minWidth: 0,
    display: "grid",
    lineHeight: 1.1,
    "@media (max-width: 1040px)": { display: "none" },
  },
  nav: {
    display: "grid",
    gap: "14px",
    "@media (max-width: 700px)": {
      display: "flex",
      overflowX: "auto",
      paddingBottom: "2px",
      gap: "4px",
    },
  },
  navGroup: {
    display: "grid",
    gap: "3px",
    "@media (max-width: 700px)": { display: "flex", gap: "4px" },
  },
  navGroupLabel: {
    padding: "0 10px",
    marginBottom: "2px",
    color: "#5c6670",
    letterSpacing: ".04em",
    "@media (max-width: 1040px)": { display: "none" },
  },
  navBadge: { marginLeft: "auto" },
  navButton: {
    minHeight: "38px",
    justifyContent: "flex-start",
    color: "#aeb6bf",
    fontWeight: tokens.fontWeightRegular,
    transitionProperty: "background-color, color, transform",
    transitionDuration: "160ms",
    ":hover": { color: "#f3f5f7", backgroundColor: "#171a1e" },
    "@media (max-width: 1040px)": {
      justifyContent: "center",
      minWidth: "44px",
      "> span:last-child": { display: "none" },
    },
    "@media (max-width: 700px)": {
      "> span:last-child": { display: "inline" },
      minWidth: "max-content",
      paddingInline: "12px",
    },
  },
  navSelected: {
    color: "#f7f9fb",
    backgroundColor: "#1b222b",
    boxShadow: "inset 2px 0 #5791e5",
    ":hover": { backgroundColor: "#1f2731" },
  },
  sidebarBottom: {
    marginTop: "auto",
    display: "grid",
    gap: "3px",
    "@media (max-width: 700px)": { display: "none" },
  },
  account: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginTop: "8px",
    padding: "12px 8px 2px",
    borderTop: "1px solid #22272c",
    color: "#858f9a",
  },
  accountCopy: { display: "grid", "@media (max-width: 1040px)": { display: "none" } },
  workspace: { minWidth: 0, display: "grid", gridTemplateRows: "64px minmax(0, 1fr)" },
  topbar: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    height: "64px",
    padding: "0 clamp(18px, 3vw, 38px)",
    borderBottom: "1px solid #22272c",
    backgroundColor: "rgba(12, 13, 14, .94)",
    backdropFilter: "blur(12px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "18px",
    "@media (max-width: 700px)": { position: "static", padding: "0 14px" },
  },
  context: { minWidth: 0, display: "flex", alignItems: "center", gap: "10px" },
  contextName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  contextMeta: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "#858f9a",
    "@media (max-width: 760px)": { display: "none" },
  },
  content: {
    width: "100%",
    maxWidth: "1440px",
    margin: "0 auto",
    padding: "30px clamp(20px, 3vw, 44px) 56px",
    "@media (max-width: 700px)": { padding: "22px 14px 42px" },
  },
  error: { maxWidth: "760px", marginBottom: "20px" },
});

const navigationGroups = [
  {
    label: undefined,
    items: [
      { href: "/", label: "Control Center", icon: <Home20Regular /> },
      { href: "/projects", label: "Projects", icon: <Folder20Regular /> },
      { href: "/work", label: "Work", icon: <TaskListSquareLtr20Regular /> },
      { href: "/runs", label: "Missions", icon: <TasksApp20Regular /> },
      { href: "/decisions", label: "Decisions", icon: <Important20Regular /> },
    ],
  },
  {
    label: "Inspection",
    items: [
      { href: "/evolution", label: "Evolution", icon: <ScaleFill20Regular /> },
      { href: "/evaluation", label: "Evaluation", icon: <ScaleFill20Regular /> },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/providers", label: "Providers", icon: <PlugDisconnected20Regular /> },
      { href: "/connections", label: "Connections", icon: <PlugDisconnected20Regular /> },
      { href: "/usage", label: "Usage", icon: <DataUsage20Regular /> },
    ],
  },
] as const;

export function AppShell({
  children,
  contextProject,
  decisionCount = 0,
  navigate,
  path,
  technicalError,
}: {
  children: ReactNode;
  contextProject?: Project | undefined;
  decisionCount?: number;
  navigate: Navigate;
  path: string;
  technicalError?: string | undefined;
}) {
  const styles = useStyles();
  return (
    <div className={styles.shell}>
      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="Điều hướng chính">
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              <BranchFork20Regular />
            </span>
            <span className={styles.brandCopy}>
              <Text size={400} weight="semibold">
                MAF
              </Text>
              <Text size={100} style={{ color: "#858f9a" }}>
                Engineering Control Center
              </Text>
            </span>
          </div>
          <nav className={styles.nav}>
            {navigationGroups.map((group) => (
              <div className={styles.navGroup} key={group.label ?? "primary"}>
                {group.label ? (
                  <Text className={styles.navGroupLabel} size={100}>
                    {group.label.toUpperCase()}
                  </Text>
                ) : null}
                {group.items.map((item) => (
                  <Button
                    appearance="transparent"
                    aria-current={isNavigationSelected(path, item.href) ? "page" : undefined}
                    className={mergeClasses(
                      styles.navButton,
                      isNavigationSelected(path, item.href) && styles.navSelected,
                    )}
                    icon={item.icon}
                    key={item.href}
                    onClick={() => navigate(item.href)}
                    title={item.label}
                  >
                    {item.label}
                    {item.href === "/decisions" && decisionCount > 0 ? (
                      <Badge
                        appearance="filled"
                        className={styles.navBadge}
                        color="informative"
                        size="small"
                      >
                        {decisionCount}
                      </Badge>
                    ) : null}
                  </Button>
                ))}
              </div>
            ))}
          </nav>
          <div className={styles.sidebarBottom}>
            <Button
              appearance="transparent"
              className={mergeClasses(
                styles.navButton,
                path.startsWith("/settings") && styles.navSelected,
              )}
              icon={<Settings20Regular />}
              onClick={() => navigate("/settings")}
              title="Cài đặt"
            >
              Cài đặt
            </Button>
            <Button
              appearance="transparent"
              as="a"
              className={styles.navButton}
              href="https://github.com/Duckz289/MAF"
              icon={<BookOpen20Regular />}
              target="_blank"
              title="Tài liệu"
            >
              Tài liệu
            </Button>
            <div className={styles.account}>
              <Person20Regular />
              <span className={styles.accountCopy}>
                <Text size={200}>Người dùng local</Text>
                <Text size={100}>Chế độ phát triển</Text>
              </span>
            </div>
          </div>
        </aside>
        <div className={styles.workspace}>
          <header className={styles.topbar}>
            <div className={styles.context}>
              <Text className={styles.contextName} weight="semibold">
                {contextProject?.name ?? "All projects"}
              </Text>
              {contextProject ? (
                <div className={styles.contextMeta}>
                  <Badge appearance="outline">{contextProject.revision}</Badge>
                  <Text size={200}>Kho mã local</Text>
                </div>
              ) : null}
            </div>
            {path !== "/runs/new" ? (
              <Button
                appearance="primary"
                icon={<Add20Regular />}
                onClick={() =>
                  navigate(contextProject ? `/runs/new?project=${contextProject.id}` : "/runs/new")
                }
              >
                New mission
              </Button>
            ) : null}
          </header>
          <main className={styles.content}>
            {technicalError ? (
              <MessageBar className={styles.error} intent="error">
                <MessageBarBody>
                  Không thể tải dữ liệu từ local server.
                  <details>
                    <summary>Chi tiết kỹ thuật</summary>
                    {technicalError}
                  </details>
                </MessageBarBody>
              </MessageBar>
            ) : null}
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
