import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
} from "@fluentui/react-components";
import {
  ArrowUp20Regular,
  Dismiss12Regular,
  Folder20Regular,
  FolderOpen20Regular,
  Search20Regular,
} from "@fluentui/react-icons";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryEntry, DirectoryListing } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  surface: { width: "min(560px, 96vw)" },
  breadcrumbs: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "2px",
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: "#15181b",
    marginBottom: "10px",
  },
  crumb: {
    minWidth: 0,
    padding: "2px 6px",
    borderRadius: "4px",
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: "13px",
    color: "#aeb6bf",
    ":hover": { backgroundColor: "#1f2429", color: "#f3f5f7" },
  },
  crumbCurrent: { color: "#f3f5f7", fontWeight: 600 },
  crumbSep: { color: "#4a5158" },
  goRow: { display: "flex", gap: "8px", marginBottom: "10px" },
  goInput: { flex: 1, fontFamily: '"Cascadia Code", Consolas, monospace' },
  toolbar: { display: "flex", gap: "8px", marginBottom: "10px", alignItems: "center" },
  filterInput: { flex: 1 },
  list: {
    height: "320px",
    overflowY: "auto",
    border: "1px solid #252b31",
    borderRadius: "8px",
    backgroundColor: "#0f1113",
  },
  row: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "9px 12px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #1c2126",
    color: "#f3f5f7",
    cursor: "pointer",
    textAlign: "left",
    ":hover": { backgroundColor: "#171a1e" },
  },
  match: { color: "#75a9f2" },
  empty: { padding: "18px", color: "#7f8a96", textAlign: "center" },
  center: { display: "grid", placeItems: "center", height: "100%" },
  hint: { color: "#6d7884", marginTop: "6px" },
});

const lastPathStorageKey = "maf.folderBrowser.lastPath";

interface PathSegment {
  label: string;
  path: string;
}

/** Splits an absolute Windows or POSIX path into clickable breadcrumb segments. */
const pathSegments = (fullPath: string): PathSegment[] => {
  const isWindows = /^[A-Za-z]:/u.test(fullPath) || fullPath.includes("\\");
  const parts = fullPath.split(/[\\/]+/u).filter(Boolean);
  if (isWindows) {
    const segments: PathSegment[] = [];
    let cumulative = "";
    parts.forEach((part, index) => {
      if (index === 0) {
        cumulative = `${part}\\`;
        segments.push({ label: cumulative, path: cumulative });
      } else {
        cumulative = `${cumulative}${cumulative.endsWith("\\") ? "" : "\\"}${part}`;
        segments.push({ label: part, path: cumulative });
      }
    });
    return segments;
  }
  const segments: PathSegment[] = [{ label: "/", path: "/" }];
  let cumulative = "";
  for (const part of parts) {
    cumulative += `/${part}`;
    segments.push({ label: part, path: cumulative });
  }
  return segments;
};

const highlight = (name: string, query: string, matchClass: string) => {
  if (!query) return name;
  const index = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index === -1) return name;
  return (
    <>
      {name.slice(0, index)}
      <span className={matchClass}>{name.slice(index, index + query.length)}</span>
      {name.slice(index + query.length)}
    </>
  );
};

