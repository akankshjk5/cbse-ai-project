const express = require("express");
const router = express.Router();
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { editSlide, generateSpeakerNotes } = require("../services/aiService");
const { buildPresentation } = require("../services/pptxBuilder");
const { getAnimationMode } = require("../services/datasetService");
const { autoTheme } = require("../config/themes");

router.post("/slide", async (req, res, next) => {
  try {
    const { slide, instruction } = req.body;
    if (!slide || !instruction)
      return res.status(400).json({ error: "slide and instruction required" });
    res.json({ success: true, slide: await editSlide(slide, instruction) });
  } catch (err) {
    next(err);
  }
});

router.post("/notes", async (req, res, next) => {
  try {
    const { slides, classNum } = req.body;
    if (!Array.isArray(slides) || !slides.length)
      return res.status(400).json({ error: "slides required" });
    const notes = await generateSpeakerNotes(slides, classNum || 6);
    res.json({
      success: true,
      slides: slides.map((s, i) => ({
        ...s,
        speakerNotes: notes[i] || s.speakerNotes,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/rebuild", async (req, res, next) => {
  try {
    const { slides, classNum = 6, subject = "science", theme } = req.body;
    if (!Array.isArray(slides) || !slides.length)
      return res.status(400).json({ error: "slides required" });
    const t = theme || autoTheme(classNum, subject);
    const id = uuidv4();
    const fn = `rebuilt-${id}.pptx`;
    await buildPresentation(
      slides,
      t,
      path.join(__dirname, "../outputs", fn),
      getAnimationMode(classNum)
    );
    res.json({ success: true, fileName: fn, downloadUrl: `/outputs/${fn}` });
  } catch (err) {
    next(err);
  }
});

router.patch("/slide/:index", (req, res) => {
  const { slides, field, value } = req.body;
  const idx = parseInt(req.params.index, 10);
  if (
    !Array.isArray(slides) ||
    isNaN(idx) ||
    idx < 0 ||
    idx >= slides.length
  )
    return res.status(400).json({ error: "Invalid slides or index" });
  res.json({
    success: true,
    slides: slides.map((s, i) => (i === idx ? { ...s, [field]: value } : s)),
  });
});

module.exports = router;