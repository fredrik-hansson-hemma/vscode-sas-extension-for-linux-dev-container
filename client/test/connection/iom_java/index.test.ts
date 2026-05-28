// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

import { expect } from "chai";
import proc from "child_process";
import { EventEmitter } from "events";
import { SinonSandbox, SinonStub, createSandbox } from "sinon";
import { stubInterface } from "ts-sinon";

import { setContext } from "../../../src/components/ExtensionContext";
import { IomJavaSession, getSession } from "../../../src/connection/iom_java";
import { Session } from "../../../src/connection/session";
import { extensionContext } from "../../../src/node/extension";

const BASE_CONFIG = {
  host: "sas-server.example.com",
  port: 8591,
  username: "testuser",
  sasJarPath: "/path/to/sas/jars",
};

/** Simulates the Java bridge process writing a JSON response on stdout. */
function emitBridgeResponse(
  stdoutEmitter: EventEmitter,
  response: object,
): void {
  stdoutEmitter.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
}

describe("iom-java connection", () => {
  let sandbox: SinonSandbox;
  let spawnStub: SinonStub;
  let stdinWriteStub: SinonStub;
  let stdinEndStub: SinonStub;
  let killStub: SinonStub;
  let stdoutEmitter: EventEmitter;
  let stderrEmitter: EventEmitter;
  let processEmitter: EventEmitter;
  let session: Session;

  beforeEach(() => {
    sandbox = createSandbox();
    spawnStub = sandbox.stub(proc, "spawn");

    stdoutEmitter = new EventEmitter();
    stderrEmitter = new EventEmitter();
    processEmitter = new EventEmitter();
    stdinWriteStub = sandbox.stub();
    stdinEndStub = sandbox.stub();
    killStub = sandbox.stub();

    spawnStub.returns({
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: { write: stdinWriteStub, end: stdinEndStub },
      on: processEmitter.on.bind(processEmitter),
      killed: false,
      kill: killStub,
    });

    const secretStore = stubInterface<vscode.SecretStorage>();
    const stubbedContext: vscode.ExtensionContext = {
      ...extensionContext,
      globalStorageUri: vscode.Uri.from({ scheme: "file", path: __dirname }),
      secrets: secretStore,
    };
    setContext(stubbedContext);

    session = getSession(BASE_CONFIG);
    session.onExecutionLogFn = () => {
      return;
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("getSession", () => {
    it("returns a Session instance", () => {
      expect(session).to.be.instanceOf(IomJavaSession);
    });
  });

  describe("setup", () => {
    afterEach(async () => {
      await session.close();
    });

    it("spawns the Java bridge process", async () => {
      const setupPromise = session.setup();

      // Bridge responds to the connect command
      emitBridgeResponse(stdoutEmitter, { status: "ok" });

      await setupPromise;

      expect(spawnStub.calledOnce).to.be.true;
      const [cmd, args] = spawnStub.firstCall.args;
      expect(cmd).to.equal("java");
      expect(args).to.include("-jar");
    });

    it("sends connect command with correct parameters", async () => {
      const setupPromise = session.setup();
      emitBridgeResponse(stdoutEmitter, { status: "ok" });
      await setupPromise;

      const connectCall = stdinWriteStub.args.find((args) => {
        try {
          return JSON.parse(args[0]).cmd === "connect";
        } catch {
          return false;
        }
      });

      expect(connectCall).to.not.be.undefined;
      const connectMsg = JSON.parse(connectCall[0]);
      expect(connectMsg.host).to.equal(BASE_CONFIG.host);
      expect(connectMsg.port).to.equal(BASE_CONFIG.port);
      expect(connectMsg.username).to.equal(BASE_CONFIG.username);
      expect(connectMsg.sasJarPath).to.equal(BASE_CONFIG.sasJarPath);
    });

    it("rejects when the bridge reports a connection error", async () => {
      const setupPromise = session.setup();
      emitBridgeResponse(stdoutEmitter, {
        status: "error",
        message: "Authentication failed",
      });

      let caughtError: Error | undefined;
      try {
        await setupPromise;
      } catch (err) {
        if (err instanceof Error) {
          caughtError = err;
        }
      }

      expect(caughtError).to.not.be.undefined;
      expect(caughtError.message).to.include("Authentication failed");
    });
  });

  describe("run", () => {
    beforeEach(async () => {
      const setupPromise = session.setup();
      emitBridgeResponse(stdoutEmitter, { status: "ok" });
      await setupPromise;
    });

    afterEach(async () => {
      await session.close();
    });

    it("sends submit and flushLog commands", async () => {
      const code = "proc print data=sashelp.class; run;";

      const runPromise = session.run(code);

      // Acknowledge submit
      emitBridgeResponse(stdoutEmitter, { status: "ok" });
      // Return log content
      emitBridgeResponse(stdoutEmitter, { status: "ok", data: "NOTE: Done." });

      await runPromise;

      const submitCall = stdinWriteStub.args.find((args) => {
        try {
          return JSON.parse(args[0]).cmd === "submit";
        } catch {
          return false;
        }
      });

      expect(submitCall).to.not.be.undefined;
      const submitMsg = JSON.parse(submitCall[0]);
      expect(submitMsg.code).to.equal(code);
    });

    it("returns an empty RunResult when there is no HTML output", async () => {
      const runPromise = session.run("data _null_; run;");

      emitBridgeResponse(stdoutEmitter, { status: "ok" });
      emitBridgeResponse(stdoutEmitter, { status: "ok", data: "" });

      const result = await runPromise;
      expect(result.html5).to.be.undefined;
    });
  });

  describe("close", () => {
    beforeEach(async () => {
      const setupPromise = session.setup();
      emitBridgeResponse(stdoutEmitter, { status: "ok" });
      await setupPromise;
    });

    it("sends disconnect command and kills the process", async () => {
      const closePromise = session.close();

      emitBridgeResponse(stdoutEmitter, { status: "ok" });

      await closePromise;

      const disconnectCall = stdinWriteStub.args.find((args) => {
        try {
          return JSON.parse(args[0]).cmd === "disconnect";
        } catch {
          return false;
        }
      });

      expect(disconnectCall).to.not.be.undefined;
      expect(killStub.calledOnce).to.be.true;
    });
  });
});
