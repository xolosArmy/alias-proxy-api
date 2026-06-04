import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const port = Number(process.env.PORT || 3014);
const aliasUpstream = process.env.ALIAS_UPSTREAM || "https://alias.etokens.cash";
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

app.use(corsMiddleware);
app.options(/.*/, corsMiddleware);

app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    service: "alias-proxy-api",
  });
});

app.get("/alias/:alias", async (req, res) => {
  const alias = req.params.alias.trim().toLowerCase();
  const namePart = alias.endsWith(".xec") ? alias.slice(0, -4) : alias;

  if (!/^[a-z0-9]{1,21}$/.test(namePart)) {
    res.status(400).json({ error: "Invalid alias" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const upstreamUrl = new URL(
      `/alias/${encodeURIComponent(namePart)}`,
      aliasUpstream,
    );

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (upstreamResponse.status === 404) {
      res.status(404).json({ error: "Alias not found" });
      return;
    }

    if (!upstreamResponse.ok) {
      res.status(502).json({ error: "Alias upstream error" });
      return;
    }

    const data = await upstreamResponse.json();

    if (!data.address) {
      res.status(404).json({ error: "Alias not found" });
      return;
    }

    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      alias: `${namePart}.xec`,
      address: data.address,
      txid: data.txid,
      blockheight: data.blockheight,
      registrationFeeSats: data.registrationFeeSats,
      processedBlockheight: data.processedBlockheight,
      source: "alias-proxy",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      res.status(504).json({ error: "Alias upstream timeout" });
      return;
    }

    res.status(502).json({ error: "Alias proxy error" });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(port, () => {
  console.log(`alias-proxy-api listening on port ${port}`);
});
