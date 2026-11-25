// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import * as vscode from "vscode";

import { expect } from "chai";
import proc from "child_process";
import { EventEmitter } from "events";
import { SinonSandbox, SinonStub, createSandbox } from "sinon";
import { PassThrough } from "stream";
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

type FakeResponse = object | ((bridge: FakeBridge) => object);

/**
 * Fake Java bridge: answers each request written to stdin with the next
 * queued response on stdout. A request that arrives before a response is
 * queued is answered as soon as one is queued, so tests can queue responses
 * before or after triggering the request. A response may be a function of
 * the bridge, e.g. to echo the completion marker of the last submit.
 */
class FakeBridge {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public lastSubmitCode = "";
  private readonly queue: FakeResponse[] = [];
  private waiting = 0;

  public onRequest(data: string): void {
    const req = JSON.parse(data);
    if (req.cmd === "submit") {
      this.lastSubmitCode = req.code;
    }
    const next = this.queue.shift();
    if (next) {
      setImmediate(() => this.write(next));
    } else {
      this.waiting++;
    }
  }

  public respond(response: FakeResponse): void {
    if (this.waiting > 0) {
      this.waiting--;
      this.write(response);
    } else {
      this.queue.push(response);
    }
  }

  public writeRaw(line: string): void {
    this.stdout.write(line + "\n");
  }

  private write(response: FakeResponse): void {
    const body = typeof response === "function" ? response(this) : response;
    this.stdout.write(JSON.stringify(body) + "\n");
  }
}

/** flushLog reply ending with the line SAS prints for the done marker. */
function logWithDoneMarker(text: string): FakeResponse {
  return (bridge) => {
    const id = bridge.lastSubmitCode.match(/%str\(IOMJAVA\)(_DONE_\w+);/);
    return { status: "ok", data: `${text}\nIOMJAVA${id?.[1]}\n` };
  };
}

