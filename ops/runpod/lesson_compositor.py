#!/usr/bin/env python3
"""Deterministic editorial compositor for narrated lesson scenes.

A generated Wan clip supplies genuine subject motion. Everything that must be
exact -- the translated caption, equations, counts, bar values, arrows -- is
drawn here in code, never by a diffusion model. The visual language follows the
supplied reference: cream grid paper, blue-grey dry-brush frames, a photo card
holding the moving subject, a hand-drawn underline, red explanatory arrows and a
slow camera push-in.
"""

from __future__ import annotations

import math
import random
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

WIDTH, HEIGHT, FPS = 1280, 720, 24
# Every composited scene carries a short held tail so assembly can overlap
# adjacent scenes with a slide transition without shortening the lesson.
TRANSITION_SECONDS = 0.4

PAPER = (238, 230, 213)
GRID = (214, 203, 182)
INK = (45, 42, 38)
MUTED_INK = (150, 143, 132)
CARD_WHITE = (248, 244, 234)
BRUSH = (124, 147, 163)
RED = (206, 55, 45)
PALETTE = [(47, 72, 88), (206, 55, 45), (51, 101, 138), (134, 168, 115), (226, 163, 59), (109, 90, 114)]

LANGUAGE_FONTS = {
    "en-IN": "Kalam-Bold.ttf",
    "hi-IN": "NotoSansDevanagari.ttf",
    "mr-IN": "NotoSansDevanagari.ttf",
    "bn-IN": "NotoSansBengali.ttf",
    "gu-IN": "NotoSansGujarati.ttf",
    "kn-IN": "NotoSansKannada.ttf",
    "ml-IN": "NotoSansMalayalam.ttf",
    "ta-IN": "NotoSansTamil.ttf",
    "te-IN": "NotoSansTelugu.ttf",
}
MATH_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "DejaVuSans-Bold.ttf",
)
EQUATION_PATTERN = re.compile(r"^[0-9a-z+\-*/=().^ <>]{1,32}$")
ARROW_DIRECTIONS = {
    "up": ((0.30, 0.92), (0.62, 0.10)),
    "down": ((0.38, 0.08), (0.66, 0.92)),
    "left": ((0.94, 0.62), (0.06, 0.40)),
    "right": ((0.06, 0.40), (0.94, 0.62)),
    "up-right": ((0.06, 0.92), (0.94, 0.10)),
    "down-right": ((0.06, 0.08), (0.96, 0.92)),
    "down-left": ((0.94, 0.08), (0.06, 0.92)),
    "up-left": ((0.94, 0.92), (0.06, 0.10)),
}


class CompositorError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------- #
# Overlay validation (mirrors src/lib/videos/overlays.ts)
# --------------------------------------------------------------------------- #

def sanitize_overlay(raw: Any) -> tuple[dict[str, Any], str | None]:
    """Return a safe overlay plus a warning when the stored value was unusable.

    An invalid overlay is dropped rather than drawn approximately: showing no
    diagram is safe, showing a wrong one is misinformation.
    """
    if not isinstance(raw, dict) or raw.get("kind") in (None, "none"):
        return {"kind": "none"}, None
    kind = raw.get("kind")
    try:
        if kind == "arrow":
            direction = str(raw.get("direction", ""))
            if direction not in ARROW_DIRECTIONS:
                raise ValueError(f"unknown arrow direction {direction!r}")
            return {"kind": "arrow", "direction": direction}, None
        if kind == "equation":
            steps = [normalize_equation(str(step)) for step in raw.get("steps") or []]
            if not 1 <= len(steps) <= 4 or not all(
                EQUATION_PATTERN.match(step) and not re.search(r"[a-z]{3,}", step)
                for step in steps
            ):
                raise ValueError("equation steps must be 1-4 short ASCII expressions")
            return {"kind": "equation", "steps": steps}, None
        if kind == "groups":
            groups = []
            for group in raw.get("groups") or []:
                count = int(group.get("count"))
                token = str(group.get("token") or "").strip()
                if not 1 <= count <= 12 or len(token) > 3 or not re.fullmatch(r"[0-9a-z]*", token):
                    raise ValueError("group counts must be 1-12 with a short optional token")
                groups.append({"count": count, "token": token})
            if not 1 <= len(groups) <= 5 or sum(group["count"] for group in groups) > 30:
                raise ValueError("groups must contain 1-5 groups and at most 30 items")
            show_total = bool(raw.get("showTotal")) and len({g["token"] for g in groups}) == 1
            return {"kind": "groups", "groups": groups, "showTotal": show_total}, None
        if kind == "bars":
            values = [float(value) for value in raw.get("values") or []]
            unit = str(raw.get("unit") or "").strip()
            if not 2 <= len(values) <= 6 or any(v < 0 or not math.isfinite(v) for v in values):
                raise ValueError("bars need 2-6 non-negative values")
            if max(values) <= 0 or len(unit) > 6 or not re.fullmatch(r"[%a-zA-Z/°]*", unit):
                raise ValueError("bars need a positive maximum and a short unit")
            return {"kind": "bars", "values": values, "unit": unit}, None
        if kind == "timeline":
            years = [int(year) for year in raw.get("years") or []]
            current = int(raw.get("current"))
            if not 2 <= len(years) <= 6 or years != sorted(set(years)) or current not in years:
                raise ValueError("timeline needs 2-6 ascending years including the current year")
            if any(not -3000 <= year <= 2100 for year in years):
                raise ValueError("timeline years are out of range")
            return {"kind": "timeline", "years": years, "current": current}, None
    except (TypeError, ValueError) as error:
        return {"kind": "none"}, f"overlay dropped: {error}"
    return {"kind": "none"}, f"overlay dropped: unsupported kind {kind!r}"


def normalize_equation(step: str) -> str:
    return re.sub(r"\s+", " ", step.strip().lower())


