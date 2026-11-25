// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { l10n, window } from "vscode";

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline";

import { RunResult, getSession as getActiveSession } from "..";
import { getSecretStorage } from "../../components/ExtensionContext";
import { updateStatusBarItem } from "../../components/StatusBarItem";
import { Session } from "../session";
import { BridgeRequest, BridgeResponse, Config } from "./types";

const SECRET_STORAGE_NAMESPACE = "IOM_JAVA_SECRET_STORAGE";
const BRIDGE_JAR = resolve(__dirname, "iom-java-bridge.jar");
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 1000;

let sessionInstance: IomJavaSession | undefined;

export function getSession(c: Config): Session {
  if (!sessionInstance) {
    sessionInstance = new IomJavaSession();
  }
  sessionInstance.config = c;
  return sessionInstance;
}

/** Expand a leading `~` so paths like `~/sas-jars` work from settings. */
export function expandHome(path: string): string;
export function expandHome(path: string | undefined): string | undefined;
export function expandHome(path: string | undefined): string | undefined {
  if (path === "~" || path?.startsWith("~/")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "ok" || value.status === "error")
  );
}

export class IomJavaSession extends Session {
  private _config: Config;
  private _process: ChildProcessWithoutNullStreams | undefined;
  private _pending:
    | {
        resolve: (r: BridgeResponse) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  /** Tail of the bridge work queue; see `exclusive`. */
  private _queue: Promise<unknown> = Promise.resolve();
  private _connected = false;
  private _secretStorage;
  private _passwordKey = "";

  constructor() {
    super();
    this._secretStorage = getSecretStorage(SECRET_STORAGE_NAMESPACE);
  }

  public set config(value: Config) {
    this._config = value;
    this._passwordKey = `${value.host}:${value.port}:${value.username}`;
  }

  public sessionId = (): string => {
    throw new Error(l10n.t("Method not implemented."));
  };

  protected establishConnection = async (): Promise<void> => {
    try {
      await this.connect();
    } catch (e) {
      // Session.setup caches the connection promise and only clears it on
      // success; drop a failed one so the next attempt reconnects instead of
      // replaying this error (e.g. after a mistyped password).
      this._connectionPromise = undefined;
      throw e;
    }
  };

  private async connect(): Promise<void> {
    if (this._connected && this._process && !this._process.killed) {
      return;
    }

    const java = expandHome(this._config.javaPath) || "java";
    const child = spawn(java, ["-jar", BRIDGE_JAR]);
    this._process = child;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => this.onBridgeLine(line));

    child.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.warn("[iom-java-bridge stderr]", msg);
      }
    });

    child.on("exit", () => {
      // A process we already replaced (failed connect, cancelled password)
      // must not tear down the current one.
      if (this._process !== child) {
        return;
      }
      this.takePending()?.reject(
        new Error(l10n.t("Java bridge process exited unexpectedly.")),
      );
      this._connected = false;
      this._process = undefined;
      if (sessionInstance === this) {
        sessionInstance = undefined;
      }
      updateStatusBarItem(false);
    });

    const stored = await this._secretStorage.get(this._passwordKey);
    const password = stored || (await this.promptForPassword());
    if (password === undefined) {
      this.killProcess();
      throw new Error(l10n.t("Password input was cancelled."));
    }

    const response = await this.send({
      cmd: "connect",
      host: this._config.host,
      port: this._config.port,
      username: this._config.username,
      password,
      sasJarPath: expandHome(this._config.sasJarPath),
    });

    if (response.status === "error") {
      this.killProcess();
      await this.clearPassword();
      throw new Error(response.message || l10n.t("IOM connection failed."));
    }

    if (!stored) {
      await this._secretStorage.store(this._passwordKey, password);
    }
    this._connected = true;
    updateStatusBarItem(true);
  }

  protected _run = async (code: string): Promise<RunResult> => {
    await this.exclusive(() =>
      this.submitAndCollectLog(code, (lines) =>
        this._onExecutionLogFn?.(
          lines.map((line) => ({ type: "normal" as const, line })),
        ),
      ),
    );
    return {};
  };

  protected _close = async (): Promise<void> => {
    if (this._process) {
      if (!this._pending) {
        try {
          await this.send({ cmd: "disconnect" });
        } catch {
          // Best-effort
        }
      }
      this.killProcess();
    }
    this._connected = false;
    if (sessionInstance === this) {
      sessionInstance = undefined;
    }
    await this.clearPassword();
    updateStatusBarItem(false);
  };

  private killProcess(): void {
    this._process?.kill();
    this._process = undefined;
  }

  // -------------------------------------------------------------------------
  // Bridge communication
  // -------------------------------------------------------------------------

  /**
   * Run `task` once every previously queued task has finished. The bridge
   * handles one request at a time, and a submit must be followed by its own
   * log flushes, so whole request sequences are serialized here.
   */
  public exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this._queue.then(task);
    this._queue = result.catch(() => undefined);
    return result;
  }

  /** Send a command, throwing if the bridge reports an error. */
  public async request(req: BridgeRequest): Promise<BridgeResponse> {
    const response = await this.send(req);
    if (response.status === "error") {
      throw new Error(response.message || l10n.t("IOM request failed."));
    }
    return response;
  }

  /**
   * Submit SAS code and flush the log until the code has finished, detected
   * by a marker `%put` appended to the code. The marker is written as
   * `%str(IOMJAVA)_DONE_<id>` so the echoed source line never matches; only
   * the line SAS prints when the `%put` executes does. Complete log lines are
   * passed to `onLines` as they arrive. Must be called inside `exclusive`.
   */
  public async submitAndCollectLog(
    code: string,
    onLines?: (lines: string[]) => void,
  ): Promise<string> {
    const id = randomUUID().replace(/-/g, "");
    const markerToken = `_DONE_${id}`;
    const done = new RegExp(`^IOMJAVA${markerToken}\\s*$`, "m");

    await this.request({
      cmd: "submit",
      code: `${code}\n%put %str(IOMJAVA)${markerToken};\n`,
    });

    const kept: string[] = [];
    let partial = "";
    const emit = (lines: string[]) => {
      const visible = lines.filter((line) => !line.includes(markerToken));
      kept.push(...visible);
      if (visible.length > 0) {
        onLines?.(visible);
      }
    };

    let log = "";
    let interval = 50;
    for (;;) {
      const { data } = await this.request({ cmd: "flushLog" });
      const chunk = typeof data === "string" ? data : "";
      log += chunk;
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      emit(lines);
      if (done.test(log)) {
        break;
      }
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);
    }
    if (partial) {
      emit([partial]);
    }
    return kept.join("\n");
  }

  private send(req: BridgeRequest): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      if (!this._process || this._process.killed) {
        reject(new Error(l10n.t("Java bridge process is not running.")));
        return;
      }
      if (this._pending) {
        // Callers serialize through `exclusive`; this guards the invariant.
        reject(new Error(l10n.t("A bridge request is already in progress.")));
        return;
      }
      const timer = setTimeout(() => {
        this.takePending()?.reject(
          new Error(
            l10n.t(
              "Bridge request '{0}' timed out after {1} seconds.",
              req.cmd,
              Math.round(REQUEST_TIMEOUT_MS / 1000),
            ),
          ),
        );
      }, REQUEST_TIMEOUT_MS);
      this._pending = { resolve, reject, timer };
      this._process.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private onBridgeLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      response = undefined;
    }
    if (!isBridgeResponse(response)) {
      // Stray output from the SAS or ORB libraries; not a reply.
      console.warn("[iom-java-bridge stdout]", line);
      return;
    }
    this.takePending()?.resolve(response);
  }

  /** Detach the in-flight request (if any) and stop its timeout. */
  private takePending() {
    const pending = this._pending;
    if (pending) {
      clearTimeout(pending.timer);
      this._pending = undefined;
    }
    return pending;
  }

  // -------------------------------------------------------------------------
  // Password management
  // -------------------------------------------------------------------------

  /** Resolves to undefined when the user cancels. */
  private promptForPassword(): Thenable<string | undefined> {
    return window.showInputBox({
      ignoreFocusOut: true,
      password: true,
      prompt: l10n.t("Enter your password for this connection."),
      title: l10n.t("Enter your password"),
    });
  }

  private async clearPassword(): Promise<void> {
    await this._secretStorage.store(this._passwordKey, "");
  }
}

// ---------------------------------------------------------------------------
// Entry points for IomJavaLibraryAdapter
// ---------------------------------------------------------------------------

/** The session for the active profile, connected (prompting if needed). */
async function connectedSession(): Promise<IomJavaSession> {
  const session = getActiveSession();
  if (!(session instanceof IomJavaSession)) {
    throw new Error(l10n.t("The active profile is not an iom-java profile."));
  }
  await session.setup(true);
  return session;
}

/** Send one bridge command; queued behind any running program. */
export async function bridgeSend(req: BridgeRequest): Promise<BridgeResponse> {
  const session = await connectedSession();
  return session.exclusive(() => session.request(req));
}

/** Submit SAS code and return its complete log; queued like `bridgeSend`. */
export async function submitCode(code: string): Promise<string> {
  const session = await connectedSession();
  return session.exclusive(() => session.submitAndCollectLog(code));
}
