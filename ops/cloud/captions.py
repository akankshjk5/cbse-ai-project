"""Caption text shaped by libass, because Pillow cannot shape Kannada.

Pillow renders Indic text with its BASIC layout engine unless it was built
against libraqm, and the wheels on PyPI are not. Without shaping, Kannada
vowel signs detach from their consonants and conjuncts break apart:
`ಪರಮಾಣುವಿನಲ್ಲಿ` renders as `ಪರಮಾಣುಪಿನಲಳಿ`, which is not a spelling mistake but
unreadable text put in front of a child.

FFmpeg is already a hard dependency and this build carries libass, harfbuzz
and fribidi, so the shaping engine is here already. This module renders one
caption to a transparent RGBA image and hands it back; the compositor pastes
it exactly as it pasted Pillow's, so the frame loop is unchanged.

Devanagari happens to survive Pillow's BASIC layout, and Latin always did.
Both still come through here, because one text path that is known-correct
beats two paths where only one has been checked.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

# The file each language's captions are set in. libass matches on the family
# name *inside* the file rather than the filename, and the two routinely
# disagree — a deployment may substitute a licensed face under the same name.
# A wrong guess does not fail; it silently falls back to another font, and the
# first sign is a video in the wrong typeface. So the family is read from the
# file and never written down here.
FONT_FILE = {
    "en-IN": "Kalam-Bold.ttf",
    "hi-IN": "NotoSansDevanagari.ttf",
    "kn-IN": "NotoSansKannada.ttf",
}

_FAMILY_CACHE: dict[str, str] = {}

# Alignment 2 is bottom-centre in ASS's numpad scheme.
BOTTOM_CENTRE = 2


def font_family(path: Path) -> str:
    """The family name libass will match, read from the font's own name table."""
    key = str(path)
    if key not in _FAMILY_CACHE:
        from fontTools.ttLib import TTFont
        font = TTFont(str(path), fontNumber=0, lazy=True)
        try:
            family = font["name"].getDebugName(1)
        finally:
            font.close()
        if not family:
            raise ValueError(f"Font has no family name: {path.name}")
        _FAMILY_CACHE[key] = family
    return _FAMILY_CACHE[key]


def font_path(config: dict, language: str) -> Path:
    name = FONT_FILE.get(language)
    if name is None:
        raise ValueError(f"No caption font configured for {language}")
    path = Path(config["fontsDir"]) / name
    if not path.is_file():
        raise ValueError(f"Missing caption font: {name}")
    return path


def escape_ass(text: str) -> str:
    """Make caption text inert inside an ASS dialogue line.

    `{...}` is an ASS override block: a caption containing `{\\pos(0,0)}` would
    otherwise move itself, and `{\\p1}` would switch the renderer into drawing
    mode and paint shapes over the frame. Backslash starts an escape. None of
    these can be allowed to arrive from a planner model or a teacher's edit, so
    the three characters that carry meaning are replaced with lookalikes and
    every newline becomes a hard line break.
    """
    return (
        text.replace("\\", "\u29f5")    # ⧵ reverse solidus operator
            .replace("{", "\u2983")     # ⦃ left white curly bracket
            .replace("}", "\u2984")     # ⦄ right white curly bracket
            .replace("\r\n", "\\N")
            .replace("\n", "\\N")
            .replace("\r", "\\N")
            .strip()
    )


def _ass_colour(hex_rgb: str) -> str:
    """ASS wants &HAABBGGRR — alpha first, then blue, green, red."""
    value = hex_rgb.lstrip("#")
    r, g, b = value[0:2], value[2:4], value[4:6]
    return f"&H00{b}{g}{r}".upper()


