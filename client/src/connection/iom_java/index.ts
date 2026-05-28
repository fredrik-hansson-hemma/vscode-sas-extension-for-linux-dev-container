// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { CancellationTokenSource, l10n, window } from "vscode";

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { resolve } from "path";
import { createInterface } from "readline";

import { RunResult } from "..";
import { getSecretStorage } from "../../components/ExtensionContext";
import { updateStatusBarItem } from "../../components/StatusBarItem";
import { Session } from "../session";
import { BridgeRequest, BridgeResponse, Config } from "./types";

const SECRET_STORAGE_NAMESPACE = "IOM_JAVA_SECRET_STORAGE";
const BRIDGE_JAR = resolve(__dirname, "iom-java-bridge.jar");

let sessionInstance: IomJavaSession | undefined;

export function getSession(c: Config): Session {
  if (!sessionInstance) {
    sessionInstance = new IomJavaSession();
  }
  sessionInstance.config = c;
  return sessionInstance;
}

export class IomJavaSession extends Session {
  private _config: Config;
  private _process: ChildProcessWithoutNullStreams | undefined;
  private _pendingResolve: ((r: BridgeResponse) => void) | undefined;
  private _pendingReject: ((e: Error) => void) | undefined;
  private _connected = false;
  private _html5FileName = "";
  private _secretStorage;
  private _passwordKey = "";
  private _passwordCancellation: CancellationTokenSource | undefined;

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
    if (this._connected && this._process && !this._process.killed) {
      return;
    }

    const java = this._config.javaPath || "java";
    this._process = spawn(java, ["-jar", BRIDGE_JAR], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this._process.stdout });
    rl.on("line", (line) => this.onBridgeLine(line));

    this._process.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.warn("[iom-java-bridge stderr]", msg);
      }
    });

    this._process.on("exit", () => {
      this._connected = false;
      this._process = undefined;
      sessionInstance = undefined;
      updateStatusBarItem(false);
    });

    const password = await this.fetchPassword();
    if (password === undefined) {
      this._process.kill();
      throw new Error(l10n.t("Password input was cancelled."));
    }

    const response = await this.send({
      cmd: "connect",
      host: this._config.host,
      port: this._config.port,
      username: this._config.username,
      password,
      sasJarPath: this._config.sasJarPath,
    });

    if (response.status === "error") {
      this._process.kill();
      this._process = undefined;
      await this.clearPassword();
      throw new Error(response.message || l10n.t("IOM connection failed."));
    }

    await this.storePassword(password);
    this._connected = true;
    updateStatusBarItem(true);
  };

  protected _run = async (code: string): Promise<RunResult> => {
    this._html5FileName = "";

    await this.send({ cmd: "submit", code });

    const log = await this.collectLog();
    const runResult: RunResult = {};

    if (this._html5FileName) {
      const listOutput = await this.send({ cmd: "flushList" });
      const listData =
        typeof listOutput.data === "string" ? listOutput.data : "";
      if (listData.search('<*id="IDX*.+">') !== -1) {
        runResult.html5 = listData;
        runResult.title = l10n.t("Result");
      }
    }

    this._onExecutionLogFn?.(
      log.split("\n").map((line) => ({ type: "normal" as const, line })),
    );

    return runResult;
  };

  protected _close = async (): Promise<void> => {
    if (this._process) {
      try {
        await this.send({ cmd: "disconnect" });
      } catch {
        // Best-effort
      }
      this._process.kill();
      this._process = undefined;
    }
    this._connected = false;
    sessionInstance = undefined;
    await this.clearPassword();
    updateStatusBarItem(false);
  };

  // -------------------------------------------------------------------------
  // Bridge communication
  // -------------------------------------------------------------------------

  private send(req: BridgeRequest): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      if (!this._process || this._process.killed) {
        reject(new Error(l10n.t("Java bridge process is not running.")));
        return;
      }
      this._pendingResolve = resolve;
      this._pendingReject = reject;
      this._process.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private onBridgeLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    try {
      const response: BridgeResponse = JSON.parse(line);
      this._pendingResolve?.(response);
    } catch {
      this._pendingReject?.(new Error(`Unexpected bridge output: ${line}`));
    } finally {
      this._pendingResolve = undefined;
      this._pendingReject = undefined;
    }
  }

  private async collectLog(): Promise<string> {
    const response = await this.send({ cmd: "flushLog" });
    return typeof response.data === "string" ? response.data : "";
  }

  // -------------------------------------------------------------------------
  // Password management
  // -------------------------------------------------------------------------

  private async fetchPassword(): Promise<string | undefined> {
    const stored = await this._secretStorage.get(this._passwordKey);
    if (stored) {
      return stored;
    }

    const source = new CancellationTokenSource();
    this._passwordCancellation = source;
    const entered = await window.showInputBox(
      {
        ignoreFocusOut: true,
        password: true,
        prompt: l10n.t("Enter your password for this connection."),
        title: l10n.t("Enter your password"),
      },
      source.token,
    );
    this._passwordCancellation = undefined;
    return entered; // undefined = cancelled
  }

  private async storePassword(password: string): Promise<void> {
    await this._secretStorage.store(this._passwordKey, password);
  }

  private async clearPassword(): Promise<void> {
    await this._secretStorage.store(this._passwordKey, "");
  }

  // -------------------------------------------------------------------------
  // Low-level helpers for library adapter
  // -------------------------------------------------------------------------

  /** Execute a bridge command and return the response. Public for adapter use. */
  public async bridgeSend(req: BridgeRequest): Promise<BridgeResponse> {
    await this.setup(true);
    return this.send(req);
  }
}

/**
 * Module-level helper used by IomJavaLibraryAdapter so it doesn't need a
 * direct session reference (mirrors the CodeRunner pattern from itc/).
 */
export async function bridgeSend(req: BridgeRequest): Promise<BridgeResponse> {
  if (!sessionInstance) {
    throw new Error("No active IOM Java session");
  }
  return sessionInstance.bridgeSend(req);
}
