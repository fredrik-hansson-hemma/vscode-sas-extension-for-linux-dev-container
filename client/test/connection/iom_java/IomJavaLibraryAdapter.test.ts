// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect } from "chai";
import sinon from "sinon";

import { LibraryItem } from "../../../src/components/LibraryNavigator/types";
import * as bridge from "../../../src/connection/iom_java/index";
import { IomJavaLibraryAdapter } from "../../../src/connection/iom_java/IomJavaLibraryAdapter";

describe("IomJavaLibraryAdapter", () => {
  let bridgeSendStub: sinon.SinonStub;
  let adapter: IomJavaLibraryAdapter;

  beforeEach(() => {
    bridgeSendStub = sinon.stub(bridge, "bridgeSend");
    adapter = new IomJavaLibraryAdapter();
  });

  afterEach(() => {
    bridgeSendStub.restore();
  });

  const libraryItem: LibraryItem = {
    uid: "SASHELP",
    id: "SASHELP",
    name: "SASHELP",
    type: "library",
    readOnly: true,
  };

  const tableItem: LibraryItem = {
    uid: "SASHELP.CLASS",
    id: "CLASS",
    name: "CLASS",
    library: "SASHELP",
    type: "table",
    readOnly: true,
  };

  describe("getLibraries", () => {
    it("maps bridge response to LibraryItem array", async () => {
      bridgeSendStub.resolves({
        status: "ok",
        data: [
          { id: "SASHELP", name: "SASHELP", readOnly: true },
          { id: "WORK", name: "WORK", readOnly: false },
        ],
      });

      const result = await adapter.getLibraries();

      expect(result.items).to.have.length(2);
      expect(result.items[0]).to.deep.equal({
        type: "library",
        uid: "SASHELP",
        id: "SASHELP",
        name: "SASHELP",
        readOnly: true,
      });
      expect(result.items[1].readOnly).to.be.false;
      expect(result.count).to.equal(-1);
    });

    it("returns empty list when bridge responds with empty data", async () => {
      bridgeSendStub.resolves({ status: "ok", data: [] });

      const result = await adapter.getLibraries();

      expect(result.items).to.have.length(0);
    });
  });

  describe("getTables", () => {
    it("maps bridge response to LibraryItem array", async () => {
      bridgeSendStub.resolves({
        status: "ok",
        data: ["CLASS", "CARS", "PRICEDATA"],
      });

      const result = await adapter.getTables(libraryItem);

      expect(result.items).to.have.length(3);
      expect(result.items[0]).to.deep.equal({
        type: "table",
        uid: "SASHELP.CLASS",
        id: "CLASS",
        name: "CLASS",
        library: "SASHELP",
        readOnly: true,
      });
      expect(result.count).to.equal(-1);
    });

    it("passes the correct libref to the bridge", async () => {
      bridgeSendStub.resolves({ status: "ok", data: [] });

      await adapter.getTables(libraryItem);

      const call = bridgeSendStub.firstCall.args[0];
      expect(call.cmd).to.equal("getTables");
      expect(call.libref).to.equal("SASHELP");
    });
  });

  describe("getColumns", () => {
    it("maps bridge response to a ColumnCollection", async () => {
      bridgeSendStub.resolves({
        status: "ok",
        data: [
          { index: 0, name: "Name", type: "char", length: 8, label: "Student Name", format: "$8.", informat: "" },
          { index: 1, name: "Age", type: "num", length: 8, label: "Age", format: "", informat: "" },
        ],
      });

      const result = await adapter.getColumns(tableItem);

      expect(result.items).to.have.length(2);
      expect(result.items[0].name).to.equal("Name");
      expect(result.items[0].type).to.equal("char");
      expect(result.items[1].name).to.equal("Age");
      expect(result.items[1].type).to.equal("num");
      expect(result.count).to.equal(-1);
    });

    it("passes the correct libref and table to the bridge", async () => {
      bridgeSendStub.resolves({ status: "ok", data: [] });

      await adapter.getColumns(tableItem);

      const call = bridgeSendStub.firstCall.args[0];
      expect(call.cmd).to.equal("getColumns");
      expect(call.libref).to.equal("SASHELP");
      expect(call.table).to.equal("CLASS");
    });
  });

  describe("getTableRowCount", () => {
    it("parses the row count from the SAS log", async () => {
      bridgeSendStub
        .onFirstCall()
        .resolves({ status: "ok" }) // submit
        .onSecondCall()
        .resolves({ status: "ok", data: "NOTE: PROC SQL.\nIONJAVA_COUNT=100\n" });

      const result = await adapter.getTableRowCount(tableItem);

      expect(result.maxNumberOfRowsToRead).to.equal(100);
    });
  });

  describe("deleteTable", () => {
    it("sends submit and flushLog commands", async () => {
      bridgeSendStub.resolves({ status: "ok" });

      await adapter.deleteTable(tableItem);

      const calls = bridgeSendStub.args.map((a) => a[0].cmd);
      expect(calls).to.include("submit");
      expect(calls).to.include("flushLog");
    });
  });
});
