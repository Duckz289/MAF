import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export type NativeLoginState =
  | "NOT_CONNECTED"
  | "CLI_READY"
  | "AUTH_UNVERIFIED"
  | "STARTING_LOGIN"
  | "WAITING_FOR_USER"
  | "VERIFYING"
  | "CONNECTED"
  | "LOGIN_CANCELLED"
  | "LOGIN_FAILED"
  | "LOGIN_EXPIRED"
  | "CLI_UNAVAILABLE"
  | "AUTH_UNSUPPORTED";

export interface NativeAuthCapabilities {
  supportsNativeLogin: boolean;
  supportsOAuth: false;
  supportsDeviceFlow: boolean;
  requiresCli: true;
  cliAvailable: boolean;
  loginMethod: "NATIVE_CLI_BROWSER" | "ANTIGRAVITY_IDE_SESSION";
  installUrl: string;
}

export interface NativeAgentConnectionView {
  id: "codex-cli" | "claude-code" | "antigravity-cli";
  category: "ACCOUNT_AGENT";
  provider: string;
  method: "NATIVE_SESSION";
  status: NativeLoginState;
  authentication: string;
  capability: string;
  connectionReference: string;
  detail: string;
  account?: { email: string; planType?: string };
  authCapabilities: NativeAuthCapabilities;
}

export interface NativeLoginAttemptView {
  id: string;
  providerId: "codex-cli" | "claude-code" | "antigravity-cli";
  status: NativeLoginState;
  startedAt: string;
  expiresAt: string;
  detail: string;
}

interface NativeProviderDefinition {
  id: "codex-cli" | "claude-code" | "antigravity-cli";
  provider: string;
  authentication: string;
  capability: string;
  command: string;
  loginArgs: string[];
  statusArgs: string[];
  installUrl: string;
  interactiveLogin?: boolean;
  statusVerification?: "CLI_STATUS" | "UNVERIFIED";
}

interface SpawnedNativeProcess {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "spawn" | "error" | "close", listener: (...args: unknown[]) => void): this;
}

export interface NativeAuthProcessRunner {
  check(
    command: string,
    args: string[],
  ): {
    available: boolean;
    output: string;
    /** A non-secret launch diagnostic. Never return CLI stdout/stderr to callers. */
    failure?: "NOT_FOUND" | "ACCESS_DENIED" | "FAILED";
  };
  start(
    command: string,
    args: string[],
    options?: { interactiveTerminal?: boolean },
  ): SpawnedNativeProcess;
}

type NativeCliFailure = "NOT_FOUND" | "ACCESS_DENIED" | "FAILED";

const defaultRunner: NativeAuthProcessRunner = {
  check(command, args) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const errorDiagnostic = String(result.error?.message ?? "");
    return {
      available: !result.error && result.status === 0,
      output: diagnostic.slice(0, 8_000),
      ...(errorCode === "ENOENT"
        ? { failure: "NOT_FOUND" as const }
        : errorCode === "EACCES" ||
            errorCode === "EPERM" ||
            /access is denied|permission denied|eacces/iu.test(`${diagnostic}\n${errorDiagnostic}`)
          ? { failure: "ACCESS_DENIED" as const }
          : result.error || result.status !== 0
            ? { failure: "FAILED" as const }
            : {}),
    };
  },
  start(command, args, options) {
    if (options?.interactiveTerminal && process.platform === "win32") {
      if (!/^[A-Za-z0-9_.-]+$/u.test(command))
        throw new Error("Interactive CLI command must be a simple executable name");
      return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/k", command, ...args], {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: false,
      }) as unknown as SpawnedNativeProcess;
    }
    return spawn(command, args, {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    }) as unknown as SpawnedNativeProcess;
  },
};

