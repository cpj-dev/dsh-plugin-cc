/**
 * Child-process fixture for the ensureBroker race test: ensures a broker for
 * the workspace given as argv[2] and prints the resulting daemon pid.
 */

import process from "node:process";

import { ensureBroker, getBrokerStatus } from "../plugins/dsh/scripts/lib/broker-client.mjs";

const workspace = process.argv[2];
await ensureBroker(workspace, { permissionMode: "read-only" });
const status = await getBrokerStatus(workspace);
console.log(JSON.stringify({ pid: status?.pid ?? null }));
