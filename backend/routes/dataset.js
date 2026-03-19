const express = require("express");
const router = express.Router();
const { getSubjects, listChapters, loadChapter, getAnimationMode } = require("../services/datasetService");

router.get("/subjects", (req, res) => {
  const n = parseInt(req.query.classNum);
  if (!n) return res.status(400).json({ error: "classNum required" });
  res.json({ success: true, classNum: n, subjects: getSubjects(n) });
});

router.get("/chapters", (req, res) => {
  const { classNum, subject } = req.query;
  if (!classNum || !subject)
    return res.status(400).json({ error: "classNum and subject required" });
  res.json({ success: true, chapters: listChapters(parseInt(classNum), subject) });
});

router.get("/chapter", (req, res) => {
  const { classNum, subject, chapterNo } = req.query;
  if (!classNum || !subject || !chapterNo)
    return res.status(400).json({ error: "classNum, subject and chapterNo required" });
  const chapter = loadChapter(parseInt(classNum), subject, parseInt(chapterNo));
  if (!chapter) return res.status(404).json({ error: "Chapter not found in dataset" });
  res.json({ success: true, chapter });
});

router.get("/animation-mode", (req, res) => {
  const n = parseInt(req.query.classNum);
  if (!n) return res.status(400).json({ error: "classNum required" });
  res.json({ success: true, classNum: n, animationMode: getAnimationMode(n) });
});

module.exports = router;