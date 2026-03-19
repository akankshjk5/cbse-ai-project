const express = require("express");
const router = express.Router();
const { THEMES, autoTheme } = require("../config/themes");

router.get("/", (_, res) => {
  const list = Object.entries(THEMES).map(([key, t]) => ({
    key, name: t.name,
    preview: { dark: `#${t.dark}`, accent: `#${t.accent}`, light: `#${t.light}` },
  }));
  res.json({ success: true, themes: list });
});

router.get("/auto", (req, res) => {
  const { classNum, subject } = req.query;
  const key = autoTheme(parseInt(classNum) || 6, subject || "science");
  res.json({ success: true, theme: key, config: THEMES[key] });
});

router.get("/:key", (req, res) => {
  const t = THEMES[req.params.key];
  if (!t) return res.status(404).json({ error: "Theme not found" });
  res.json({ success: true, theme: { key: req.params.key, ...t } });
});

module.exports = router;