require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");

const generateRoutes  = require("./routes/generate");
const editRoutes      = require("./routes/edit");
const exportRoutes    = require("./routes/export");
const themeRoutes     = require("./routes/themes");
const datasetRoutes   = require("./routes/dataset");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

// Serve generated PPTX files
const OUTPUT_DIR = path.join(__dirname, "outputs");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use("/outputs", express.static(OUTPUT_DIR));

// ── Routes ──────────────────────────────────────────────────────────────────
app.use("/api/generate", generateRoutes);
app.use("/api/edit",     editRoutes);
app.use("/api/export",   exportRoutes);
app.use("/api/themes",   themeRoutes);
app.use("/api/dataset",  datasetRoutes);

// Health check
app.get("/health", (_, res) =>
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() })
);

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Error]", err.message);
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

app.listen(PORT, () =>
  console.log(`\n🚀  CBSE NCERT Backend  →  http://localhost:${PORT}\n`)
);

module.exports = app;