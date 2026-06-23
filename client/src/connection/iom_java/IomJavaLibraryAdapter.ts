// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

  public async getLibraries(): Promise<{
    items: LibraryItem[];
    count: number;
  }> {
    try {
      const resp = await bridgeSend({ cmd: "getLibraries" });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw = Array.isArray(resp.data) ? resp.data : [];
      const items: LibraryItem[] = raw.reduce<LibraryItem[]>((acc, entry) => {
        if (isRecord(entry) && typeof entry.name === "string") {
          acc.push({
            type: "library" as const,
            uid: entry.name,
            id: entry.name,
            name: entry.name,
            readOnly: !!entry.readOnly,
          });
        }
        return acc;
      }, []);
      return { items, count: -1 };
    } catch (e) {
      onRunError(e);
      return { items: [], count: -1 };
    }
  }

  public async getTables(
    item: LibraryItem,
  ): Promise<{ items: LibraryItem[]; count: number }> {
    try {
      const resp = await bridgeSend({
        cmd: "getTables",
        libref: item.name,
      });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw = Array.isArray(resp.data) ? resp.data : [];
      const items: LibraryItem[] = raw.reduce<LibraryItem[]>((acc, tbl) => {
        if (typeof tbl === "string") {
          acc.push({
            type: "table" as const,
            uid: `${item.name}.${tbl}`,
            id: tbl,
            name: tbl,
            library: item.name,
            readOnly: item.readOnly,
          });
        }
        return acc;
      }, []);
      return { items, count: -1 };
    } catch (e) {
      onRunError(e);
      return { items: [], count: -1 };
    }
  }

  public async getColumns(item: LibraryItem): Promise<ColumnCollection> {
    try {
      const resp = await bridgeSend({
        cmd: "getColumns",
        libref: item.library,
        table: item.name,
      });
      if (resp.status === "error") {
        throw new Error(resp.message);
      }
      const raw = Array.isArray(resp.data) ? resp.data : [];
      let colIdx = 0;
      const items = raw.reduce<NonNullable<ColumnCollection["items"]>>(
        (acc, col) => {
          if (
            isRecord(col) &&
            typeof col.name === "string" &&
            typeof col.type === "string"
          ) {
            const idx = colIdx++;
            const fmt = typeof col.format === "string" ? col.format : "";
            acc.push({
              index: idx,
              name: col.name,
              type: getColumnIconType({
                index: idx,
                type: col.type,
                name: col.name,
                format: fmt,
              }),
              label: typeof col.label === "string" ? col.label : undefined,
              length: typeof col.length === "number" ? col.length : undefined,
              format: fmt ? { name: fmt } : undefined,
              informat:
                typeof col.informat === "string" && col.informat
                  ? { name: col.informat }
                  : undefined,
            });
          }
          return acc;
        },
        [],
      );
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
    // `query` is intentionally ignored: the interface wires filter UI
    // through here, but iom-java has no safe way to translate the filter
    // to a SAS WHERE clause today, so any incoming filter would be silently
    // dropped. Documented in the matrix; remove the eslint-disable when
    // filtering is implemented.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    query: TableQuery | undefined,
  ): Promise<TableData> {
    try {
      const sortStr = sortModel.map((s) => `${s.colId} ${s.sort}`).join(", ");
      const code =
        `proc sql outobs=${limit};\n` +
        `  select * from ${item.library}.${item.name}` +
        (sortStr ? ` order by ${sortStr}` : "") +
        `;\nquit;\n`;

      const submitResp = await bridgeSend({ cmd: "submit", code });
      if (submitResp.status === "error") {
        throw new Error(submitResp.message);
      }
      const logResp = await bridgeSend({ cmd: "flushLog" });
      const log = typeof logResp.data === "string" ? logResp.data : "";
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
        ? {
            columns: (await this.getColumns(item)).items.map(
              (c) => c.name || "",
            ),
          }
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
    const log = typeof logResp.data === "string" ? logResp.data : "";
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
      const log = typeof logResp.data === "string" ? logResp.data : "";
      const match = log.match(
        /IOMJAVA_TBLINFO:\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)/,
      );
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

  private parseProcsqlRows(log: string, start: number): TableRow[] {
    const rows: TableRow[] = [];
    let rowIdx = start;
    for (const raw of log.split("\n")) {
      const line = raw.trimEnd();
      if (
        !line ||
        line.startsWith("NOTE:") ||
        line.startsWith("WARNING:") ||
        line.startsWith("ERROR:")
      ) {
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
}