export function FolderBrowserDialog({
  onCancel,
  onSelect,
  open,
  startPath,
}: {
  onCancel: () => void;
  onSelect: (path: string) => void;
  open: boolean;
  startPath?: string | undefined;
}) {
  const styles = useStyles();
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [goTo, setGoTo] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const result = await readJson<DirectoryListing>(`/api/v1/filesystem/browse${query}`);
      setListing(result);
      setGoTo(result.path);
      setFilter("");
      if (!result.unreadable) {
        try {
          window.localStorage.setItem(lastPathStorageKey, result.path);
        } catch {
          // Private browsing or storage disabled — remembering the last folder is a nicety, not a requirement.
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let initial = startPath;
    if (!initial) {
      try {
        initial = window.localStorage.getItem(lastPathStorageKey) ?? undefined;
      } catch {
        initial = undefined;
      }
    }
    void load(initial);
  }, [open, load, startPath]);

  useEffect(() => {
    if (!loading) filterInputRef.current?.focus();
  }, [loading]);

  const filtered = filter
    ? (listing?.entries.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
      ) ?? [])
    : (listing?.entries ?? []);

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    if (filtered.length === 1) {
      event.preventDefault();
      void load(filtered[0]?.path);
    }
  };

  const submitGoTo = () => {
    if (goTo.trim()) void load(goTo.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(_event, data) => !data.open && onCancel()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Chọn thư mục kho mã</DialogTitle>
          <DialogContent>
            <div className={styles.goRow}>
              <Input
                className={styles.goInput}
                onChange={(_event, data) => setGoTo(data.value)}
                onKeyDown={(event) => event.key === "Enter" && submitGoTo()}
                placeholder="Dán đường dẫn đầy đủ rồi nhấn Enter…"
                value={goTo}
              />
              <Button appearance="secondary" disabled={!goTo.trim()} onClick={submitGoTo}>
                Đi tới
              </Button>
            </div>
            {listing?.path ? (
              <div className={styles.breadcrumbs}>
                {pathSegments(listing.path).map((segment, index, all) => (
                  <span key={segment.path} style={{ display: "flex", alignItems: "center" }}>
                    {index > 0 ? (
                      <Text className={styles.crumbSep} size={200}>
                        /
                      </Text>
                    ) : null}
                    <Button
                      appearance="transparent"
                      className={mergeClasses(
                        styles.crumb,
                        index === all.length - 1 && styles.crumbCurrent,
                      )}
                      disabled={loading || index === all.length - 1}
                      onClick={() => void load(segment.path)}
                      size="small"
                    >
                      {segment.label}
                    </Button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className={styles.toolbar}>
              <Button
                appearance="secondary"
                disabled={!listing?.parent || loading}
                icon={<ArrowUp20Regular />}
                onClick={() => listing?.parent && void load(listing.parent)}
              >
                Lên một cấp
              </Button>
              <Input
                className={styles.filterInput}
                contentBefore={<Search20Regular />}
                contentAfter={
                  filter ? (
                    <Button
                      appearance="transparent"
                      icon={<Dismiss12Regular />}
                      onClick={() => setFilter("")}
                      size="small"
                    />
                  ) : null
                }
                onChange={(_event, data) => setFilter(data.value)}
                onKeyDown={onFilterKeyDown}
                placeholder="Gõ để lọc thư mục con…"
                ref={(element) => {
                  filterInputRef.current = element;
                }}
                value={filter}
              />
            </div>
            {error ? (
              <MessageBar intent="error">
                <MessageBarBody>Không thể đọc thư mục. {error}</MessageBarBody>
              </MessageBar>
            ) : null}
            <div className={styles.list}>
              {loading ? (
                <div className={styles.center}>
                  <Spinner size="small" />
                </div>
              ) : listing?.unreadable ? (
                <div className={styles.empty}>Không thể đọc thư mục này.</div>
              ) : filtered.length ? (
                filtered.map((entry: DirectoryEntry) => (
                  <button
                    className={styles.row}
                    key={entry.path}
                    onClick={() => void load(entry.path)}
                    type="button"
                  >
                    {entry.looksLikeGitRepo ? (
                      <FolderOpen20Regular primaryFill="#75a9f2" />
                    ) : (
                      <Folder20Regular />
                    )}
                    <Text>{highlight(entry.name, filter, styles.match)}</Text>
                    {entry.looksLikeGitRepo ? (
                      <Text size={100} style={{ color: "#75a9f2", marginLeft: "auto" }}>
                        kho Git
                      </Text>
                    ) : null}
                  </button>
                ))
              ) : listing?.entries.length ? (
                <div className={styles.empty}>Không có thư mục nào khớp "{filter}".</div>
              ) : (
                <div className={styles.empty}>Thư mục con trống.</div>
              )}
            </div>
            {filtered.length === 1 && filter ? (
              <Text block className={styles.hint} size={100}>
                Nhấn Enter để vào "{filtered[0]?.name}".
              </Text>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel}>
              Hủy
            </Button>
            <Button
              appearance="primary"
              disabled={!listing || listing.unreadable}
              onClick={() => listing && onSelect(listing.path)}
            >
              Chọn thư mục này
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