def display_math(step: str) -> str:
    """Typeset ASCII math with proper symbols for display only."""
    text = re.sub(r"\^2\b", "²", step)
    text = re.sub(r"\^3\b", "³", text)
    text = text.replace("*", "×").replace("/", "÷").replace("<=", "≤").replace(">=", "≥")
    text = re.sub(r"(?<=[\s(=])-|^-", "−", text)
    text = text.replace(" - ", " − ")
    return text


def format_value(value: float, unit: str) -> str:
    text = f"{value:.1f}".rstrip("0").rstrip(".") if value % 1 else str(int(value))
    return f"{text}{unit}"


# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #

@dataclass
class FontSet:
    caption: Callable[[int], Any]
    math: Callable[[int], Any]
    label: Callable[[int], Any]


def load_fonts(fonts_dir: Path, language_code: str) -> FontSet:
    from PIL import ImageFont, features

    has_raqm = features.check("raqm")
    if language_code != "en-IN" and not has_raqm:
        raise CompositorError(
            "caption_shaping_unavailable",
            "Pillow needs libraqm to shape Indic captions correctly",
        )
    layout = ImageFont.Layout.RAQM if has_raqm else ImageFont.Layout.BASIC
    caption_name = LANGUAGE_FONTS.get(language_code)
    if not caption_name:
        raise CompositorError("unsupported_language", f"No caption font for {language_code}")
    caption_path = fonts_dir / caption_name
    label_path = fonts_dir / "Kalam-Bold.ttf"
    for path in (caption_path, label_path):
        if not path.is_file():
            raise CompositorError("font_missing", f"Required font is missing: {path}")
    math_path = next(
        (Path(candidate) for candidate in MATH_FONT_CANDIDATES if Path(candidate).is_file()),
        fonts_dir / "DejaVuSans-Bold.ttf",
    )
    if not math_path.is_file():
        math_path = label_path

    cache: dict[tuple[str, int], Any] = {}

    def factory(path: Path, bold: bool) -> Callable[[int], Any]:
        def make(size: int) -> Any:
            key = (str(path), size)
            if key not in cache:
                font = ImageFont.truetype(str(path), size, layout_engine=layout)
                if bold:
                    for name in ("Bold", b"Bold", "SemiBold", b"SemiBold"):
                        try:
                            font.set_variation_by_name(name)
                            break
                        except (OSError, ValueError, AttributeError):
                            continue
                cache[key] = font
            return cache[key]
        return make

    return FontSet(
        caption=factory(caption_path, caption_name.startswith("NotoSans")),
        math=factory(math_path, False),
        label=factory(label_path, False),
    )


def default_fonts() -> FontSet:
    """Font set for unit tests on machines without the production fonts."""
    from PIL import ImageFont

    def make(size: int) -> Any:
        return ImageFont.load_default(size)

    return FontSet(caption=make, math=make, label=make)


# --------------------------------------------------------------------------- #
# Easing and geometry helpers
# --------------------------------------------------------------------------- #

