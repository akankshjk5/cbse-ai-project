export const VIDEO_LANGUAGES = [
  {
    code: 'en-IN',
    label: 'English (India)',
    promptName: 'Indian English',
    scriptExample: 'Algebra uses letters to represent unknown numbers.',
  },
  {
    code: 'hi-IN',
    label: 'Hindi',
    promptName: 'Hindi',
    scriptExample: 'बीजगणित में अक्षर अज्ञात संख्या को दर्शाता है।',
  },
  {
    code: 'bn-IN',
    label: 'Bengali',
    promptName: 'Bengali',
    scriptExample: 'বীজগণিতে একটি অক্ষর অজানা সংখ্যাকে বোঝায়।',
  },
  {
    code: 'gu-IN',
    label: 'Gujarati',
    promptName: 'Gujarati',
    scriptExample: 'બીજગણિતમાં અક્ષર અજ્ઞાત સંખ્યાને દર્શાવે છે.',
  },
  {
    code: 'kn-IN',
    label: 'Kannada',
    promptName: 'Kannada',
    scriptExample: 'ಬೀಜಗಣಿತದಲ್ಲಿ ಅಕ್ಷರವು ತಿಳಿಯದ ಸಂಖ್ಯೆಯನ್ನು ಸೂಚಿಸುತ್ತದೆ.',
  },
  {
    code: 'ml-IN',
    label: 'Malayalam',
    promptName: 'Malayalam',
    scriptExample: 'ബീജഗണിതത്തിൽ ഒരു അക്ഷരം അജ്ഞാത സംഖ്യയെ സൂചിപ്പിക്കുന്നു.',
  },
  {
    code: 'mr-IN',
    label: 'Marathi',
    promptName: 'Marathi',
    scriptExample: 'बीजगणितात अक्षर अज्ञात संख्या दर्शवते.',
  },
  {
    code: 'ta-IN',
    label: 'Tamil',
    promptName: 'Tamil',
    scriptExample: 'இயற்கணிதத்தில் ஓர் எழுத்து தெரியாத எண்ணைக் குறிக்கிறது.',
  },
  {
    code: 'te-IN',
    label: 'Telugu',
    promptName: 'Telugu',
    scriptExample: 'బీజగణితంలో అక్షరం తెలియని సంఖ్యను సూచిస్తుంది.',
  },
] as const;

export type VideoLanguageCode = (typeof VIDEO_LANGUAGES)[number]['code'];

const INDIAN_SCRIPT_PATTERN = /[\u0900-\u0D7F]/u;
const LANGUAGE_SCRIPT_PATTERNS: Partial<Record<VideoLanguageCode, RegExp>> = {
  'hi-IN': /[\u0900-\u097F]/u,
  'bn-IN': /[\u0980-\u09FF]/u,
  'gu-IN': /[\u0A80-\u0AFF]/u,
  'kn-IN': /[\u0C80-\u0CFF]/u,
  'ml-IN': /[\u0D00-\u0D7F]/u,
  'mr-IN': /[\u0900-\u097F]/u,
  'ta-IN': /[\u0B80-\u0BFF]/u,
  'te-IN': /[\u0C00-\u0C7F]/u,
};

export function videoLanguage(code: VideoLanguageCode) {
  const language = VIDEO_LANGUAGES.find((item) => item.code === code);
  if (!language) throw new Error(`Unsupported video language: ${code}`);
  return language;
}

export function narrationUsesSelectedLanguage(
  text: string,
  code: VideoLanguageCode,
): boolean {
  if (code === 'en-IN') return !INDIAN_SCRIPT_PATTERN.test(text);
  const script = LANGUAGE_SCRIPT_PATTERNS[code];
  if (!script) return false;
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return false;
  const nativeLetters = letters.filter((character) => script.test(character)).length;
  return nativeLetters >= Math.max(12, Math.floor(letters.length * 0.55));
}

/** Short-text variant for 1-5 word captions (narration needs 12+ native letters). */
export function captionUsesSelectedLanguage(text: string, code: VideoLanguageCode): boolean {
  if (code === 'en-IN') return !INDIAN_SCRIPT_PATTERN.test(text) && /\p{L}/u.test(text);
  const script = LANGUAGE_SCRIPT_PATTERNS[code];
  if (!script) return false;
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  const native = letters.filter((character) => script.test(character)).length;
  return native >= 2 && native >= letters.length * 0.6;
}

export function usesEnglishProductionScript(text: string): boolean {
  return !INDIAN_SCRIPT_PATTERN.test(text);
}
