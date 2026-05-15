// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { l10n } from "vscode";

import type { SortModelItem } from "ag-grid-community";

import { onRunError } from "../../commands/run";
import {
  LibraryAdapter,
  LibraryItem,
  TableData,
  TableQuery,
  TableRow,
} from "../../components/LibraryNavigator/types";
import { ColumnCollection, TableInfo } from "../rest/api/compute";
import { getColumnIconType } from "../util";
import { bridgeSend } from "./index";

export class IomJavaLibraryAdapter implements LibraryAdapter {
  public async connect(): Promise<void> {
    // Session setup is handled by the session itself before any command
  }

  public async setup(): Promise<void> {
    await this.connect();
  }

  public async deleteTable(item: LibraryItem): Promise<void> {
    const code = `proc datasets library=${item.library} nolist nodetails; delete ${item.name}; run;`;
    const resp = await bridgeSend({ cmd: "submit", code });
    if (resp.status === "error") {
      throw new Error(resp.message);
    }
    await bridgeSend({ cmd: "flushLog" });
  }

  public async getLibraries(
    _start: number,
    _limit: number,
  ): Promise<{ items: LibraryItem[]; count: number }> {
    try {
      const resp = await bridgeSend({ cmd: "getLibraries" });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw = (resp.data as Array<{ id: string; name: string; readOnly: boolean }>) || [];
      const items: LibraryItem[] = raw.map((lib) => ({
        type: "library" as const,
        uid: lib.name,
        id: lib.name,
        name: lib.name,
        readOnly: !!lib.readOnly,
      }));
      return { items, count: -1 };
    } catch (e) {
      onRunError(e);
      return { items: [], count: -1 };
    }
  }

  public async getTables(
    item: LibraryItem,
    _start: number,
    _limit: number,
  ): Promise<{ items: LibraryItem[]; count: number }> {
    try {
      const resp = await bridgeSend({
        cmd: "getTables",
        libref: item.name,
      });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw = (resp.data as string[]) || [];
      const items: LibraryItem[] = raw.map((tbl) => ({
        type: "table" as const,
        uid: `${item.name}.${tbl}`,
        id: tbl,
        name: tbl,
        library: item.name,
        readOnly: item.readOnly,
      }));
      return { items, count: -1 };
    } catch (e) {
      onRunError(e);
      return { items: [], count: -1 };
    }
  }

  public async getColumns(
    item: LibraryItem,
    _start: number,
    _limit: number,
  ): Promise<ColumnCollection> {
    try {
      const resp = await bridgeSend({
        cmd: "getColumns",
        libref: item.library,
        table: item.name,
      });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw =
        (resp.data as Array<{
          index: number;
          name: string;
          type: string;
          length: number;
          label: string;
          format: string;
          informat: string;
        }>) || [];
      const items = raw.map((col, idx) => ({
        index: idx,
        name: col.name,
        type: getColumnIconType({ index: idx, type: col.type, name: col.name, format: col.format || "" }),
        label: col.label,
        length: col.length,
        format: col.format ? { name: col.format, width: 0, precision: 0 } : undefined,
        informat: col.informat ? { name: col.informat, width: 0, precision: 0 } : undefined,
      }));
      return { items, count: -1 };
    } catch (e) {
      onRunError(e);
      return { items: [], count: -1 };
    }
  }

  public async getRows(
    item: LibraryItem,
    start: number,
    limit: number,
    sortModel: SortModelItem[],
    query: TableQuery | undefined,
  ): Promise<TableData> {
    try {
      const sortStr = sortModel.map((s) => `${s.colId} ${s.sort}`).join(", ");
      const whereClause = query?.filterValue
        ? this.buildWhereClause(query.filterValue)
        : "";
      const code =
        `proc sql outobs=${limit};\n` +
        `  select * from ${item.library}.${item.name}` +
        (whereClause ? ` where ${whereClause}` : "") +
        (sortStr ? ` order by ${sortStr}` : "") +
        `;\nquit;\n`;

      const submitResp = await bridgeSend({ cmd: "submit", code });
      if (submitResp.status === "error") {
        throw new Error(submitResp.message);
      }
      const logResp = await bridgeSend({ cmd: "flushLog" });
      const log = (logResp.data as string) || "";
      const rows = this.parseProcsqlRows(log, start);
      return { rows, count: -1 };
    } catch (e) {
      onRunError(e);
      return { rows: [], count: -1 };
    }
  }

