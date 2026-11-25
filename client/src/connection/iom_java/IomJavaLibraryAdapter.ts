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
import { bridgeSend, submitCode } from "./index";
import { BridgeRequest } from "./types";

const CELL_TAG = "IOMJAVA_CELL:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Send a bridge command and return its `data`, throwing on an error reply. */
async function request(req: BridgeRequest): Promise<unknown> {
  const resp = await bridgeSend(req);
  if (resp.status === "error") {
    throw new Error(resp.message);
  }
  return resp.data;
}

async function requestArray(req: BridgeRequest): Promise<unknown[]> {
  const data = await request(req);
  return Array.isArray(data) ? data : [];
}

/** `LIB."TABLE"n`, safe for any member name SAS returned to us. */
function datasetRef(item: LibraryItem): string {
  return `${item.library}."${item.name.replace(/"/g, '""')}"n`;
}

/** SAS string literal for use in a WHERE clause. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class IomJavaLibraryAdapter implements LibraryAdapter {
  // The session connects itself before each bridge command.
  public async connect(): Promise<void> {}

  public async setup(): Promise<void> {}

  public async deleteTable(item: LibraryItem): Promise<void> {
    const code = `proc datasets library=${item.library} nolist nodetails; delete "${item.name.replace(/"/g, '""')}"n; run;`;
    await submitCode(code);
  }

  public async getLibraries(): Promise<{
    items: LibraryItem[];
    count: number;
  }> {
    try {
      const raw = await requestArray({ cmd: "getLibraries" });
      // sashelp.vlibnam has one row per physical path, so concatenated
      // libraries such as SASHELP arrive more than once.
      const seen = new Set<string>();
      const items: LibraryItem[] = raw.reduce<LibraryItem[]>((acc, entry) => {
        if (
          isRecord(entry) &&
          typeof entry.name === "string" &&
          !seen.has(entry.name)
        ) {
          seen.add(entry.name);
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
      const raw = await requestArray({ cmd: "getTables", libref: item.name });
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
      const raw = await requestArray({
        cmd: "getColumns",
        libref: item.library,
        table: item.name,
      });
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
    if (limit <= 0) {
      return { rows: [], count: -1 };
    }
    try {
      const log = await submitCode(rowDumpCode(item, start, limit, sortModel));
      return { rows: parseRowDump(log, start), count: -1 };
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
      `  select count(1) into: _iomjava_cnt from ${datasetRef(item)};\n` +
      `quit;\n` +
      `%put IOMJAVA_COUNT=&_iomjava_cnt;\n`;
    const log = await submitCode(code);
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
        `  set sashelp.vtable(where=(libname=${quote((item.library ?? "").toUpperCase())} and memname=${quote(item.name.toUpperCase())}));\n` +
        `  put "IOMJAVA_TBLINFO:" nobs " " nlobs " " nvar " " label;\n` +
        `run;\n`;
      const log = await submitCode(code);
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
}

/**
 * DATA step that writes one log line per cell, `IOMJAVA_CELL:<n>:<value>`,
 * for rows start+1..start+limit, using formatted values in column order.
 * CALL VNEXT walks the PDV: the table's columns come first, then our own
 * helper variables, where the loop stops. Values longer than the log line
 * size are truncated.
 */
function rowDumpCode(
  item: LibraryItem,
  start: number,
  limit: number,
  sortModel: SortModelItem[],
): string {
  const orderBy = sortModel
    .map(
      (s) =>
        `"${s.colId.replace(/"/g, '""')}"n${s.sort === "desc" ? " desc" : ""}`,
    )
    .join(", ");
  const view = "work._iomjava_rows";
  const source = orderBy ? view : datasetRef(item);
  return (
    (orderBy
      ? `proc sql; create view ${view} as select * from ${datasetRef(item)} order by ${orderBy}; quit;\n`
      : "") +
    `data _null_;\n` +
    `  set ${source}(firstobs=${start + 1} obs=${start + limit});\n` +
    `  length _iomjava_name $32 _iomjava_value $32767;\n` +
    `  _iomjava_name = "";\n` +
    `  do while (1);\n` +
    `    call vnext(_iomjava_name);\n` +
    `    if upcase(_iomjava_name) = "_IOMJAVA_NAME" then leave;\n` +
    `    _iomjava_value = strip(vvaluex(_iomjava_name));\n` +
    `    put "${CELL_TAG}" _n_ ":" _iomjava_value;\n` +
    `  end;\n` +
    `run;\n` +
    (orderBy ? `proc sql; drop view ${view}; quit;\n` : "")
  );
}

/** Group the `IOMJAVA_CELL` log lines written by `rowDumpCode` into rows. */
export function parseRowDump(log: string, start: number): TableRow[] {
  const byRow = new Map<number, string[]>();
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith(CELL_TAG)) {
      continue; // also skips the echoed source, which starts with a line number
    }
    const match = line.slice(CELL_TAG.length).match(/^\s*(\d+)\s*:\s?(.*)$/);
    if (!match) {
      continue;
    }
    const n = parseInt(match[1], 10);
    const cells = byRow.get(n) ?? [];
    cells.push(match[2].trimEnd());
    byRow.set(n, cells);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, cells]) => ({ cells: [`${start + n}`, ...cells] }));
}
