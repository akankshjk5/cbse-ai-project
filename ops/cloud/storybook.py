"""Storybook presentation for the cloud lesson compositor.

A storybook scene is 2-3 full-frame engraving shots shown while one sentence
is spoken. This module draws it: a slow camera move on every shot, dissolves
between shots, a chapter banner over the first shot, a small caption, the
exact teaching overlay when the scene has one, and one paper/ink finish over
every frame so stills and provider clips look like the same printed page.
Assembly dissolves scene into scene and lays an optional music bed under the
narration, ducked whenever the voice speaks.

Timing never moves: every scene's sentence starts on its 7.5-second boundary.
A scene is rendered 0.5 s longer than its slot (the "tail") and the next scene
dissolves in over that tail, so the final film is still exactly 30 or 60 s.

Only the storybook style comes here (compositor.main dispatches on
visualStyle); the editorial and illustrated styles are untouched.
"""
from __future__ import annotations

import math
import random
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps, features

import compositor as base

WIDTH, HEIGHT, FPS = base.WIDTH, base.HEIGHT, base.FPS
SLOT_SECONDS = base.SLOT_SECONDS
TAIL_SECONDS = 0.5
SCENE_SECONDS = SLOT_SECONDS + TAIL_SECONDS
SCENE_FRAMES = int(round(SCENE_SECONDS * FPS))  # 192
DISSOLVE_SECONDS = 0.5
# An animated first shot keeps the screen for most of its 5-second clip.
ANIMATED_FIRST_SHOT_SECONDS = 4.75

INK = (43, 33, 24)
PAPER = (241, 226, 194)
CAMERA_MOVES = {"push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down"}
TITLE_FONT = "StorybookTitle.ttf"  # optional serif display face; falls back to the language's caption font
MUSIC_LEVEL = 0.16  # music bed linear gain before ducking (about -16 dB)


# ── Timing ──────────────────────────────────────────────────────────────────

def shot_spans(count: int, animated: bool) -> list[tuple[float, float]]:
    """Visible [start, end) of each shot inside the 8-second scene, overlapping by one dissolve.

    Boundaries split the 7.5-second slot evenly; an animated scene gives its first
    (provider-animated) shot most of its clip. The last shot runs into the tail.
    """
    if not 1 <= count <= 3:
        raise ValueError("A storybook scene has one to three shots")
    first = ANIMATED_FIRST_SHOT_SECONDS if animated and count > 1 else SLOT_SECONDS / count
    rest = (SLOT_SECONDS - first) / (count - 1) if count > 1 else 0
    cuts = [0.0] + [first + rest * i for i in range(count - 1)] + [SCENE_SECONDS]
    half = DISSOLVE_SECONDS / 2
    return [(max(0.0, cuts[i] - (half if i else 0)), min(SCENE_SECONDS, cuts[i + 1] + (half if i + 1 < count else 0)))
            for i in range(count)]


def ease(x: float) -> float:
    """Smooth in-out, so a move starts and stops without a jolt."""
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


# ── Camera ──────────────────────────────────────────────────────────────────

def camera_box(move: str, progress: float, size: tuple[int, int]) -> tuple[float, float, float, float]:
    """The source rectangle to show at `progress` (0-1) of a shot. Always 16:9 and inside the picture."""
    if move not in CAMERA_MOVES:
        move = "push_in"
    width, height = size
    p = ease(progress)
    if move in ("push_in", "pull_out"):
        zoom = 1.0 + 0.10 * (p if move == "push_in" else 1 - p)
        w, h = width / zoom, height / zoom
        return ((width - w) / 2, (height - h) / 2, (width + w) / 2, (height + h) / 2)
    zoom = 1.12
    w, h = width / zoom, height / zoom
    if move in ("pan_left", "pan_right"):
        travel = width - w
        x = travel * (1 - p if move == "pan_left" else p)
        return (x, (height - h) / 2, x + w, (height + h) / 2)
    travel = height - h
    y = travel * (1 - p if move == "tilt_up" else p)
    return ((width - w) / 2, y, (width + w) / 2, y + h)


# ── Finish: one look for every frame ────────────────────────────────────────