def clamp01(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def ease_out(value: float) -> float:
    value = clamp01(value)
    return 1 - (1 - value) ** 3


def ease_in_out(value: float) -> float:
    value = clamp01(value)
    return 3 * value * value - 2 * value * value * value


def ease_back(value: float) -> float:
    value = clamp01(value)
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (value - 1) ** 3 + c1 * (value - 1) ** 2


def progress(t: float, start: float, length: float) -> float:
    return clamp01((t - start) / max(1e-6, length))


@dataclass
class Layout:
    card_inner: tuple[int, int]
    card_origin: tuple[int, int]
    card_angle: float
    caption_center: tuple[int, int]
    caption_max_width: int
    panel: tuple[int, int, int, int] | None


def layout_for(overlay: dict[str, Any]) -> Layout:
    if overlay["kind"] in ("equation", "groups", "bars", "timeline"):
        return Layout(
            card_inner=(620, 358),
            card_origin=(78, 118),
            card_angle=-1.4,
            caption_center=(402, 566),
            caption_max_width=640,
            panel=(778, 104, 1206, 612),
        )
    return Layout(
        card_inner=(780, 450),
        card_origin=(250, 70),
        card_angle=-1.0,
        caption_center=(640, 628),
        caption_max_width=1000,
        panel=None,
    )


# --------------------------------------------------------------------------- #
# Static layers
# --------------------------------------------------------------------------- #

def paper_background(seed: int) -> Any:
    import numpy as np
    from PIL import Image, ImageDraw

    rng = np.random.default_rng(seed)
    base = np.empty((HEIGHT, WIDTH, 3), dtype=np.float32)
    base[:] = PAPER
    grain = rng.normal(0, 4.0, (HEIGHT, WIDTH, 1)).astype(np.float32)
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    vignette = ((xx - WIDTH / 2) / (WIDTH / 2)) ** 2 + ((yy - HEIGHT / 2) / (HEIGHT / 2)) ** 2
    base = base + grain - (vignette[..., None] * 9.0)
    image = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")
    grid = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(grid)
    for x in range(18, WIDTH, 36):
        draw.line((x, 0, x, HEIGHT), fill=GRID + (70,), width=1)
    for y in range(18, HEIGHT, 36):
        draw.line((0, y, WIDTH, y), fill=GRID + (70,), width=1)
    return Image.alpha_composite(image.convert("RGBA"), grid)


def brush_stroke(length: int, thickness: int, rng: random.Random) -> Any:
    """A horizontal dry-brush stroke with ragged ends and bristle streaks."""
    import numpy as np
    from PIL import Image, ImageFilter

    nprng = np.random.default_rng(rng.randrange(1 << 30))
    alpha = np.zeros((thickness, length), dtype=np.float32)
    streaks = np.clip(nprng.normal(0.9, 0.12, (thickness, 1)), 0.45, 1.0)
    streaks = np.repeat(streaks, length, axis=1)
    streaks *= np.clip(nprng.normal(1.0, 0.08, (thickness, length)), 0.6, 1.1)
    xs = np.arange(length, dtype=np.float32)
    for row in range(thickness):
        start = rng.uniform(0, length * 0.08)
        end = length - rng.uniform(0, length * 0.14)
        fade = np.clip((xs - start) / 24.0, 0, 1) * np.clip((end - xs) / 40.0, 0, 1)
        alpha[row] = fade
    edge = np.minimum(np.arange(thickness), np.arange(thickness)[::-1]).astype(np.float32)
    alpha *= np.clip(edge / 5.0 + nprng.normal(0, 0.3, thickness), 0, 1)[:, None]
    alpha = np.clip(alpha * streaks, 0, 1) * 0.82
    rgba = np.zeros((thickness, length, 4), dtype=np.uint8)
    rgba[..., :3] = BRUSH
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA").filter(ImageFilter.GaussianBlur(0.6))


def brush_frame(box: tuple[int, int, int, int], seed: int) -> Any:
    """Blue-grey brush strokes bracketing a card, as in the reference collage."""
    from PIL import Image

    rng = random.Random(seed)
    layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    strokes = [
        (left - 52, top - 44, int(width * 0.62), 74, rng.uniform(-3, 1)),
        (left + int(width * 0.42), bottom - 22, int(width * 0.66), 70, rng.uniform(-1, 3)),
        (right - 26, top + int(height * 0.08), int(height * 0.82), 62, 90 + rng.uniform(-3, 3)),
        (left - 46, top + int(height * 0.3), int(height * 0.76), 58, 90 + rng.uniform(-3, 3)),
    ]
    for x, y, length, thickness, angle in strokes:
        stroke = brush_stroke(length, thickness, rng).rotate(angle, expand=True, resample=3)
        layer.alpha_composite(stroke, (int(x), int(y)))
    return layer


def full_vignette() -> Any:
    """Darkened, warm edges so a full-bleed photo still reads as printed paper."""
    import numpy as np
    from PIL import Image

    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    distance = ((xx - WIDTH / 2) / (WIDTH / 2)) ** 2 + ((yy - HEIGHT / 2) / (HEIGHT / 2)) ** 2
    alpha = np.clip((distance - 0.55) * 110, 0, 120).astype(np.uint8)
    rgba = np.zeros((HEIGHT, WIDTH, 4), dtype=np.uint8)
    rgba[..., :3] = (40, 30, 20)
    rgba[..., 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def card_frame(inner: tuple[int, int]) -> Any:
    from PIL import Image, ImageDraw, ImageFilter

    border = 14
    width, height = inner[0] + border * 2, inner[1] + border * 2
    pad = 30
    card = Image.new("RGBA", (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("L", card.size, 0)
    ImageDraw.Draw(shadow).rectangle((pad + 8, pad + 12, pad + width + 6, pad + height + 12), fill=95)
    shadow = shadow.filter(ImageFilter.GaussianBlur(11))
    card.paste((30, 26, 20, 255), (0, 0), shadow)
    ImageDraw.Draw(card).rectangle((pad, pad, pad + width - 1, pad + height - 1), fill=CARD_WHITE + (255,))
    return card, (pad + border, pad + border)


def note_sheet(panel: tuple[int, int, int, int], seed: int) -> Any:
    from PIL import Image, ImageDraw, ImageFilter

    left, top, right, bottom = panel
    width, height = right - left, bottom - top
    pad = 28
    sheet = Image.new("RGBA", (width + pad * 2, height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("L", sheet.size, 0)
    ImageDraw.Draw(shadow).rectangle((pad + 6, pad + 10, pad + width + 4, pad + height + 10), fill=70)
    sheet.paste((30, 26, 20, 255), (0, 0), shadow.filter(ImageFilter.GaussianBlur(10)))
    draw = ImageDraw.Draw(sheet)
    draw.rectangle((pad, pad, pad + width, pad + height), fill=(251, 248, 240, 255))
    for y in range(pad + 58, pad + height, 44):
        draw.line((pad + 18, y, pad + width - 18, y), fill=(196, 208, 220, 255), width=1)
    draw.line((pad + 46, pad, pad + 46, pad + height), fill=(226, 170, 160, 255), width=2)
    angle = random.Random(seed).uniform(0.6, 1.4)
    return sheet.rotate(angle, expand=True, resample=3), pad


# --------------------------------------------------------------------------- #
# Text
# --------------------------------------------------------------------------- #

def fit_text(text: str, font_for: Callable[[int], Any], max_width: int, start: int, minimum: int):
    from PIL import Image, ImageDraw

    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    size = start
    while size >= minimum:
        font = font_for(size)
        box = probe.textbbox((0, 0), text, font=font)
        if box[2] - box[0] <= max_width:
            return font, [text]
        size -= 2
    font = font_for(minimum)
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        box = probe.textbbox((0, 0), candidate, font=font)
        if current and box[2] - box[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return font, lines[:2]


def text_image(lines: list[str], font: Any, fill: tuple[int, int, int], align_center: bool = True):
    from PIL import Image, ImageDraw

    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    boxes = [probe.textbbox((0, 0), line, font=font) for line in lines]
    line_height = max(box[3] - box[1] for box in boxes) + 10
    width = max(box[2] - box[0] for box in boxes) + 8
    height = line_height * len(lines) + 12
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for index, (line, box) in enumerate(zip(lines, boxes)):
        line_width = box[2] - box[0]
        x = (width - line_width) / 2 - box[0] if align_center else 4 - box[0]
        draw.text((x, index * line_height + 4 - box[1]), line, font=font, fill=fill + (255,))
    return image


def wipe(image: Any, amount: float) -> Any:
    """Reveal an RGBA image from left to right. Works for every script, because
    shaped Indic clusters are never split into separately drawn characters."""
    if amount >= 1:
        return image
    from PIL import Image

    width = int(image.width * clamp01(amount))
    revealed = Image.new("RGBA", image.size, (0, 0, 0, 0))
    if width > 0:
        revealed.paste(image.crop((0, 0, width, image.height)), (0, 0))
    return revealed


def hand_line(points: list[tuple[float, float]], amount: float) -> list[tuple[float, float]]:
    if amount <= 0 or len(points) < 2:
        return []
    count = max(2, int(len(points) * clamp01(amount)))
    return points[:count]


def wavy_points(x0: float, y0: float, x1: float, y1: float, seed: int, steps: int = 40):
    rng = random.Random(seed)
    phase = rng.uniform(0, math.pi)
    return [
        (
            x0 + (x1 - x0) * i / steps,
            y0 + (y1 - y0) * i / steps + math.sin(phase + i / steps * math.pi * 2.2) * 2.2,
        )
        for i in range(steps + 1)
    ]


def ellipse_points(box: tuple[float, float, float, float], seed: int, steps: int = 64):
    rng = random.Random(seed)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    rx, ry = (box[2] - box[0]) / 2, (box[3] - box[1]) / 2
    start = rng.uniform(-2.6, -2.2)
    points = []
    for i in range(steps + 1):
        angle = start + i / steps * math.pi * 2.15
        wobble = 1 + 0.035 * math.sin(i * 0.7 + start)
        points.append((cx + math.cos(angle) * rx * wobble, cy + math.sin(angle) * ry * wobble))
    return points


# --------------------------------------------------------------------------- #
# Overlays
# --------------------------------------------------------------------------- #

def draw_arrow(canvas: Any, card_box: tuple[int, int, int, int], direction: str, amount: float) -> None:
    from PIL import ImageDraw

    if amount <= 0:
        return
    (sx, sy), (ex, ey) = ARROW_DIRECTIONS[direction]
    left, top, right, bottom = card_box
    width, height = right - left, bottom - top
    start = (left + sx * width, top + sy * height)
    end = (left + ex * width, top + ey * height)
    tip = (start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount)
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.line((start, tip), fill=(250, 246, 238, 220), width=19)
    draw.line((start, tip), fill=RED + (255,), width=10)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    head = 38 * ease_out(progress(amount, 0.55, 0.45))
    if head > 2:
        back = (tip[0] - math.cos(angle) * head, tip[1] - math.sin(angle) * head)
        normal = (-math.sin(angle) * head * 0.62, math.cos(angle) * head * 0.62)
        polygon = [
            (tip[0] + math.cos(angle) * 8, tip[1] + math.sin(angle) * 8),
            (back[0] + normal[0], back[1] + normal[1]),
            (back[0] - normal[0], back[1] - normal[1]),
        ]
        draw.polygon(polygon, fill=RED + (255,), outline=(250, 246, 238, 230))


class EquationOverlay:
    def __init__(self, steps: list[str], panel: tuple[int, int, int, int], fonts: FontSet, seed: int):
        self.panel = panel
        inner_width = panel[2] - panel[0] - 90
        self.images = []
        self.muted = []
        for step in steps:
            font, lines = fit_text(display_math(step), fonts.math, inner_width, 56, 28)
            self.images.append(text_image(lines[:1], font, INK))
            self.muted.append(text_image(lines[:1], font, MUTED_INK))
        self.seed = seed

    def draw(self, canvas: Any, t: float, duration: float) -> None:
        from PIL import Image, ImageDraw

        count = len(self.images)
        left, top, right, bottom = self.panel
        center_x = (left + right) // 2 + 18
        window_start, window_end = 0.9, max(1.6, duration - TRANSITION_SECONDS - 1.6)
        slot = (window_end - window_start) / count
        spacing = min(110, (bottom - top - 60) // max(1, count))
        first_y = top + (bottom - top - spacing * (count - 1)) // 2
        draw = ImageDraw.Draw(canvas, "RGBA")
        for index, (image, muted) in enumerate(zip(self.images, self.muted)):
            appear = window_start + index * slot
            amount = ease_out(progress(t, appear, 0.55))
            if amount <= 0:
                continue
            y = first_y + index * spacing
            later = index < count - 1 and t >= window_start + (index + 1) * slot
            fade = ease_in_out(progress(t, window_start + (index + 1) * slot, 0.4)) if later else 0
            revealed = wipe(image, amount)
            if fade > 0:
                revealed = Image.blend(revealed, wipe(muted, amount), fade)
            canvas.alpha_composite(revealed, (int(center_x - image.width / 2), int(y - image.height / 2)))
            if index > 0:
                arrow_y = y - spacing / 2
                arrow_amount = ease_out(progress(t, appear - 0.15, 0.3))
                if arrow_amount > 0:
                    draw.line(
                        (center_x, arrow_y - 16, center_x, arrow_y - 16 + 26 * arrow_amount),
                        fill=RED + (255,), width=4,
                    )
                    if arrow_amount > 0.8:
                        draw.polygon(
                            [(center_x - 9, arrow_y + 4), (center_x + 9, arrow_y + 4), (center_x, arrow_y + 16)],
                            fill=RED + (255,),
                        )
            if index == count - 1:
                circle_amount = ease_in_out(progress(t, appear + 0.6, 0.7))
                if circle_amount > 0:
                    box = (
                        center_x - image.width / 2 - 26, y - image.height / 2 - 14,
                        center_x + image.width / 2 + 26, y + image.height / 2 + 14,
                    )
                    points = hand_line(ellipse_points(box, self.seed), circle_amount)
                    if len(points) > 1:
                        draw.line(points, fill=RED + (255,), width=5, joint="curve")


class GroupsOverlay:
    def __init__(self, overlay: dict[str, Any], panel: tuple[int, int, int, int], fonts: FontSet):
        self.groups = overlay["groups"]
        self.show_total = overlay["showTotal"]
        self.panel = panel
        self.fonts = fonts
        left, top, right, bottom = panel
        count = len(self.groups)
        columns = 1 if count == 1 else 2 if count in (2, 4) else 3 if count <= 3 else 3
        rows = math.ceil(count / columns)
        area_top, area_bottom = top + 40, bottom - (120 if self.show_total else 60)
        content_left = left + 70
        cell_w = (right - content_left - 24) / columns
        cell_h = (area_bottom - area_top) / rows
        self.cells = []
        for index, group in enumerate(self.groups):
            column, row = index % columns, index // columns
            cx = content_left + cell_w * (column + 0.5)
            cy = area_top + cell_h * (row + 0.5)
            per_row = math.ceil(math.sqrt(group["count"]))
            item_rows = math.ceil(group["count"] / per_row)
            radius = max(12, min(30, int(min(cell_w / (per_row * 2.7), (cell_h - 50) / (item_rows * 2.7)))))
            gap = radius * 2.6
            positions = []
            for item in range(group["count"]):
                ix, iy = item % per_row, item // per_row
                positions.append((
                    cx + (ix - (per_row - 1) / 2) * gap,
                    cy - 14 + (iy - (item_rows - 1) / 2) * gap,
                ))
            box = (
                cx - per_row * gap / 2 - 8, cy - 14 - item_rows * gap / 2 - 8,
                cx + per_row * gap / 2 + 8, cy - 14 + item_rows * gap / 2 + 8,
            )
            self.cells.append({"positions": positions, "radius": radius, "box": box, "center": (cx, box[3] + 26)})
        self.total = sum(group["count"] for group in self.groups)

    def draw(self, canvas: Any, t: float, duration: float) -> None:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(canvas, "RGBA")
        window_start = 0.8
        window_end = max(1.6, duration - TRANSITION_SECONDS - (2.0 if self.show_total else 1.2))
        per_item = (window_end - window_start) / max(1, self.total)
        index = 0
        for group_index, (group, cell) in enumerate(zip(self.groups, self.cells)):
            color = PALETTE[group_index % len(PALETTE)]
            radius = cell["radius"]
            group_done = window_start + (index + group["count"]) * per_item
            for x, y in cell["positions"]:
                scale = ease_back(progress(t, window_start + index * per_item, 0.3))
                index += 1
                if scale <= 0:
                    continue
                r = radius * scale
                if group["token"]:
                    draw.rounded_rectangle((x - r, y - r, x + r, y + r), radius=r * 0.3, fill=color + (255,))
                    if scale > 0.8:
                        font = self.fonts.math(int(radius * 1.1))
                        draw.text((x, y), group["token"], font=font, fill=CARD_WHITE + (255,), anchor="mm")
                else:
                    draw.ellipse((x - r, y - r, x + r, y + r), fill=color + (255,))
            outline = ease_in_out(progress(t, group_done, 0.4))
            if outline > 0:
                box = cell["box"]
                points = [(box[0], box[1]), (box[2], box[1]), (box[2], box[3]), (box[0], box[3]), (box[0], box[1])]
                segments = int(outline * 4 * 10)
                path = []
                for s in range(segments + 1):
                    side, part = divmod(s, 10)
                    if side >= 4:
                        break
                    a, b = points[side], points[side + 1]
                    path.append((a[0] + (b[0] - a[0]) * part / 10, a[1] + (b[1] - a[1]) * part / 10))
                if len(path) > 1:
                    draw.line(path, fill=color + (200,), width=3, joint="curve")
                label = self.fonts.math(30)
                if outline > 0.9:
                    draw.text(cell["center"], str(group["count"]), font=label, fill=INK + (255,), anchor="mm")
        if self.show_total:
            amount = ease_out(progress(t, window_end + 0.3, 0.5))
            if amount > 0:
                font = self.fonts.math(54)
                token = self.groups[0]["token"]
                text = f"= {self.total}{token}" if token and token != "1" else f"= {self.total}"
                image = text_image([text], font, RED)
                left, _top, right, bottom = self.panel
                canvas.alpha_composite(
                    wipe(image, amount), (int((left + right) / 2 - image.width / 2), int(bottom - 96))
                )


class TimelineOverlay:
    """A vertical timeline on the notebook sheet; this scene's year is highlighted."""

    def __init__(self, overlay: dict[str, Any], panel: tuple[int, int, int, int], fonts: FontSet):
        self.years = overlay["years"]
        self.current = overlay["current"]
        self.panel = panel
        self.fonts = fonts

    @staticmethod
    def label(year: int) -> str:
        return f"{-year} BCE" if year < 0 else str(year)

    def draw(self, canvas: Any, t: float, duration: float) -> None:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(canvas, "RGBA")
        left, top, right, bottom = self.panel
        axis_x = left + 130
        first_y, last_y = top + 70, bottom - 70
        line_amount = ease_in_out(progress(t, 0.7, 0.8))
        if line_amount <= 0:
            return
        draw.line((axis_x, first_y, axis_x, first_y + (last_y - first_y) * line_amount), fill=INK + (255,), width=4)
        count = len(self.years)
        step = (last_y - first_y) / max(1, count - 1)
        window_end = max(2.0, duration - TRANSITION_SECONDS - 1.4)
        per_year = (window_end - 1.2) / count
        for index, year in enumerate(self.years):
            y = first_y + index * step
            appear = ease_back(progress(t, 1.2 + index * per_year, 0.35))
            if appear <= 0:
                continue
            is_current = year == self.current
            radius = (15 if is_current else 9) * appear
            color = RED if is_current else (INK if year < self.current else MUTED_INK)
            draw.ellipse((axis_x - radius, y - radius, axis_x + radius, y + radius), fill=color + (255,))
            if appear > 0.8:
                font = self.fonts.math(44 if is_current else 32)
                draw.text((axis_x + 36, y), self.label(year), font=font, fill=color + (255,), anchor="lm")
            if is_current:
                ring = ease_in_out(progress(t, 1.2 + index * per_year + 0.4, 0.6))
                if ring > 0:
                    box = (axis_x - 30, y - 30, axis_x + 190, y + 30)
                    points = hand_line(ellipse_points(box, year), ring)
                    if len(points) > 1:
                        draw.line(points, fill=RED + (255,), width=4, joint="curve")


class BarsOverlay:
    def __init__(self, overlay: dict[str, Any], panel: tuple[int, int, int, int], fonts: FontSet):
        self.values = overlay["values"]
        self.unit = overlay["unit"]
        self.panel = panel
        self.fonts = fonts

    def draw(self, canvas: Any, t: float, duration: float) -> None:
        from PIL import ImageDraw

        draw = ImageDraw.Draw(canvas, "RGBA")
        left, top, right, bottom = self.panel
        base_y = bottom - 60
        chart_top = top + 80
        axis_amount = ease_out(progress(t, 0.6, 0.4))
        draw.line((left + 40, base_y, left + 40 + (right - left - 80) * axis_amount, base_y), fill=INK + (255,), width=3)
        count = len(self.values)
        slot = (right - left - 100) / count
        bar_width = slot * 0.56
        maximum = max(self.values)
        window_end = max(1.8, duration - TRANSITION_SECONDS - 1.2)
        per_bar = (window_end - 1.0) / count
        font = self.fonts.math(28)
        for index, value in enumerate(self.values):
            grow = ease_out(progress(t, 1.0 + index * per_bar, per_bar * 0.9))
            if grow <= 0:
                continue
            x0 = left + 60 + index * slot + (slot - bar_width) / 2
            height = (base_y - chart_top) * (value / maximum) * grow
            color = PALETTE[0] if index % 2 == 0 else BRUSH
            draw.rectangle((x0, base_y - height, x0 + bar_width, base_y - 2), fill=color + (255,))
            if grow > 0.95:
                draw.text(
                    (x0 + bar_width / 2, base_y - height - 22), format_value(value, self.unit),
                    font=font, fill=INK + (255,), anchor="mm",
                )


# --------------------------------------------------------------------------- #
# Clip decoding and scene rendering
# --------------------------------------------------------------------------- #

def decode_clip(path: Path, size: tuple[int, int]) -> list[bytes]:
    width, height = size
    video_filter = (
        "eq=saturation=0.86:contrast=1.03,colorbalance=rs=0.03:bs=-0.03,"
        f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}"
    )
    try:
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-vf", video_filter,
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            check=True, capture_output=True, timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CompositorError("clip_decode_failed", f"Could not decode animated clip: {error}") from error
    frame_size = width * height * 3
    frames = [result.stdout[i:i + frame_size] for i in range(0, len(result.stdout), frame_size)]
    frames = [frame for frame in frames if len(frame) == frame_size]
    if len(frames) < 8:
        raise CompositorError("clip_too_short", "Animated clip has too few frames to composite")
    return frames


class SceneRenderer:
    def __init__(
        self, *, frames: list[bytes], caption: str, overlay: dict[str, Any], fonts: FontSet,
        scene_index: int, scene_count: int, duration: float,
    ):
        from PIL import Image

        self.frames = frames
        self.duration = duration
        self.total = duration + TRANSITION_SECONDS
        self.overlay = overlay
        self.layout = layout_for(overlay)
        self.scene_index = scene_index
        self.scene_count = scene_count
        seed = 7331 * scene_index + 17

        inner_w, inner_h = self.layout.card_inner
        self.card_template, self.card_offset = card_frame(self.layout.card_inner)
        ox, oy = self.layout.card_origin
        self.card_box = (ox, oy, ox + inner_w + 28, oy + inner_h + 28)
        self.background = paper_background(seed)
        self.brush = brush_frame(self.card_box, seed)
        self.sheet = None
        if self.layout.panel:
            self.sheet, pad = note_sheet(self.layout.panel, seed)
            self.sheet_origin = (self.layout.panel[0] - pad - 6, self.layout.panel[1] - pad - 6)
            self.panel_brush = brush_frame(self.layout.panel, seed + 1)

        self.caption_image = None
        if caption.strip():
            font, lines = fit_text(caption.strip(), fonts.caption, self.layout.caption_max_width, 50, 30)
            self.caption_image = text_image(lines, font, INK)
        self.counter = text_image([f"{scene_index:02d} / {scene_count:02d}"], fonts.label(28), MUTED_INK)
        self.underline_seed = seed + 3

        if overlay["kind"] == "equation":
            self.overlay_renderer = EquationOverlay(overlay["steps"], self.layout.panel, fonts, seed)
        elif overlay["kind"] == "groups":
            self.overlay_renderer = GroupsOverlay(overlay, self.layout.panel, fonts)
        elif overlay["kind"] == "bars":
            self.overlay_renderer = BarsOverlay(overlay, self.layout.panel, fonts)
        elif overlay["kind"] == "timeline":
            self.overlay_renderer = TimelineOverlay(overlay, self.layout.panel, fonts)
        else:
            self.overlay_renderer = None
        self._static: Any = None
        self._image_mod = Image
        self._plan_shots()
        self.bleed_vignette = full_vignette()
        self.bleed_brush = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        stroke = brush_stroke(420, 64, random.Random(seed + 9)).rotate(-4, expand=True, resample=3)
        self.bleed_brush.alpha_composite(stroke, (WIDTH - stroke.width + 60, -14))

    def _static_layers(self, t: float) -> Any:
        """Paper + brush + note sheet. Cached once every reveal has finished."""
        if self._static is not None:
            return self._static.copy()
        canvas = self.background.copy()
        brush_amount = ease_out(progress(t, 0.05, 0.6))
        canvas.alpha_composite(wipe(self.brush, brush_amount))
        if self.sheet is not None:
            sheet_amount = ease_out(progress(t, 0.35, 0.5))
            canvas.alpha_composite(wipe(self.panel_brush, sheet_amount))
            if sheet_amount > 0:
                offset = int((1 - sheet_amount) * 60)
                sheet = self.sheet.copy()
                if sheet_amount < 1:
                    alpha = sheet.getchannel("A").point(lambda value: int(value * sheet_amount))
                    sheet.putalpha(alpha)
                canvas.alpha_composite(sheet, (self.sheet_origin[0] + offset, self.sheet_origin[1]))
        if brush_amount >= 1 and (self.sheet is None or progress(t, 0.35, 0.5) >= 1):
            self._static = canvas.copy()
        return canvas

    # ------------------------------------------------------------------ #
    # Shot plan. The reference cuts every 2-3 s and pushes the camera hard
    # into the photo until the moving subject fills the screen. Each scene
    # therefore has a collage shot and a full-bleed shot joined by a fast
    # push-through; odd scenes open on the collage, even scenes open
    # full-bleed so consecutive scenes never feel alike.
    # ------------------------------------------------------------------ #
    PUSH = 0.45

    def _plan_shots(self) -> None:
        if self.scene_index % 2 == 1:
            self.bleed_window = (2.5, 5.0)
            self.layout_clock_offset = 0.0
        else:
            self.bleed_window = (0.0, 2.3)
            # The collage appears already assembled after the opening close-up.
            self.layout_clock_offset = 0.7 - 2.3

    def _layout_clock(self, t: float) -> float:
        """Collage animations (caption, math) pause while the collage is off screen."""
        start, end = self.bleed_window
        if start == 0.0:
            return max(0.0, t + self.layout_clock_offset)
        if t < start:
            return t
        if t < end:
            return start
        return t - (end - start)

    def _layout_total(self) -> float:
        start, end = self.bleed_window
        if start == 0.0:
            return self.total + self.layout_clock_offset
        return self.total - (end - start)

    def _mix(self, t: float) -> tuple[float, float]:
        """Return (bleed weight, push amount toward the card) at time t."""
        start, end = self.bleed_window
        push_in = start > 0 and start - self.PUSH <= t < start
        pull_out = end <= t < end + self.PUSH
        if start <= t < end:
            return 1.0, 1.0
        if push_in:
            push = ease_in_out((t - (start - self.PUSH)) / self.PUSH)
        elif pull_out:
            push = 1 - ease_in_out((t - end) / self.PUSH)
        else:
            return 0.0, 0.0
        return clamp01((push - 0.55) / 0.45), push

    def _source(self, t: float) -> Any:
        from PIL import Image

        playable = max(1.0, self.duration - 0.3)
        index = min(len(self.frames) - 1, int(t / playable * len(self.frames)))
        return Image.frombuffer("RGB", (WIDTH, HEIGHT), self.frames[index], "raw", "RGB", 0, 1)

    def frame(self, t: float) -> Any:
        from PIL import Image

        source = self._source(t)
        weight, push = self._mix(t)
        if weight >= 1:
            return self._bleed_frame(t, source)
        layout = self._layout_frame(t, source, push)
        if weight <= 0:
            return layout
        return Image.blend(layout, self._bleed_frame(t, source), weight)

    def _bleed_frame(self, t: float, source: Any) -> Any:
        """Full-screen moving photo with a slow drift, arrow sweep and caption strip."""
        from PIL import Image, ImageDraw

        start, end = self.bleed_window
        local = clamp01((t - start) / max(0.1, end - start + self.PUSH))
        zoom = 1.02 + 0.09 * ease_in_out(local)
        drift = (-1 if self.scene_index % 4 in (1, 2) else 1) * 18 * ease_in_out(local)
        crop_w, crop_h = WIDTH / zoom, HEIGHT / zoom
        left = (WIDTH - crop_w) / 2 + drift
        top = (HEIGHT - crop_h) / 2
        image = source.resize((WIDTH, HEIGHT), Image.BILINEAR, box=(left, top, left + crop_w, top + crop_h))
        canvas = image.convert("RGBA")
        canvas.alpha_composite(self.bleed_vignette)
        canvas.alpha_composite(self.bleed_brush, (0, 0))

        if self.overlay["kind"] == "arrow":
            amount = ease_in_out(progress(t, start + 0.3, 1.3))
            draw_arrow(canvas, (90, 70, WIDTH - 90, HEIGHT - 150), self.overlay["direction"], amount)

        if self.caption_image is not None:
            amount = ease_out(progress(t, start + 0.4, 0.7))
            if amount > 0:
                strip_w = self.caption_image.width + 60
                strip_h = self.caption_image.height + 30
                x = 56 - int((1 - amount) * 40)
                y = HEIGHT - strip_h - 44
                strip = Image.new("RGBA", (strip_w, strip_h), PAPER + (238,))
                canvas.alpha_composite(strip, (x, y))
                canvas.alpha_composite(wipe(self.caption_image, amount), (x + 30, y + 12))
                underline = hand_line(
                    wavy_points(x + 34, y + strip_h - 12, x + strip_w - 34, y + strip_h - 14, self.underline_seed),
                    ease_in_out(progress(t, start + 0.9, 0.5)),
                )
                if len(underline) > 1:
                    ImageDraw.Draw(canvas).line(underline, fill=RED + (255,), width=4, joint="curve")
        return canvas.convert("RGB")

    def _layout_frame(self, t: float, source: Any, push: float) -> Any:
        from PIL import Image, ImageDraw

        lt = self._layout_clock(t)
        canvas = self._static_layers(lt)

        clip = source.resize(self.layout.card_inner, Image.BILINEAR)
        card = self.card_template.copy()
        card.paste(clip, self.card_offset)
        enter = ease_out(progress(lt, 0.0, 0.6))
        angle = self.layout.card_angle * (1 - push) - (1 - enter) * 2.5
        rotated = card.rotate(angle, expand=True, resample=Image.BICUBIC)
        if enter < 1:
            rotated.putalpha(rotated.getchannel("A").point(lambda value: int(value * enter)))
        cx = self.card_box[0] + (self.card_box[2] - self.card_box[0]) / 2
        cy = self.card_box[1] + (self.card_box[3] - self.card_box[1]) / 2 + (1 - enter) * 36
        canvas.alpha_composite(rotated, (int(cx - rotated.width / 2), int(cy - rotated.height / 2)))

        start, end = self.bleed_window
        if self.overlay["kind"] == "arrow" and t >= end:
            draw_arrow(canvas, self.card_box, self.overlay["direction"], 1.0)
        elif self.overlay_renderer is not None:
            self.overlay_renderer.draw(canvas, lt, self._layout_total())

        counter_amount = ease_out(progress(lt, 0.2, 0.5))
        if counter_amount > 0:
            canvas.alpha_composite(wipe(self.counter, counter_amount), (54, 22))
            ImageDraw.Draw(canvas).line((58, 62, 58 + 46 * counter_amount, 62), fill=RED + (255,), width=4)

        if self.caption_image is not None:
            caption_amount = ease_out(progress(lt, 0.55, 0.9))
            if caption_amount > 0:
                ccx, ccy = self.layout.caption_center
                x = int(ccx - self.caption_image.width / 2)
                y = int(ccy - self.caption_image.height / 2)
                canvas.alpha_composite(wipe(self.caption_image, caption_amount), (x, y))
                underline = hand_line(
                    wavy_points(x + 6, y + self.caption_image.height + 4,
                                x + self.caption_image.width - 6, y + self.caption_image.height + 2,
                                self.underline_seed),
                    ease_in_out(progress(lt, 1.2, 0.6)),
                )
                if len(underline) > 1:
                    ImageDraw.Draw(canvas).line(underline, fill=INK + (255,), width=3, joint="curve")

        # Camera: a visible push-in on the collage (8%), and during a shot change
        # a fast push all the way into the card so it hands over to full-bleed.
        base_zoom = 1 + 0.08 * ease_in_out(lt / max(0.1, self._layout_total()))
        card_w = self.card_box[2] - self.card_box[0]
        card_h = self.card_box[3] - self.card_box[1]
        fill_zoom = min(WIDTH / card_w, HEIGHT / card_h) * 1.03
        base_fx = cx * 0.35 + WIDTH / 2 * 0.65
        base_fy = cy * 0.35 + HEIGHT / 2 * 0.65
        # A long collage shot gets a second framing: a reframe onto the notebook
        # math (or onto the card) so the view keeps changing every ~2.5 s.
        if self.bleed_window[0] == 0.0:
            reframe = ease_in_out(progress(t, self.bleed_window[1] + 2.7, 0.6))
            if self.layout.panel:
                px0, py0, px1, py1 = self.layout.panel
                target = ((px0 + px1) / 2, (py0 + py1) / 2, 1.28)
            else:
                target = (cx, cy + 40, 1.16)
            base_fx += (target[0] - base_fx) * reframe
            base_fy += (target[1] - base_fy) * reframe
            base_zoom += (target[2] - base_zoom) * reframe
        zoom = base_zoom + (fill_zoom - base_zoom) * push
        focus_x = base_fx + (cx - base_fx) * push
        focus_y = base_fy + (cy - base_fy) * push
        crop_w, crop_h = WIDTH / zoom, HEIGHT / zoom
        left = min(max(0, focus_x - crop_w / 2), WIDTH - crop_w)
        top = min(max(0, focus_y - crop_h / 2), HEIGHT - crop_h)
        return canvas.convert("RGB").resize(
            (WIDTH, HEIGHT), Image.BILINEAR, box=(left, top, left + crop_w, top + crop_h)
        )


def render_editorial_scene(
    raw_clip: Path, output: Path, *, caption: str, language_code: str, overlay: Any,
    scene_index: int, scene_count: int, duration: float, fonts_dir: Path,
    fonts: FontSet | None = None, should_stop: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    safe_overlay, warning = sanitize_overlay(overlay)
    font_set = fonts or load_fonts(fonts_dir, language_code)
    frames = decode_clip(raw_clip, (WIDTH, HEIGHT))
    renderer = SceneRenderer(
        frames=frames, caption=caption, overlay=safe_overlay, fonts=font_set,
        scene_index=scene_index, scene_count=scene_count, duration=duration,
    )
    total_frames = round((duration + TRANSITION_SECONDS) * FPS)
    output.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-", "-an",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(output)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        assert process.stdin is not None
        for frame_index in range(total_frames):
            if should_stop and frame_index % FPS == 0 and should_stop():
                raise CompositorError("cancelled", "Cancellation requested during compositing")
            process.stdin.write(renderer.frame(frame_index / FPS).tobytes())
        process.stdin.close()
        stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        if process.wait(timeout=180) != 0:
            raise CompositorError("composite_encode_failed", f"ffmpeg failed: {stderr[-1200:]}")
    except BrokenPipeError as error:
        stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
        raise CompositorError("composite_encode_failed", f"ffmpeg closed early: {stderr[-1200:]}") from error
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        if process.stderr:
            process.stderr.close()
    return {
        "visual_mode": "editorial-composite",
        "overlay_kind": safe_overlay["kind"],
        "overlay_warning": warning,
        "composite_seconds": round(total_frames / FPS, 3),
        "source_frames": len(frames),
        "resolution": f"{WIDTH}x{HEIGHT}",
        "fps": FPS,
    }