const defaultProviders = (): NativeProviderDefinition[] => [
  {
    id: "codex-cli",
    provider: "Codex",
    authentication: "Tài khoản OpenAI",
    capability: "Coding agent native với Sign in with ChatGPT khi CLI hỗ trợ.",
    command: resolveCodexCommand(),
    loginArgs: ["login"],
    statusArgs: ["login", "status"],
    installUrl: "https://developers.openai.com/codex/cli/",
  },
  {
    id: "claude-code",
    provider: "Claude Code",
    authentication: "Tài khoản Claude",
    capability: "Coding agent native với phiên đăng nhập Claude Code.",
    command: process.env.CLAUDE_COMMAND ?? "claude",
    loginArgs: ["auth", "login", "--claudeai"],
    statusArgs: ["auth", "status", "--json"],
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  },
  {
    id: "antigravity-cli",
    provider: "Antigravity",
    authentication: "Tài khoản Google qua Antigravity IDE",
    capability: "Agent Antigravity native; phiên và quota do Antigravity IDE quản lý.",
    command: resolveAntigravityCommand(),
    loginArgs: [],
    statusArgs: ["--version"],
    installUrl: "https://antigravity.google/",
    statusVerification: "UNVERIFIED",
  },
];

/**
 * Codex Desktop updates can leave a WindowsApps alias earlier on PATH than its runnable local
 * CLI. The alias is commonly blocked with EPERM for child processes. Prefer the app-owned CLI
 * binary, while letting an explicit CODEX_COMMAND always take precedence.
 */