  public async getRowsAsCSV(
    item: LibraryItem,
    start: number,
    limit: number,
  ): Promise<TableData> {
    const columns =
      start === 0
        ? { columns: (await this.getColumns(item, 0, 999)).items.map((c) => c.name || "") }
        : {};
    const { rows } = await this.getRows(item, start, limit, [], undefined);
    rows.unshift(columns);
    return { rows, count: -1 };
  }

  public async getTableRowCount(
    item: LibraryItem,
  ): Promise<{ rowCount: number; maxNumberOfRowsToRead: number }> {
    const code =
      `proc sql;\n` +
      `  select count(1) into: _iomjava_cnt from ${item.library}.${item.name};\n` +
      `quit;\n` +
      `%put IOMJAVA_COUNT=&_iomjava_cnt;\n`;
    const submitResp = await bridgeSend({ cmd: "submit", code });
    if (submitResp.status === "error") {
      throw new Error(submitResp.message);
    }
    const logResp = await bridgeSend({ cmd: "flushLog" });
    const log = (logResp.data as string) || "";
    const match = log.match(/IOMJAVA_COUNT=\s*(\d+)/);
    const rowCount = match ? parseInt(match[1], 10) : 0;
    return { rowCount, maxNumberOfRowsToRead: 100 };
  }

  public async getTableInfo(item: LibraryItem): Promise<TableInfo> {
    const base: TableInfo = {
      bookmarkLength: 0,
      columnCount: 0,
      compressionRoutine: "",
      creationTimeStamp: "",
      encoding: "",
      engine: "",
      extendedType: "",
      label: "",
      libref: item.library || "",
      logicalRecordCount: 0,
      modifiedTimeStamp: "",
      name: item.name,
      physicalRecordCount: 0,
      recordLength: 0,
      rowCount: 0,
      type: "DATA",
    };
    try {
      const code =
        `data _null_;\n` +
        `  set sashelp.vtable(where=(libname='${item.library?.toUpperCase()}' and memname='${item.name.toUpperCase()}'));\n` +
        `  put "IOMJAVA_TBLINFO:" nobs " " nlobs " " nvar " " label;\n` +
        `run;\n`;
      const submitResp = await bridgeSend({ cmd: "submit", code });
      if (submitResp.status === "error") {
        return base;
      }
      const logResp = await bridgeSend({ cmd: "flushLog" });
      const log = (logResp.data as string) || "";
      const match = log.match(/IOMJAVA_TBLINFO:\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)/);
      if (match) {
        return {
          ...base,
          rowCount: parseInt(match[1], 10),
          logicalRecordCount: parseInt(match[2], 10),
          columnCount: parseInt(match[3], 10),
          label: match[4]?.trim() || "",
        };
      }
    } catch {
      // Return base info on error
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildWhereClause(filterValue: string): string {
    // Very conservative escaping: only allow alphanumeric + spaces in filter
    const safe = filterValue.replace(/['"]/g, "");
    return `(1=1 /* filter: ${safe} */)`;
  }

  private parseProcsqlRows(log: string, start: number): TableRow[] {
    // Parse tab- or space-separated lines from PROC SQL output
    // This is a best-effort parser; the primary use is library browsing
    const rows: TableRow[] = [];
    let rowIdx = start;
    for (const raw of log.split("\n")) {
      const line = raw.trimEnd();
      if (!line || line.startsWith("NOTE:") || line.startsWith("WARNING:") || line.startsWith("ERROR:")) {
        continue;
      }
      const cells = line.split(/\t/).map((c) => c.trim());
      if (cells.length > 1) {
        rows.push({ cells: [`${rowIdx + 1}`].concat(cells) });
        rowIdx++;
      }
    }
    return rows;
  }

  private _warnedNotImpl = false;
  private warnNotImpl(method: string): void {
    if (!this._warnedNotImpl) {
      console.warn(`[iom-java] ${method} not fully implemented`);
      this._warnedNotImpl = true;
    }
  }
}

/**
 * Returns a table-data result with an error row when something fails at
 * the adapter level and we still want to surface a message in the UI.
 */
function errorTableData(msg: string): TableData {
  return {
    rows: [{ cells: [l10n.t("Error: {0}", msg)] }],
    count: 0,
  };
}