describe("iom-java connection", () => {
  let sandbox: SinonSandbox;
  let spawnStub: SinonStub;
  let stdinWriteStub: SinonStub;
  let stdinEndStub: SinonStub;
  let killStub: SinonStub;
  let bridge: FakeBridge;
  let processEmitter: EventEmitter;
  let session: Session;

  beforeEach(() => {
    sandbox = createSandbox();
    spawnStub = sandbox.stub(proc, "spawn");

    bridge = new FakeBridge();
    processEmitter = new EventEmitter();
    stdinWriteStub = sandbox
      .stub()
      .callsFake((data: string) => bridge.onRequest(data));
    stdinEndStub = sandbox.stub();
    killStub = sandbox.stub();

    spawnStub.returns({
      stdout: bridge.stdout,
      stderr: bridge.stderr,
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
    sandbox.stub(vscode.window, "showInputBox").resolves("password");

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
      // Answer the disconnect request sent by close().
      bridge.respond({ status: "ok" });
      await session.close();
    });

    it("spawns the Java bridge process", async () => {
      const setupPromise = session.setup();

      // Bridge responds to the connect command
      bridge.respond({ status: "ok" });

      await setupPromise;

      expect(spawnStub.calledOnce).to.be.true;
      const [cmd, args] = spawnStub.firstCall.args;
      expect(cmd).to.equal("java");
      expect(args).to.include("-jar");
    });

    it("sends connect command with correct parameters", async () => {
      const setupPromise = session.setup();
      bridge.respond({ status: "ok" });
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
      bridge.respond({
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
      bridge.respond({ status: "ok" });
      await setupPromise;
    });

    afterEach(async () => {
      // Answer the disconnect request sent by close().
      bridge.respond({ status: "ok" });
      await session.close();
    });

    it("submits the code followed by a completion marker", async () => {
      const code = "proc print data=sashelp.class; run;";
      bridge.respond({ status: "ok" });
      bridge.respond(logWithDoneMarker("NOTE: Done."));

      await session.run(code);

      expect(bridge.lastSubmitCode.startsWith(code)).to.be.true;
      expect(bridge.lastSubmitCode).to.match(/%put %str\(IOMJAVA\)_DONE_\w+;/);
    });

    it("keeps flushing the log until the marker appears", async () => {
      const logLines: string[] = [];
      session.onExecutionLogFn = (lines) =>
        logLines.push(...lines.map((l) => l.line));

      bridge.respond({ status: "ok" }); // submit
      bridge.respond({ status: "ok", data: "NOTE: first part\n" });
      bridge.respond({ status: "ok", data: "" });
      bridge.respond(logWithDoneMarker("NOTE: second part"));

      await session.run("data _null_; run;");

      expect(logLines).to.deep.equal(["NOTE: first part", "NOTE: second part"]);
      const flushes = stdinWriteStub.args.filter(
        (args) => JSON.parse(args[0]).cmd === "flushLog",
      );
      expect(flushes).to.have.length(3);
    });

    it("hides the echoed marker source line from the log", async () => {
      const logLines: string[] = [];
      session.onExecutionLogFn = (lines) =>
        logLines.push(...lines.map((l) => l.line));

      bridge.respond({ status: "ok" });
      bridge.respond((b) => {
        const id = b.lastSubmitCode.match(/%str\(IOMJAVA\)(_DONE_\w+);/)[1];
        return {
          status: "ok",
          data: `NOTE: ok\n5    %put %str(IOMJAVA)${id};\nIOMJAVA${id}\n`,
        };
      });

      await session.run("data _null_; run;");

      expect(logLines).to.deep.equal(["NOTE: ok"]);
    });

    it("returns an empty RunResult (ODS HTML5 is not yet streamed back)", async () => {
      bridge.respond({ status: "ok" });
      bridge.respond(logWithDoneMarker(""));

      const result = await session.run("data _null_; run;");
      expect(result).to.deep.equal({});
    });

    it("ignores stray non-JSON output on the bridge's stdout", async () => {
      const runPromise = session.run("data _null_; run;");
      bridge.writeRaw("WARNING: some ORB log line");
      bridge.respond({ status: "ok" });
      bridge.respond(logWithDoneMarker("NOTE: Done."));

      const result = await runPromise;
      expect(result).to.deep.equal({});
    });
  });

  describe("request queue", () => {
    beforeEach(async () => {
      const setupPromise = session.setup();
      bridge.respond({ status: "ok" });
      await setupPromise;
    });

    afterEach(async () => {
      bridge.respond({ status: "ok" });
      await session.close();
    });

    it("runs a second request after the first has finished", async () => {
      const iomSession = session;
      if (!(iomSession instanceof IomJavaSession)) {
        throw new Error("expected an IomJavaSession");
      }
      const order: string[] = [];

      const first = iomSession.exclusive(async () => {
        await iomSession.request({ cmd: "submit", code: "x" });
        order.push("first submit");
        await iomSession.request({ cmd: "flushLog" });
        order.push("first flush");
      });
      const second = iomSession.exclusive(async () => {
        await iomSession.request({ cmd: "getLibraries" });
        order.push("second");
      });

      bridge.respond({ status: "ok" });
      bridge.respond({ status: "ok", data: "" });
      bridge.respond({ status: "ok", data: [] });
      await Promise.all([first, second]);

      expect(order).to.deep.equal(["first submit", "first flush", "second"]);
      const cmds = stdinWriteStub.args.map((args) => JSON.parse(args[0]).cmd);
      expect(cmds.slice(-3)).to.deep.equal([
        "submit",
        "flushLog",
        "getLibraries",
      ]);
    });

    it("keeps serving the queue after a failed request", async () => {
      const iomSession = session;
      if (!(iomSession instanceof IomJavaSession)) {
        throw new Error("expected an IomJavaSession");
      }
      const failing = iomSession.exclusive(() =>
        iomSession.request({ cmd: "getTables", libref: "NOPE" }),
      );
      const next = iomSession.exclusive(() =>
        iomSession.request({ cmd: "getLibraries" }),
      );

      bridge.respond({ status: "error", message: "boom" });
      bridge.respond({ status: "ok", data: [] });

      let error: Error | undefined;
      try {
        await failing;
      } catch (e) {
        if (e instanceof Error) {
          error = e;
        }
      }
      expect(error?.message).to.equal("boom");
      expect((await next).status).to.equal("ok");
    });
  });

  describe("bridge process exit", () => {
    it("ignores the exit of a process that has already been replaced", async () => {
      // First connect fails; its process is killed but exits later.
      const failed = session.setup();
      bridge.respond({ status: "error", message: "Authentication failed" });
      try {
        await failed;
      } catch {
        // expected
      }
      const staleEmitter = processEmitter;

      // Retry with a fresh process.
      processEmitter = new EventEmitter();
      spawnStub.returns({
        stdout: bridge.stdout,
        stderr: bridge.stderr,
        stdin: { write: stdinWriteStub, end: stdinEndStub },
        on: processEmitter.on.bind(processEmitter),
        killed: false,
        kill: killStub,
      });
      const retry = session.setup();
      staleEmitter.emit("exit", 1);
      bridge.respond({ status: "ok" });
      await retry;

      // Session is still usable.
      bridge.respond({ status: "ok" });
      bridge.respond(logWithDoneMarker(""));
      expect(await session.run("data _null_; run;")).to.deep.equal({});

      bridge.respond({ status: "ok" });
      await session.close();
    });
  });

  describe("close", () => {
    beforeEach(async () => {
      const setupPromise = session.setup();
      bridge.respond({ status: "ok" });
      await setupPromise;
    });

    it("sends disconnect command and kills the process", async () => {
      const closePromise = session.close();

      bridge.respond({ status: "ok" });

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