def sepia_lut() -> list[int]:
    """Grey → ink-on-paper ramp, as an RGB point table."""
    table: list[int] = []
    for channel in range(3):
        table.extend(round(INK[channel] + (PAPER[channel] - INK[channel]) * (v / 255) ** 0.92) for v in range(256))
    return table


SEPIA = sepia_lut()


def grade(image: Image.Image) -> Image.Image:
    """Force the engraving palette: whatever colour a model drew, the page is ink on paper."""
    return image.convert("L").convert("RGB").point(SEPIA)


def finish_layers(seed: int, count: int = 4) -> list[Image.Image]:
    """Frames multiplied over every picture: vignette, paper grain and a few fixed ink specks.

    `count` grain variants are cycled so the paper texture lives slightly, like film.
    """
    rng = random.Random(seed)
    vignette = Image.new("L", (WIDTH // 4, HEIGHT // 4), 0)
    pixels = vignette.load()
    for y in range(vignette.height):
        for x in range(vignette.width):
            dx, dy = (x / vignette.width - 0.5) / 0.5, (y / vignette.height - 0.5) / 0.5
            pixels[x, y] = int(255 * (1 - 0.30 * min(1.0, (dx * dx * 0.8 + dy * dy) ** 1.6)))
    vignette = vignette.resize((WIDTH, HEIGHT), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(8))
    specks = Image.new("L", (WIDTH, HEIGHT), 255)
    draw = ImageDraw.Draw(specks)
    for _ in range(18):
        x, y, r = rng.randrange(WIDTH), rng.randrange(HEIGHT), rng.uniform(0.8, 2.2)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=rng.randrange(120, 190))
    for _ in range(4):
        x, y = rng.randrange(WIDTH), rng.randrange(HEIGHT)
        draw.line((x, y, x + rng.randrange(-40, 40), y + rng.randrange(-40, 40)), fill=200, width=1)
    layers = []
    for _ in range(count):
        noise = Image.effect_noise((WIDTH // 2, HEIGHT // 2), 26).resize((WIDTH, HEIGHT), Image.Resampling.BILINEAR)
        grain = noise.point(lambda v: 255 - max(0, (v - 128)) // 6)  # light: only darkens, at most ~8%
        combined = ImageChops.multiply(ImageChops.multiply(vignette, grain), specks)
        layers.append(Image.merge("RGB", (combined, combined, combined)))
    return layers


# ── Text ────────────────────────────────────────────────────────────────────

def title_font(config: dict, language: str, size: int):
    path = Path(config["fontsDir"]) / TITLE_FONT
    if language == "en-IN" and path.is_file():
        return ImageFont.truetype(str(path), size)
    return base.font(config, language, size)


def banner_layer(title: str, config: dict, language: str) -> Image.Image:
    """A swallow-tailed parchment ribbon with a double ink rule, centred in the top band."""
    layer = Image.new("RGBA", (WIDTH, HEIGHT))
    title = title.strip()
    if not title:
        return layer
    measure = ImageDraw.Draw(layer)
    for size in range(68, 39, -2):
        face = title_font(config, language, size)
        if measure.textlength(title, font=face) <= 1180:
            break
    else:
        raise ValueError("Chapter title cannot fit legibly")
    text_width = measure.textlength(title, font=face)
    half = text_width / 2 + 70
    cx, top, bottom = WIDTH / 2, 70, 70 + size + 54
    mid = (top + bottom) / 2
    notch = 34
    ribbon = [(cx - half - 60, top + 14), (cx - half, top), (cx + half, top), (cx + half + 60, top + 14),
              (cx + half + 60 - notch, mid + 7), (cx + half + 60, bottom + 14), (cx + half, bottom),
              (cx - half, bottom), (cx - half - 60, bottom + 14), (cx - half - 60 + notch, mid + 7)]
    draw = ImageDraw.Draw(layer)
    draw.polygon([(x + 6, y + 8) for x, y in ribbon], fill=(*INK, 70))  # soft shadow
    draw.polygon(ribbon, fill=(*PAPER, 245), outline=(*INK, 255), width=4)
    draw.rectangle((cx - half + 14, top + 12, cx + half - 14, bottom - 12), outline=(*INK, 200), width=2)
    for x in (cx - half + 28, cx + half - 28):
        draw.polygon([(x, mid - 9), (x + 9, mid), (x, mid + 9), (x - 9, mid)], fill=(*INK, 230))
    draw.text((cx, mid), title, font=face, fill=(*INK, 255), anchor="mm")
    return layer


def caption_strip(caption: str, config: dict, language: str) -> Image.Image:
    """A quiet one-line caption at the foot of the page."""
    layer = Image.new("RGBA", (WIDTH, HEIGHT))
    caption = caption.strip()
    if not caption:
        return layer
    draw = ImageDraw.Draw(layer)
    for size in range(46, 31, -2):
        face = base.font(config, language, size)
        if draw.textlength(caption, font=face) <= 1500:
            break
    else:
        raise ValueError("Caption cannot fit legibly")
    width = draw.textlength(caption, font=face) + 80
    y = HEIGHT - 92
    draw.rounded_rectangle((WIDTH / 2 - width / 2, y - size * 0.75, WIDTH / 2 + width / 2, y + size * 0.75),
                           radius=10, fill=(*PAPER, 215), outline=(*INK, 160), width=2)
    draw.text((WIDTH / 2, y), caption, font=face, fill=(*INK, 255), anchor="mm")
    return layer


def fade(layer: Image.Image, amount: float) -> Image.Image:
    if amount >= 1:
        return layer
    alpha = layer.getchannel("A").point(lambda v: int(v * max(0.0, amount)))
    faded = layer.copy()
    faded.putalpha(alpha)
    return faded


def window(t: float, start: float, end: float, ramp: float = 0.35) -> float:
    """0 outside [start, end], rising and falling over `ramp` seconds at the edges."""
    if t <= start or t >= end:
        return 0.0
    return min(1.0, (t - start) / ramp, (end - t) / ramp)


# ── Scene ───────────────────────────────────────────────────────────────────

def load_shot(path: str) -> Image.Image:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width < WIDTH or image.height < HEIGHT:
        raise ValueError("Storybook shot is below 1080p")
    if abs(image.width / image.height - 16 / 9) > 0.05:
        raise ValueError("Storybook shot must be widescreen")
    return grade(image)


def render_scene(config: dict) -> dict:
    scene = config["scene"]
    if float(scene["duration_seconds"]) != SLOT_SECONDS:
        raise ValueError("Scene slot must be exactly 7.5 seconds")
    shots = config.get("shots") or []
    if not 1 <= len(shots) <= 3:
        raise ValueError("A storybook scene needs one to three shots")
    animated = scene["motion_mode"] == "animate"
    raw_clip = config.get("rawClip")
    if animated and not raw_clip:
        raise ValueError("Animated scene is missing provider clip")
    if raw_clip:
        info = base.probe(raw_clip, config["ffprobe"])
        stream = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
        if not WIDTH <= stream.get("width", 0) <= 4096 or not HEIGHT <= stream.get("height", 0) <= 2160 \
                or not 4.5 <= float(info["format"]["duration"]) <= 5.5:
            raise ValueError("Provider clip must be native 1080p and about five seconds")
    images = [load_shot(shot["image"]) for shot in shots]
    moves = [shot.get("cameraMove", "push_in") for shot in shots]
    spans = shot_spans(len(shots), animated and bool(raw_clip))

    warnings: list[str] = []
    overlay, warning = base.sanitize_overlay(scene.get("overlay") or {"kind": "none"})
    if warning:
        warnings.append(warning)
    if overlay["kind"] == "arrow":
        overlay = {"kind": "none"}  # a red arrow does not belong on an engraving; the picture shows the motion
    mathfont = base.font(config, "en-IN", 44, True)
    if overlay["kind"] == "equation":
        sizing = ImageDraw.Draw(Image.new("RGB", (8, 8)))
        if any(sizing.textlength(base.math_text(step), font=mathfont) > 460 for step in overlay["steps"]):
            overlay = {"kind": "none"}
            warnings.append("Equation would not fit legibly and was omitted.")
    banner = banner_layer(scene.get("title") or "", config, config["language"])
    caption = caption_strip(scene.get("caption") or "", config, config["language"])
    # One fixed paper texture: animated grain looked like film but tripled the file size.
    layers = finish_layers(seed=int(scene.get("scene_index", 1)) * 7919, count=1)
    title_until = min(3.4, spans[0][1] - 0.2)
    overlay_from = title_until if banner.getbbox() else 0.0

    args = [config["ffmpeg"], "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
            "-r", str(FPS), "-i", "-", "-an", "-frames:v", str(SCENE_FRAMES), "-c:v", "libx264", "-preset", "fast",
            "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", config["output"]]
    decoder = None
    with tempfile.TemporaryFile() as errors:
        encoder = subprocess.Popen(args, stdin=subprocess.PIPE, stderr=errors, stdout=subprocess.DEVNULL)
        base.CHILDREN.add(encoder)
        try:
            if raw_clip:
                decoder = subprocess.Popen([config["ffmpeg"], "-v", "error", "-protocol_whitelist", "file,pipe",
                    "-format_whitelist", "mov", "-threads", "2", "-i", raw_clip, "-vf",
                    f"fps={FPS},scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT}",
                    "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, stderr=errors)
                base.CHILDREN.add(decoder)
            held, decoded = None, 0
            for i in range(SCENE_FRAMES):
                t = i / FPS
                frame = None
                if decoder and t < spans[0][1]:
                    # One provider frame per output frame while the animated shot is on screen;
                    # a clip a few frames short holds its last frame.
                    data = decoder.stdout.read(WIDTH * HEIGHT * 3) if decoder.stdout else b""
                    if len(data) == WIDTH * HEIGHT * 3:
                        decoded += 1
                        held = grade(Image.frombytes("RGB", (WIDTH, HEIGHT), data))
                    elif held is None or decoded < int(4.4 * FPS):
                        raise ValueError("Provider clip is truncated or cannot be decoded")
                for index, (start, end) in enumerate(spans):
                    if not start <= t < end and not (index == len(spans) - 1 and t >= start):
                        continue
                    if index == 0 and decoder:
                        picture = held
                    else:
                        progress = (t - start) / max(0.001, end - start)
                        picture = images[index].resize((WIDTH, HEIGHT), Image.Resampling.BICUBIC,
                                                       box=camera_box(moves[index], progress, images[index].size))
                    # Dissolve: the incoming shot fades in over the first half-second of its span.
                    weight = 1.0 if index == 0 else min(1.0, (t - start) / DISSOLVE_SECONDS)
                    frame = picture if frame is None or weight >= 1 else Image.blend(frame, picture, weight)
                canvas = ImageChops.multiply(frame, layers[(i // 3) % len(layers)])
                if banner.getbbox():
                    amount = window(t, 0.35, title_until)
                    if amount > 0:
                        canvas.paste(fade(banner, amount), (0, 0), fade(banner, amount))
                if caption.getbbox():
                    amount = window(t, title_until + 0.1 if banner.getbbox() else 0.6, SCENE_SECONDS + 1)
                    if amount > 0:
                        canvas.paste(fade(caption, amount), (0, 0), fade(caption, amount))
                if overlay["kind"] != "none" and t >= overlay_from:
                    # The teaching graphic waits for the chapter banner to leave, then is
                    # printed in the page's own inks rather than bright red and blue.
                    drawn = canvas.copy()
                    base.draw_overlay(drawn, overlay, t - overlay_from + 0.5, mathfont)
                    canvas = Image.blend(drawn, grade(drawn), 0.6)
                encoder.stdin.write(canvas.tobytes())
            encoder.stdin.close()
            encoder.wait(timeout=240)
            if encoder.returncode:
                raise RuntimeError("Scene encoding failed")
        finally:
            for child in (encoder, decoder):
                if child:
                    if child.poll() is None:
                        child.kill()
                    child.wait()
                    base.CHILDREN.discard(child)
    metadata = base.video_info(config["output"], config, SCENE_SECONDS)
    metadata.update({"motionMode": scene["motion_mode"], "generatedMotionSeconds": 5 if raw_clip else 0,
                     "shotCount": len(shots), "tailSeconds": TAIL_SECONDS, "warnings": warnings,
                     "visualStyle": "storybook", "compositionVersion": 3})
    return metadata


# ── Assembly ────────────────────────────────────────────────────────────────

def assembly_filters(count: int, seconds: int, has_music: bool) -> list[str]:
    """Dissolve each scene into the next on its slot boundary, then add the opening and closing fades."""
    filters = [f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS,setsar=1[v{i}]" for i in range(count)]
    current = "v0"
    for i in range(1, count):
        out = f"x{i}"
        filters.append(f"[{current}][v{i}]xfade=transition=fade:duration={DISSOLVE_SECONDS}:offset={SLOT_SECONDS * i}[{out}]")
        current = out
    paper = "0x{:02x}{:02x}{:02x}".format(*PAPER)
    filters.append(f"[{current}]trim=duration={seconds},setpts=PTS-STARTPTS,"
                   f"fade=t=in:st=0:d=0.4:color={paper},fade=t=out:st={seconds - 0.6}:d=0.6:color={paper}[video]")
    narration = count
    if not has_music:
        filters.append(f"[{narration}:a]apad,atrim=duration={seconds},asetpts=PTS-STARTPTS[audio]")
        return filters
    music = count + 1
    filters += [
        # pan, not aformat: a mono voice copied to both channels keeps its full level (aformat's upmix drops it ~3 dB).
        f"[{narration}:a]apad,atrim=duration={seconds},asetpts=PTS-STARTPTS,aresample=48000,pan=stereo|c0=c0|c1=c0,asplit=2[voice][key]",
        f"[{music}:a]atrim=duration={seconds},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,"
        f"volume={MUSIC_LEVEL},afade=t=in:st=0:d=1.5,afade=t=out:st={seconds - 2}:d=2[bed]",
        "[bed][key]sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350[ducked]",
        "[voice][ducked]amix=inputs=2:duration=first:normalize=0[audio]",
    ]
    return filters


def assemble(config: dict) -> dict:
    clips, scenes = config["clips"], config["scenes"]
    seconds = config.get("durationSeconds", 60)
    if seconds not in (30, 60):
        raise ValueError("Lesson duration must be 30 or 60 seconds")
    count = int(seconds / SLOT_SECONDS)
    if len(clips) != count or [s["scene_index"] for s in scenes] != list(range(1, count + 1)):
        raise ValueError("Assembly needs four or eight ordered scenes matching the duration")
    for path in clips:
        base.video_info(path, config, SCENE_SECONDS)
    audio = base.probe(config["narration"], config["ffprobe"])
    if abs(float(audio["format"]["duration"]) - seconds) > .25 or not any(s["codec_type"] == "audio" for s in audio["streams"]):
        raise ValueError("Narration must match the selected duration")
    music = config.get("music")
    if music:
        if not Path(music).is_absolute() or not Path(music).is_file() or Path(music).suffix.lower() not in (".wav", ".m4a"):
            raise ValueError("Music must be an absolute local .wav or .m4a file")
        if not any(s["codec_type"] == "audio" for s in base.probe(music, config["ffprobe"])["streams"]):
            raise ValueError("Music file has no audio")
    args = [config["ffmpeg"], "-y", "-v", "error", "-filter_complex_threads", "2"]
    for clip in clips:
        args.extend(["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-threads", "2", "-i", clip])
    args.extend(["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav", "-i", config["narration"]])
    if music:
        args.extend(["-stream_loop", "-1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,wav", "-i", music])
    args.extend(["-filter_complex", ";".join(assembly_filters(count, seconds, bool(music))),
                 "-map", "[video]", "-map", "[audio]", "-t", str(seconds),
                 # Fine hatching is expensive to encode; this keeps lines crisp at ~4 Mbit/s,
                 # a size students can stream (about 15 MB for 30 s, 30 MB for 60 s).
                 "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-maxrate", "4M", "-bufsize", "8M",
                 "-threads", "2", "-pix_fmt", "yuv420p", "-r", str(FPS),
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", config["output"]])
    base.command(args, 900)
    metadata = base.video_info(config["output"], config, seconds, audio=True)
    metadata.update({"sceneCount": count, "sceneSeconds": SLOT_SECONDS, "visualStyle": "storybook",
                     "music": bool(music), "compositionVersion": 3})
    return metadata


def preflight(config: dict):
    """The storybook look needs only what the other styles already need; the title face is optional."""
    if not features.check("raqm"):
        raise ValueError("Pillow must support libraqm for Hindi/Kannada titles")