def build_ass(
    text: str, family: str, width: int, height: int,
    *, font_size: int, margin_v: int, colour: str, outline: str,
    outline_width: float = 0.0, bold: bool = False,
) -> str:
    """One dialogue line, styled, with the caption escaped into it."""
    return "\n".join([
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour,"
        " Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,"
        " BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Cap,{family},{font_size},{_ass_colour(colour)},{_ass_colour(outline)},"
        f"&H00000000,{1 if bold else 0},0,0,0,100,100,0,0,1,{outline_width},0,"
        f"{BOTTOM_CENTRE},60,60,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        f"Dialogue: 0,0:00:00.00,0:10:00.00,Cap,,0,0,0,,{escape_ass(text)}",
    ]) + "\n"


def render_caption(
    text: str, language: str, config: dict, width: int, height: int,
    *, font_size: int = 46, margin_v: int = 58,
    colour: str = "#2d2a26", outline: str = "#ffffff",
    outline_width: float = 0.0, bold: bool = False,
) -> Image.Image:
    """A transparent RGBA layer holding one shaped caption.

    The text is drawn white on opaque black and the result is used as an alpha
    mask, rather than drawn straight onto a transparent frame. The `ass` filter
    is built to burn captions into opaque video: blended onto a frame that is
    already fully transparent, the premultiplied arithmetic cancels and the
    output comes back empty — it renders nothing while reporting success, which
    is the worst way to fail. Going through a luminance mask keeps libass's
    antialiasing and lets the caption take any colour afterwards.

    Everything runs inside a temporary directory with relative paths, because
    an FFmpeg filter argument treats `:` as a separator and a Windows path
    (`C:/...`) cannot be passed without escaping that varies by shell. Copying
    the one font in and running with a relative `fontsdir` sidesteps that whole
    class of quoting bug.
    """
    source = font_path(config, language)
    family = font_family(source)

    with tempfile.TemporaryDirectory() as work:
        workdir = Path(work)
        (workdir / "fonts").mkdir()
        shutil.copy(source, workdir / "fonts" / source.name)
        # White on black: the rendered frame becomes the alpha channel.
        (workdir / "c.ass").write_text(
            build_ass(text, family, width, height, font_size=font_size,
                      margin_v=margin_v, colour="#ffffff", outline="#ffffff",
                      outline_width=outline_width, bold=bold),
            encoding="utf-8")
        out = workdir / "c.png"
        result = subprocess.run(
            [config["ffmpeg"], "-v", "error", "-y",
             "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}",
             "-vf", "ass=c.ass:fontsdir=fonts",
             "-frames:v", "1", "c.png"],
            cwd=str(workdir), capture_output=True, text=True, timeout=60)
        if result.returncode or not out.is_file():
            tail = (result.stderr or "").strip().splitlines()
            raise RuntimeError(f"libass caption render failed: {tail[-1] if tail else 'no output'}")
        with Image.open(out) as rendered:
            mask = rendered.convert("L")
        if mask.getbbox() is None:
            # Empty output means the font did not resolve or the text fell
            # outside the canvas. Either way the caption would be invisible,
            # which must not pass silently into a lesson.
            raise RuntimeError(
                f"libass produced no glyphs for {language}: check that "
                f"{source.name} covers this script and that margins fit {width}x{height}")
        ink = tuple(int(colour.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
        layer = Image.new("RGBA", mask.size, (*ink, 0))
        layer.putalpha(mask)
        return layer


def probe_shaping(config: dict) -> dict[str, bool]:
    """Does each language actually shape? Run before trusting a render.

    Checks that non-empty ink appears, which catches a missing font falling
    back to blank boxes. It cannot judge whether a conjunct is correct — only a
    person reading the output can — so the compositor's preflight calls this
    and a human checks the first Kannada lesson.
    """
    samples = {
        "en-IN": "Carbon forms four bonds",
        "hi-IN": "कार्बन परमाणु चार बंध बनाता है",
        "kn-IN": "ಇಂಗಾಲದ ಪರಮಾಣುವಿನಲ್ಲಿ ನಾಲ್ಕು ಬಂಧಗಳಿವೆ",
    }
    out: dict[str, bool] = {}
    for language, text in samples.items():
        try:
            layer = render_caption(text, language, config, 1200, 180, font_size=44)
            out[language] = layer.getbbox() is not None
        except Exception:
            out[language] = False
    return out
