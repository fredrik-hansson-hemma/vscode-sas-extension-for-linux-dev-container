// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect } from "chai";
import sinon from "sinon";

import { LibraryItem } from "../../../src/components/LibraryNavigator/types";
import { IomJavaLibraryAdapter } from "../../../src/connection/iom_java/IomJavaLibraryAdapter";
import * as bridge from "../../../src/connection/iom_java/index";

describe("IomJavaLibraryAdapter", () => {
  let bridgeSendStub: sinon.SinonStub;
  let submitCodeStub: sinon.SinonStub;
  let adapter: IomJavaLibraryAdapter;

  beforeEach(() => {
    bridgeSendStub = sinon.stub(bridge, "bridgeSend");
    submitCodeStub = sinon.stub(bridge, "submitCode");
    adapter = new IomJavaLibraryAdapter();
  });

  afterEach(() => {
    bridgeSendStub.restore();
    submitCodeStub.restore();
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

    it("lists a concatenated library only once", async () => {
      bridgeSendStub.resolves({
        status: "ok",
        data: [
          { name: "SASHELP", readOnly: true },
          { name: "SASHELP", readOnly: true },
          { name: "WORK", readOnly: false },
        ],
      });

      const result = await adapter.getLibraries();

      expect(result.items.map((i) => i.name)).to.deep.equal([
        "SASHELP",
        "WORK",
      ]);
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
          {
            index: 0,
            name: "Name",
            type: "char",
            length: 8,
            label: "Student Name",
            format: "$8.",
            informat: "",
          },
          {
            index: 1,
            name: "Age",
            type: "num",
            length: 8,
            label: "Age",
            format: "",
            informat: "",
          },
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

  describe("getRows", () => {
    it("reads rows start+1..start+limit and numbers them from start", async () => {
      submitCodeStub.resolves(
        [
          "NOTE: echo of source",
          '12   put "IOMJAVA_CELL:" _n_ ":" _iomjava_value;',
          "IOMJAVA_CELL:1 :Alfred",
          "IOMJAVA_CELL:1 :14",
          "IOMJAVA_CELL:2 :Alice",
          "IOMJAVA_CELL:2 :",
          "NOTE: There were 2 observations read",
        ].join("\n"),
      );

      const result = await adapter.getRows(tableItem, 10, 2, [], undefined);

      expect(result.rows).to.deep.equal([
        { cells: ["11", "Alfred", "14"] },
        { cells: ["12", "Alice", ""] },
      ]);
      const code: string = submitCodeStub.firstCall.args[0];
      expect(code).to.include("firstobs=11 obs=12");
      expect(code).to.include('SASHELP."CLASS"n');
    });

    it("sorts through a temporary view", async () => {
      submitCodeStub.resolves("");

      await adapter.getRows(
        tableItem,
        0,
        100,
        [{ colId: "Age", sort: "desc" }],
        undefined,
      );

      const code: string = submitCodeStub.firstCall.args[0];
      expect(code).to.include('order by "Age"n desc');
      expect(code).to.include("drop view work._iomjava_rows");
    });

    it("returns no rows without submitting when limit is 0", async () => {
      const result = await adapter.getRows(tableItem, 0, 0, [], undefined);

      expect(result.rows).to.deep.equal([]);
      expect(submitCodeStub.called).to.be.false;
    });
  });

  describe("getTableRowCount", () => {
    it("parses the row count from the SAS log", async () => {
      submitCodeStub.resolves("NOTE: PROC SQL.\nIOMJAVA_COUNT=     19\n");

      const result = await adapter.getTableRowCount(tableItem);

      expect(result.rowCount).to.equal(19);
      expect(result.maxNumberOfRowsToRead).to.equal(100);
    });
  });

  describe("deleteTable", () => {
    it("submits proc datasets delete for the table", async () => {
      submitCodeStub.resolves("");

      await adapter.deleteTable(tableItem);

      const code: string = submitCodeStub.firstCall.args[0];
      expect(code).to.include("library=SASHELP");
      expect(code).to.include('delete "CLASS"n');
    });
  });
});
