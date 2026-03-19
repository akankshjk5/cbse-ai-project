const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");

router.get("/:fileName", (req, res, next) => {
  try {
    const { fileName } = req.params;
    if (!/^[\w\-]+\.pptx$/.test(fileName))
      return res.status(400).json({ error: "Invalid filename" });
    const fp = path.join(__dirname, "../outputs", fileName);
    if (!fs.existsSync(fp))
      return res.status(404).json({ error: "File not found" });
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.sendFile(fp);
  } catch (err) {
    next(err);
  }
});

router.delete("/:fileName", (req, res) => {
  const fp = path.join(__dirname, "../outputs", req.params.fileName);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "File not found" });
  }
});

module.exports = router;