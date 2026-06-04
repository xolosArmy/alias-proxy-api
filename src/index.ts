import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ChronikClient, type Tx, type TxHistoryPage } from "chronik-client";
import { encodeCashAddress } from "ecashaddrjs";

type AddressType = "p2pkh" | "p2sh";

dotenv.config();

const app = express();

const SERVICE_NAME = "alias-indexer-api";
const LOKAD_ID = "2e786563";
const OP_RETURN_PREFIX = `6a04${LOKAD_ID}00`;
const ALIAS_SUFFIX = ".xec";
const ADDRESS_PAYLOAD_BYTES = 21;
const ADDRESS_PAYLOAD_HEX_LENGTH = ADDRESS_PAYLOAD_BYTES * 2;
const PAGE_SIZE = 200;
const DEFAULT_ALIAS_LIMIT = 25;
const MAX_ALIAS_LIMIT = 100;

const port = Number(process.env.PORT || 3014);
const chronikUrl = process.env.CHRONIK_URL || "https://chronik.xolosarmy.xyz";
const chronik = new ChronikClient([chronikUrl]);

export type AliasRecord = {
  alias: string;
  address: string;
  txid: string;
  blockheight?: number;
  status: "confirmed" | "pending";
  source: "chronik-indexer" | "chronik-mempool";
};

type AliasStatus = AliasRecord["status"];
type AliasSource = AliasRecord["source"];

let aliasIndex = new Map<string, AliasRecord>();
let pendingAliasMap = new Map<string, AliasRecord>();
let refreshedAt: string | null = null;
let lastRefreshError: string | null = null;

const allowedOrigins = new Set([
  process.env.ALLOWED_ORIGIN || "https://ecash.mx",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "OPTIONS"],
});

function isHex(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeAlias(rawAlias: string): string {
  const alias = rawAlias.trim().toLowerCase();
  return alias.endsWith(ALIAS_SUFFIX) ? alias.slice(0, -ALIAS_SUFFIX.length) : alias;
}

export function isValidAliasName(alias: string): boolean {
  return /^[a-z0-9]{1,21}$/.test(alias);
}

function parseAliasLimit(rawLimit: unknown): number {
  if (typeof rawLimit !== "string") {
    return DEFAULT_ALIAS_LIMIT;
  }

  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    return DEFAULT_ALIAS_LIMIT;
  }

  return Math.min(limit, MAX_ALIAS_LIMIT);
}

function parseIncludePending(rawIncludePending: unknown): boolean {
  return rawIncludePending === "true";
}

function getAlphabetizedAliases(includePending = false): AliasRecord[] {
  const aliases = includePending
    ? [...aliasIndex.values(), ...pendingAliasMap.values()]
    : Array.from(aliasIndex.values());

  return aliases.sort((left, right) =>
    left.alias.localeCompare(right.alias),
  );
}

export function parseAliasOpReturn(
  outputScriptHex: string,
): { alias: string; addressPayloadHex: string } | null {
  const scriptHex = outputScriptHex.toLowerCase();

  if (!isHex(scriptHex) || !scriptHex.startsWith(OP_RETURN_PREFIX)) {
    return null;
  }

  let cursor = OP_RETURN_PREFIX.length;
  const aliasLengthHex = scriptHex.slice(cursor, cursor + 2);
  if (aliasLengthHex.length !== 2) {
    return null;
  }

  const aliasLength = Number.parseInt(aliasLengthHex, 16);
  if (aliasLength < 1 || aliasLength > 21) {
    return null;
  }

  cursor += 2;
  const aliasHexLength = aliasLength * 2;
  const aliasHex = scriptHex.slice(cursor, cursor + aliasHexLength);
  if (aliasHex.length !== aliasHexLength) {
    return null;
  }

  const aliasName = Buffer.from(aliasHex, "hex").toString("utf8");
  if (!isValidAliasName(aliasName)) {
    return null;
  }

  cursor += aliasHexLength;
  const addressPayloadPushByte = scriptHex.slice(cursor, cursor + 2);
  if (addressPayloadPushByte !== "15") {
    return null;
  }

  cursor += 2;
  const addressPayloadHex = scriptHex.slice(
    cursor,
    cursor + ADDRESS_PAYLOAD_HEX_LENGTH,
  );
  if (
    addressPayloadHex.length !== ADDRESS_PAYLOAD_HEX_LENGTH ||
    !isHex(addressPayloadHex)
  ) {
    return null;
  }

  return {
    alias: `${aliasName}${ALIAS_SUFFIX}`,
    addressPayloadHex,
  };
}

export function payloadToEcashAddress(payloadHex: string): string | null {
  const normalizedPayloadHex = payloadHex.toLowerCase();
  if (
    normalizedPayloadHex.length !== ADDRESS_PAYLOAD_HEX_LENGTH ||
    !isHex(normalizedPayloadHex)
  ) {
    return null;
  }

  const typeByte = normalizedPayloadHex.slice(0, 2);
  const typeByByte: Record<string, AddressType> = {
    "00": "p2pkh",
    "08": "p2sh",
  };
  const type = typeByByte[typeByte];
  if (!type) {
    return null;
  }

  const hashHex = normalizedPayloadHex.slice(2);
  try {
    return encodeCashAddress("ecash", type, hexToBytes(hashHex));
  } catch {
    return null;
  }
}

