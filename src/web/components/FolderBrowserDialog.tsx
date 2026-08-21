import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
} from "@fluentui/react-components";
import { ArrowUp20Regular, Folder20Regular, FolderOpen20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import type { DirectoryEntry, DirectoryListing } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  surface: { width: "min(560px, 96vw)" },
  path: {
    padding: "8px 10px",
    borderRadius: "6px",
    backgroundColor: "#15181b",
    fontFamily: '"Cascadia Code", Consolas, monospace',
    overflowWrap: "anywhere",
    marginBottom: "10px",
  },
  toolbar: { display: "flex", gap: "8px", marginBottom: "10px" },
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
  empty: { padding: "18px", color: "#7f8a96", textAlign: "center" },
  center: { display: "grid", placeItems: "center", height: "100%" },
});

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

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      setListing(await readJson<DirectoryListing>(`/api/v1/filesystem/browse${query}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load(startPath);
  }, [open, startPath, load]);

  return (
    <Dialog open={open} onOpenChange={(_event, data) => !data.open && onCancel()}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Chọn thư mục kho mã</DialogTitle>
          <DialogContent>
            <Text block className={styles.path}>
              {listing?.path ?? "Đang tải..."}
            </Text>
            <div className={styles.toolbar}>
              <Button
                appearance="secondary"
                disabled={!listing?.parent || loading}
                icon={<ArrowUp20Regular />}
                onClick={() => listing?.parent && void load(listing.parent)}
              >
                Lên một cấp
              </Button>
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
              ) : listing?.entries.length ? (
                listing.entries.map((entry: DirectoryEntry) => (
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
                    <Text>{entry.name}</Text>
                    {entry.looksLikeGitRepo ? (
                      <Text size={100} style={{ color: "#75a9f2", marginLeft: "auto" }}>
                        kho Git
                      </Text>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className={styles.empty}>Thư mục con trống.</div>
              )}
            </div>
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
