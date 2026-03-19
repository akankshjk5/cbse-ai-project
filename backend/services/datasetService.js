const fs   = require("fs");
const path = require("path");

const DATASET_ROOT = process.env.DATASET_PATH ||
  path.join(__dirname, "../../dataset");

const INDEX_PATH = path.join(DATASET_ROOT, "index.json");

function getIndex() {
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
}

function getSubjects(classNum) {
  const n = parseInt(classNum);
  if (n <= 2)  return ["evs","maths","english","hindi"];
  if (n <= 5)  return ["evs","maths","english","hindi"];
  if (n <= 8)  return ["science","maths","social-science","english","hindi","sanskrit"];
  if (n <= 10) return ["science","maths","social-science","english","hindi"];
  return ["physics","chemistry","biology","maths","economics","accountancy","business-studies","english","hindi"];
}

function loadSubject(classNum, subject) {
  const filePath = path.join(DATASET_ROOT, "classes", String(classNum), `${subject}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadChapter(classNum, subject, chapterNo) {
  const data = loadSubject(classNum, subject);
  if (!data) return null;
  return data.chapters?.find((c) => c.chapter_no === parseInt(chapterNo)) || null;
}

function listChapters(classNum, subject) {
  const data = loadSubject(classNum, subject);
  if (!data) return [];
  return (data.chapters || []).map((c) => ({
    no:    c.chapter_no,
    title: c.title,
    topics: c.topics || [],
    difficulty: c.difficulty || "medium",
    marks: c.marks_weightage || 0,
  }));
}

function getAnimationMode(classNum) {
  const n = parseInt(classNum);
  if (n <= 2)  return "story";
  if (n <= 4)  return "story+diagram";
  if (n <= 7)  return "diagram";
  if (n <= 9)  return "professional+light";
  if (n === 10) return "professional";
  return "minimal";
}

function getAnimationFeatures(mode) {
  const map = {
    "story":              { characters: true,  narration: true,  quizPopup: true,  bullets: false, transitionStyle: "fade+zoom",  pptxAnimation: "appear" },
    "story+diagram":      { characters: true,  narration: true,  quizPopup: true,  bullets: false, transitionStyle: "fade",       pptxAnimation: "fly-in" },
    "diagram":            { characters: false, narration: false, quizPopup: true,  bullets: false, transitionStyle: "slide",      pptxAnimation: "wipe"   },
    "professional+light": { characters: false, narration: false, quizPopup: true,  bullets: true,  transitionStyle: "push",       pptxAnimation: "fade"   },
    "professional":       { characters: false, narration: false, quizPopup: true,  bullets: true,  transitionStyle: "fade",       pptxAnimation: "fade"   },
    "minimal":            { characters: false, narration: false, quizPopup: false, bullets: true,  transitionStyle: "none",       pptxAnimation: "none"   },
  };
  return map[mode] || map["professional"];
}

module.exports = {
  getIndex, getSubjects, loadSubject,
  loadChapter, listChapters,
  getAnimationMode, getAnimationFeatures,
};