export function extractOutputScriptHex(output: unknown): string | null {
  if (!output || typeof output !== "object") {
    return null;
  }

  const outputRecord = output as Record<string, unknown>;
  const scriptRecord =
    outputRecord.script && typeof outputRecord.script === "object"
      ? (outputRecord.script as Record<string, unknown>)
      : null;

  const candidates = [
    outputRecord.outputScript,
    outputRecord.outputScriptHex,
    outputRecord.script,
    scriptRecord?.hex,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && isHex(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function fetchConfirmedAliasTxs(): Promise<Tx[]> {
  const firstPage = await chronik.lokadId(LOKAD_ID).confirmedTxs(0, PAGE_SIZE);
  const txs = [...firstPage.txs];

  if (typeof firstPage.numPages !== "number") {
    // TODO: Older Chronik response shapes may omit numPages. In that case,
    // fetch only the first page until the client contract is confirmed.
    return txs;
  }

  for (let page = 1; page < firstPage.numPages; page += 1) {
    const nextPage: TxHistoryPage = await chronik
      .lokadId(LOKAD_ID)
      .confirmedTxs(page, PAGE_SIZE);
    txs.push(...nextPage.txs);
  }

  return txs;
}

async function fetchPendingAliasTxs(): Promise<Tx[]> {
  const unconfirmedTxs = await chronik.lokadId(LOKAD_ID).unconfirmedTxs();
  return unconfirmedTxs.txs;
}

function addAliasTxsToIndex(
  txs: Tx[],
  targetIndex: Map<string, AliasRecord>,
  status: AliasStatus,
  source: AliasSource,
  confirmedIndex = new Map<string, AliasRecord>(),
): void {
  for (const tx of txs) {
    for (const output of tx.outputs) {
      const outputScriptHex = extractOutputScriptHex(output);
      if (!outputScriptHex) {
        continue;
      }

      const parsedAlias = parseAliasOpReturn(outputScriptHex);
      if (
        !parsedAlias ||
        targetIndex.has(parsedAlias.alias) ||
        confirmedIndex.has(parsedAlias.alias)
      ) {
        // TODO: Implement full protocol conflict rules after MVP indexing.
        continue;
      }

      const address = payloadToEcashAddress(parsedAlias.addressPayloadHex);
      if (!address) {
        continue;
      }

      targetIndex.set(parsedAlias.alias, {
        alias: parsedAlias.alias,
        address,
        txid: tx.txid,
        blockheight: tx.block?.height,
        status,
        source,
      });
    }
  }
}

export async function refreshAliasIndex(): Promise<void> {
  try {
    const confirmedTxs = await fetchConfirmedAliasTxs();
    const nextAliasIndex = new Map<string, AliasRecord>();
    addAliasTxsToIndex(
      confirmedTxs,
      nextAliasIndex,
      "confirmed",
      "chronik-indexer",
    );

    const pendingTxs = await fetchPendingAliasTxs();
    const nextPendingAliasMap = new Map<string, AliasRecord>();
    addAliasTxsToIndex(
      pendingTxs,
      nextPendingAliasMap,
      "pending",
      "chronik-mempool",
      nextAliasIndex,
    );

    aliasIndex = nextAliasIndex;
    pendingAliasMap = nextPendingAliasMap;
    refreshedAt = new Date().toISOString();
    lastRefreshError = null;
  } catch (error) {
    lastRefreshError = errorMessage(error);
    throw error;
  }
}

app.use(corsMiddleware);
app.options(/.*/, corsMiddleware);

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: SERVICE_NAME,
    confirmedAliases: aliasIndex.size,
    pendingAliases: pendingAliasMap.size,
    aliases: aliasIndex.size + pendingAliasMap.size,
    refreshedAt,
    lastRefreshError,
  });
});

app.get("/refresh", async (_req, res) => {
  try {
    await refreshAliasIndex();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      confirmedAliases: aliasIndex.size,
      pendingAliases: pendingAliasMap.size,
      aliases: aliasIndex.size + pendingAliasMap.size,
      refreshedAt,
      lastRefreshError,
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Alias index refresh failed",
      lastRefreshError,
    });
  }
});

app.get("/aliases", (req, res) => {
  const limit = parseAliasLimit(req.query.limit);
  const includePending = parseIncludePending(req.query.includePending);
  const allAliases = getAlphabetizedAliases(includePending);
  const aliases = allAliases.slice(0, limit);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    total: allAliases.length,
    confirmedAliases: aliasIndex.size,
    pendingAliases: includePending ? pendingAliasMap.size : 0,
    limit,
    includePending,
    refreshedAt,
    aliases,
  });
});

app.get("/aliases/search", (req, res) => {
  if (typeof req.query.q !== "string" || req.query.q.trim() === "") {
    res.status(400).json({ error: "Missing required query parameter: q" });
    return;
  }

  const q = req.query.q.trim().toLowerCase();
  const includePending = parseIncludePending(req.query.includePending);
  const allAliases = getAlphabetizedAliases(includePending);
  const matchedAliases = allAliases
    .filter((record) => record.alias.includes(q))
    .slice(0, MAX_ALIAS_LIMIT);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    total: allAliases.length,
    confirmedAliases: aliasIndex.size,
    pendingAliases: includePending ? pendingAliasMap.size : 0,
    limit: MAX_ALIAS_LIMIT,
    includePending,
    refreshedAt,
    aliases: matchedAliases,
  });
});

app.get("/alias/:alias", (req, res) => {
  const namePart = normalizeAlias(req.params.alias);

  if (!isValidAliasName(namePart)) {
    res.status(400).json({ error: "Invalid alias" });
    return;
  }

  const alias = `${namePart}${ALIAS_SUFFIX}`;
  const record = aliasIndex.get(alias) ?? pendingAliasMap.get(alias);
  if (!record) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(record);
});

app.listen(port, () => {
  console.log(`${SERVICE_NAME} listening on port ${port}`);

  refreshAliasIndex().catch((error) => {
    console.error("Initial alias index refresh failed:", errorMessage(error));
  });
});
