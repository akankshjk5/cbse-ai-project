const express = require("express");
const router = express.Router();
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { generateSlides, suggestOutline } = require("../services/aiService");
const { buildPresentation } = require("../services/pptxBuilder");
const { loadChapter, listChapters, getSubjects, getAnimationMode } = require("../services/datasetService");
const { autoTheme } = require("../config/themes");

router.post("/", async (req, res, next) => {
  try {
    const { classNum, subject, chapterNo, slideCount = 10, language = "en", difficulty = "medium" } = req.body;
    let { theme } = req.body;
    if (!classNum || !subject)
      return res.status(400).json({ error: "classNum and subject are required" });
    if (classNum < 1 || classNum > 12)
      return res.status(400).json({ error: "classNum must be 1-12" });
    if (!theme) theme = autoTheme(classNum, subject);
    const chapterData = chapterNo ? loadChapter(classNum, subject, chapterNo) : null;
    const animMode = getAnimationMode(classNum);
    console.log(`[Generate] class=${classNum} sub=${subject} ch=${chapterNo} lang=${language} mode=${animMode}`);
    const { slides } = await generateSlides({ classNum, subject, chapterNo, chapterData, slideCount, language, difficulty, theme });
    const fileId = uuidv4();
    const fileName = `cbse-class${classNum}-${subject}-ch${chapterNo || "all"}-${fileId}.pptx`;
    const outPath = path.join(__dirname, "../outputs", fileName);
    await buildPresentation(slides, theme, outPath, animMode);
    res.json({ success: true, presentationId: fileId, fileName, downloadUrl: `/outputs/${fileName}`, slideCount: slides.length, animationMode: animMode, classNum, subject, chapterNo, language, theme, chapterTitle: chapterData?.title || null, slides });
  } catch (err) { next(err); }
});

router.get("/chapters", (req, res) => {
  const { classNum, subject } = req.query;
  if (!classNum || !subject)
    return res.status(400).json({ error: "classNum and subject required" });
  const chapters = listChapters(parseInt(classNum), subject);
  res.json({ success: true, chapters });
});

router.get("/subjects", (req, res) => {
  const { classNum } = req.query;
  if (!classNum)
    return res.status(400).json({ error: "classNum required" });
  const subjects = getSubjects(parseInt(classNum));
  res.json({ success: true, subjects });
});

router.post("/outline", async (req, res, next) => {
  try {
    const { classNum, subject, chapterTitle } = req.body;
    if (!classNum || !subject || !chapterTitle)
      return res.status(400).json({ error: "classNum, subject and chapterTitle required" });
    const outline = await suggestOutline(classNum, subject, chapterTitle);
    res.json({ success: true, outline });
  } catch (err) { next(err); }
});

module.exports = router;