export const resolveCodexCommand = (
  configured = process.env.CODEX_COMMAND,
  localAppData = process.env.LOCALAPPDATA,
): string => {
  if (configured) return configured;
  if (process.platform !== "win32" || !localAppData) return "codex";
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    const candidates = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
      .filter((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    return candidates[0] ?? "codex";
  } catch {
    return "codex";
  }
};

/**
 * Antigravity's headless `agy` companion is installed outside PATH by its desktop updater.
 * Match the official local layout while allowing an explicit override for managed installations.
 */
export const resolveAntigravityCommand = (
  configured = process.env.ANTIGRAVITY_COMMAND,
  localAppData = process.env.LOCALAPPDATA,
): string => {
  if (configured) return configured;
  if (process.platform === "win32" && localAppData) {
    const knownCommand = path.join(localAppData, "agy", "bin", "agy.exe");
    try {
      if (statSync(knownCommand).isFile()) return knownCommand;
    } catch {
      // Fall through to PATH for package-managed installations.
    }
  }
  return "agy";
};

interface NativeLoginAttempt extends NativeLoginAttemptView {
  process?: SpawnedNativeProcess;
  timeout?: NodeJS.Timeout;
}

/**
 * Orchestrates official native CLI login commands without reading their credentials or output.
 * It deliberately records only process state and non-secret connection identity.
 */
export class NativeAgentAuthManager {
  private readonly providers = new Map(
    defaultProviders().map((provider) => [provider.id, provider]),
  );
  private readonly attempts = new Map<string, NativeLoginAttempt>();
  private readonly activeAttemptByProvider = new Map<string, string>();
  private readonly disconnectedFromMaf = new Set<string>();
  private readonly manualLoginStarted = new Set<string>();

  constructor(
    private readonly runner: NativeAuthProcessRunner = defaultRunner,
    private readonly loginTimeoutMs = 10 * 60_000,
  ) {}

  list(): NativeAgentConnectionView[] {
    return [...this.providers.keys()].map((id) => this.connection(id));
  }

  /**
   * Reads only the public account projection exposed by the official Codex app-server. It never
   * reads credential files, requests a token refresh, or persists the account identity.
   */
  async listWithAccount(): Promise<NativeAgentConnectionView[]> {
    const connections = this.list();
    const codex = connections.find((connection) => connection.id === "codex-cli");
    if (!codex || codex.status !== "CONNECTED") return connections;
    const account = await this.readCodexAccount();
    return account
      ? connections.map((connection) =>
          connection.id === "codex-cli" ? { ...connection, account } : connection,
        )
      : connections;
  }

  async readCodexAccount(): Promise<{ email: string; planType?: string } | undefined> {
    // Unit tests must never invoke a locally authenticated provider process.
    if (process.env.NODE_ENV === "test") return undefined;
    const provider = this.provider("codex-cli");
    if (!this.runner.check(provider.command, ["--version"]).available) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const complete = (account?: { email: string; planType?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        resolve(account);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(provider.command, ["app-server", "--listen", "stdio://"], {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
      } catch {
        resolve(undefined);
        return;
      }
      const timeout = setTimeout(() => complete(), 5_000);
      const send = (message: Record<string, unknown>) =>
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\r\n`);
      const stdout = child.stdout;
      if (!stdout) {
        complete();
        return;
      }
      createInterface({ input: stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: {
              account?: { email?: unknown; planType?: unknown };
              email?: unknown;
              planType?: unknown;
            };
          };
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/read", params: { refreshToken: false } });
          }
          if (message.id === 2) {
            // Codex app-server versions have returned this projection both directly and below
            // `account`. The only accepted fields remain a bounded email and plan label.
            const account = message.result?.account ?? message.result;
            const email = account?.email;
            const planType = account?.planType;
            complete(
              typeof email === "string" && /^[^\s@]{1,128}@[^\s@]{1,255}$/u.test(email)
                ? {
                    email,
                    ...(typeof planType === "string" && /^[a-z0-9_-]{1,80}$/iu.test(planType)
                      ? { planType }
                      : {}),
                  }
                : undefined,
            );
          }
        } catch {
          // Ignore unrecognised app-server notifications; they have no account identity.
        }
      });
      child.once("error", () => complete());
      child.once("close", () => complete());
      send({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "maf_local", title: "MAF", version: "0.1.0" } },
      });
    });
  }

  connection(id: string): NativeAgentConnectionView {
    const provider = this.provider(id);
    const cliCheck = this.runner.check(provider.command, ["--version"]);
    const cliAvailable = cliCheck.available;
    const active = this.activeAttempt(provider.id);
    const capability = this.capabilities(provider, cliAvailable);
    if (active) return this.view(provider, active.status, capability, active.detail);
    if (!cliAvailable)
      return this.view(
        provider,
        "CLI_UNAVAILABLE",
        capability,
        this.unavailableDetail(provider, cliCheck.failure),
      );
    if (this.disconnectedFromMaf.has(provider.id))
      return this.view(
        provider,
        "NOT_CONNECTED",
        capability,
        "MAF đang không dùng phiên native này. Đăng nhập lại chỉ kết nối MAF, không thay đổi phiên provider.",
      );
    if (provider.statusVerification === "UNVERIFIED" && this.manualLoginStarted.has(provider.id))
      return this.view(
        provider,
        "AUTH_UNVERIFIED",
        capability,
        "Antigravity CLI đã sẵn sàng nhưng không có lệnh kiểm tra phiên. Đăng nhập Google trong Antigravity IDE; `agy` sẽ dùng phiên đó khi chạy agent. MAF không đọc token để tự xác minh trạng thái.",
      );
    if (provider.id === "antigravity-cli")
      return this.view(
        provider,
        "CLI_READY",
        capability,
        "Antigravity CLI đã sẵn sàng và được MAF kết nối. `agy` dùng phiên Google của Antigravity IDE khi chạy agent; MAF không đọc hoặc lưu token tài khoản.",
      );
    const authenticated = this.isAuthenticated(provider);
    return this.view(
      provider,
      authenticated ? "CONNECTED" : "NOT_CONNECTED",
      capability,
      authenticated
        ? "Phiên native đã được CLI xác nhận. MAF không đọc hoặc lưu token tài khoản."
        : "Sẵn sàng mở luồng đăng nhập chính thức của CLI.",
    );
  }

  beginLogin(id: string): NativeLoginAttemptView {
    const provider = this.provider(id);
    const cliAvailable = this.runner.check(provider.command, ["--version"]).available;
    if (!cliAvailable) throw new Error("CLI_UNAVAILABLE");
    if (provider.id === "antigravity-cli") throw new Error("ANTIGRAVITY_IDE_LOGIN_REQUIRED");
    const existing = this.activeAttempt(provider.id);
    if (existing) return this.attemptView(existing);
    this.disconnectedFromMaf.delete(provider.id);
    const attempt: NativeLoginAttempt = {
      id: randomUUID(),
      providerId: provider.id,
      status: "STARTING_LOGIN",
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.loginTimeoutMs).toISOString(),
      detail: `Đang khởi tạo đăng nhập ${provider.provider}. Trình duyệt sẽ được CLI mở khi cần.`,
    };
    this.attempts.set(attempt.id, attempt);
    this.activeAttemptByProvider.set(provider.id, attempt.id);
    try {
      const child = provider.interactiveLogin
        ? this.runner.start(provider.command, provider.loginArgs, { interactiveTerminal: true })
        : this.runner.start(provider.command, provider.loginArgs);
      attempt.process = child;
      attempt.timeout = setTimeout(() => this.expire(attempt.id), this.loginTimeoutMs);
      child.once("spawn", () => {
        if (attempt.status !== "STARTING_LOGIN") return;
        if (provider.statusVerification === "UNVERIFIED") {
          this.manualLoginStarted.add(provider.id);
          this.terminal(
            attempt,
            "AUTH_UNVERIFIED",
            "CLI native đã mở. Hoàn tất đăng nhập trong provider để MAF dùng phiên CLI.",
          );
          return;
        }
        attempt.status = "WAITING_FOR_USER";
        attempt.detail =
          "Trình duyệt xác thực đang được mở. Hoàn tất đăng nhập để MAF tiếp tục tự động.";
      });
      child.once("error", () => this.fail(attempt.id, "CLI không thể khởi chạy đăng nhập."));
      child.once("close", (code) =>
        this.finish(attempt.id, typeof code === "number" ? code : null),
      );
    } catch {
      this.fail(attempt.id, "CLI không thể khởi chạy đăng nhập.");
    }
    return this.attemptView(attempt);
  }

  pollLogin(id: string, attemptId: string): NativeLoginAttemptView {
    const provider = this.provider(id);
    const attempt = this.requireAttempt(provider.id, attemptId);
    if (
      (attempt.status === "STARTING_LOGIN" || attempt.status === "WAITING_FOR_USER") &&
      this.isAuthenticated(provider)
    ) {
      this.complete(attempt, "Đã xác nhận phiên native. MAF sẵn sàng sử dụng kết nối này.");
    }
    return this.attemptView(attempt);
  }

  cancelLogin(id: string, attemptId: string): NativeLoginAttemptView {
    const attempt = this.requireAttempt(this.provider(id).id, attemptId);
    if (attempt.status === "STARTING_LOGIN" || attempt.status === "WAITING_FOR_USER") {
      attempt.process?.kill("SIGTERM");
      this.terminal(
        attempt,
        "LOGIN_CANCELLED",
        "Đã hủy đăng nhập. Phiên provider hiện có không bị thay đổi.",
      );
    }
    return this.attemptView(attempt);
  }

  disconnectFromMaf(id: string): void {
    const provider = this.provider(id);
    const active = this.activeAttempt(provider.id);
    if (active) this.cancelLogin(provider.id, active.id);
    this.manualLoginStarted.delete(provider.id);
    this.disconnectedFromMaf.add(provider.id);
  }

  private finish(attemptId: string, code: number | null): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || this.isTerminal(attempt.status)) return;
    const provider = this.provider(attempt.providerId);
    if (provider.statusVerification === "UNVERIFIED") return;
    attempt.status = "VERIFYING";
    attempt.detail = "Đang xác nhận phiên native với CLI.";
    if (code === 0 && this.isAuthenticated(provider))
      this.complete(attempt, "Đăng nhập hoàn tất. Phiên native đã được CLI xác nhận.");
    else
      this.terminal(
        attempt,
        "LOGIN_FAILED",
        "CLI không xác nhận được đăng nhập. Bạn có thể thử lại.",
      );
  }

  private expire(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || this.isTerminal(attempt.status)) return;
    attempt.process?.kill("SIGTERM");
    this.terminal(attempt, "LOGIN_EXPIRED", "Phiên đăng nhập đã hết hạn. Hãy thử lại.");
  }

  private fail(attemptId: string, detail: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || this.isTerminal(attempt.status)) return;
    this.terminal(attempt, "LOGIN_FAILED", detail);
  }

  private complete(attempt: NativeLoginAttempt, detail: string): void {
    this.terminal(attempt, "CONNECTED", detail);
  }

  private terminal(attempt: NativeLoginAttempt, status: NativeLoginState, detail: string): void {
    if (attempt.timeout) clearTimeout(attempt.timeout);
    attempt.status = status;
    attempt.detail = detail;
    this.activeAttemptByProvider.delete(attempt.providerId);
  }

  private activeAttempt(providerId: string): NativeLoginAttempt | undefined {
    const id = this.activeAttemptByProvider.get(providerId);
    return id ? this.attempts.get(id) : undefined;
  }

  private requireAttempt(providerId: string, attemptId: string): NativeLoginAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.providerId !== providerId) throw new Error("LOGIN_ATTEMPT_NOT_FOUND");
    return attempt;
  }

  private isAuthenticated(provider: NativeProviderDefinition): boolean {
    const result = this.runner.check(provider.command, provider.statusArgs);
    const normalized = result.output.toLowerCase();
    if (
      !result.available ||
      /not[ _-]?(logged[ _-]?in|authenticated)|unauthenticated|no active auth/u.test(normalized)
    )
      return false;
    return /logged[ _-]?in|authenticated|"loggedin"\s*:\s*true|"authmode"\s*:\s*"chatgpt"/u.test(
      normalized,
    );
  }

  private capabilities(
    provider: NativeProviderDefinition,
    cliAvailable: boolean,
  ): NativeAuthCapabilities {
    return {
      supportsNativeLogin: provider.id !== "antigravity-cli",
      supportsOAuth: false,
      supportsDeviceFlow: provider.id === "codex-cli",
      requiresCli: true,
      cliAvailable,
      loginMethod:
        provider.id === "antigravity-cli" ? "ANTIGRAVITY_IDE_SESSION" : "NATIVE_CLI_BROWSER",
      installUrl: provider.installUrl,
    };
  }

  private unavailableDetail(
    provider: NativeProviderDefinition,
    failure: NativeCliFailure | undefined,
  ): string {
    if (provider.id === "codex-cli" && failure === "ACCESS_DENIED")
      return "Codex Desktop có thể đã được cài, nhưng executable đi kèm không cấp quyền chạy cho server MAF. Cài Codex CLI chính thức hoặc đặt CODEX_COMMAND tới CLI có thể chạy; MAF không trích xuất phiên Desktop của bạn.";
    if (provider.id === "antigravity-cli")
      return "MAF không tìm thấy Antigravity companion `agy`. Cài hoặc cập nhật Antigravity IDE, hoặc đặt ANTIGRAVITY_COMMAND tới agy.exe. MAF không đọc cookie, token hoặc file phiên IDE.";
    return "CLI chưa sẵn sàng. Cài đặt bằng hướng dẫn chính thức rồi thử lại.";
  }

  private view(
    provider: NativeProviderDefinition,
    status: NativeLoginState,
    authCapabilities: NativeAuthCapabilities,
    detail: string,
  ): NativeAgentConnectionView {
    return {
      id: provider.id,
      category: "ACCOUNT_AGENT",
      provider: provider.provider,
      method: "NATIVE_SESSION",
      status,
      authentication: provider.authentication,
      capability: provider.capability,
      connectionReference:
        provider.id === "codex-cli"
          ? "connection://codex/account"
          : provider.id === "antigravity-cli"
            ? "connection://antigravity/native"
            : "connection://claude/native",
      detail,
      authCapabilities,
    };
  }

  private attemptView(attempt: NativeLoginAttempt): NativeLoginAttemptView {
    const { process: _process, timeout: _timeout, ...view } = attempt;
    return view;
  }

  private isTerminal(status: NativeLoginState): boolean {
    return [
      "CONNECTED",
      "AUTH_UNVERIFIED",
      "LOGIN_CANCELLED",
      "LOGIN_FAILED",
      "LOGIN_EXPIRED",
    ].includes(status);
  }

  private provider(id: string): NativeProviderDefinition {
    const provider = this.providers.get(id as NativeProviderDefinition["id"]);
    if (!provider) throw new Error("AUTH_UNSUPPORTED");
    return provider;
  }
}
