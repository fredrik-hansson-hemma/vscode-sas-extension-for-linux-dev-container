// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseConfig } from "..";

export interface Config extends BaseConfig {
  host: string;
  port: number;
  username: string;
  javaPath?: string;
  sasJarPath: string;
}

export interface BridgeRequest {
  cmd: string;
  [key: string]: unknown;
}

export interface BridgeResponse {
  status: "ok" | "error";
  data?: unknown;
  message?: string;
}
