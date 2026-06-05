require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const routes  = require("./routes");
const logger  = require("./logger");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Root health check
app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    service: "Sub-V Search API v2",
    token:   process.env.COURTLISTENER_TOKEN ? "set" : "missing"
  });
});

app.use("/", routes);

// Global error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err.message || err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => logger.info(`Sub-V Search API running on port ${PORT}`));
