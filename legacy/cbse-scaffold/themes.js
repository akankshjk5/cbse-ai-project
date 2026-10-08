const THEMES = {
  "cbse-blue": {
    name: "CBSE Blue",
    dark: "1A3A6B", light: "F0F5FF", accent: "2E6DB4",
    secondary: "F4A622", muted: "B0C4DE", border: "C8D8F0",
    textDark: "1A3A6B", fontHeading: "Calibri", fontBody: "Calibri"
  },
  "forest-green": {
    name: "Forest Green",
    dark: "1B5E20", light: "F1F8E9", accent: "388E3C",
    secondary: "FBC02D", muted: "A5D6A7", border: "C8E6C9",
    textDark: "1B5E20", fontHeading: "Georgia", fontBody: "Calibri"
  },
  "saffron-india": {
    name: "Saffron India",
    dark: "BF360C", light: "FFF8F0", accent: "E64A19",
    secondary: "1565C0", muted: "FFCCBC", border: "FFCCBC",
    textDark: "BF360C", fontHeading: "Georgia", fontBody: "Calibri"
  },
  "midnight-executive": {
    name: "Midnight Executive",
    dark: "1E2761", light: "F0F4FF", accent: "4472C4",
    secondary: "70AD47", muted: "CADCFC", border: "C9D3F5",
    textDark: "1E2761", fontHeading: "Calibri", fontBody: "Calibri"
  },
  "teal-science": {
    name: "Teal Science",
    dark: "004D40", light: "E0F2F1", accent: "00897B",
    secondary: "FFA000", muted: "80CBC4", border: "B2DFDB",
    textDark: "004D40", fontHeading: "Trebuchet MS", fontBody: "Calibri"
  },
  "purple-maths": {
    name: "Purple Maths",
    dark: "311B92", light: "EDE7F6", accent: "673AB7",
    secondary: "FF6F00", muted: "CE93D8", border: "D1C4E9",
    textDark: "311B92", fontHeading: "Georgia", fontBody: "Calibri"
  },
  "story-kids": {
    name: "Story Kids",
    dark: "E65100", light: "FFF8E1", accent: "FF8F00",
    secondary: "1565C0", muted: "FFCC80", border: "FFE0B2",
    textDark: "BF360C", fontHeading: "Trebuchet MS", fontBody: "Calibri"
  }
};

function autoTheme(classNum, subject) {
  if (classNum <= 4) return "story-kids";
  if (subject === "maths") return "purple-maths";
  if (["physics","chemistry","biology","science"].includes(subject)) return "teal-science";
  if (["history","geography","civics","social-science"].includes(subject)) return "saffron-india";
  if (classNum >= 11) return "midnight-executive";
  return "cbse-blue";
}

module.exports = { THEMES, autoTheme };