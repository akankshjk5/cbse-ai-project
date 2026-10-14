#!/usr/bin/env python3
"""Cloud lesson compositor: native 1080p, eight exact scene slots, CPU only.

No queue credentials, RunPod services, GPU models or remote URLs are accepted.
The Node worker downloads assets and passes a local manifest to this process.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

# Windows virtual environments may use a base-interpreter DLL search directory.
# Load the project-installed FriBiDi before Pillow initializes its RAQM support.
_FRIBIDI_HANDLE = None
if sys.platform == "win32":
    import ctypes
    for dll_name in ("fribidi.dll", "fribidi-0.dll", "libfribidi-0.dll"):
        dll_path = Path(sys.prefix) / "Scripts" / dll_name
        if dll_path.is_file():
            _FRIBIDI_HANDLE = ctypes.WinDLL(str(dll_path))
            break

from PIL import Image, ImageDraw, ImageFont, ImageOps, features

WIDTH, HEIGHT, FPS = 1920, 1080, 24
SLOT_SECONDS = 7.5
FRAMES = 180
FONTS = {"en-IN": "Kalam-Bold.ttf", "hi-IN": "NotoSansDevanagari.ttf", "kn-IN": "NotoSansKannada.ttf"}
PAPER, INK, RED, BLUE = "#eee6d5", "#2d2a26", "#ce372d", "#33658a"
CHILDREN: set[subprocess.Popen] = set()


def stop(_signum, _frame):
    for process in tuple(CHILDREN):
        process.terminate()
    raise KeyboardInterrupt("Cloud composition interrupted")


def command(args: list[str], timeout=120) -> str:
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
        CHILDREN.add(process)
        try:
            out, _ = process.communicate(timeout=timeout)
            if process.returncode:
                errors.seek(0)
                raise RuntimeError(f"Media command failed: {errors.read(2000).decode('utf-8', 'replace')}")
            return out.decode("utf-8")
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            CHILDREN.discard(process)


def probe(path: str, ffprobe: str) -> dict:
    result = json.loads(command([ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe",
                                 "-format_whitelist", "mov,wav", "-show_streams", "-show_format", "-of", "json", path], 30))
    if not math.isfinite(float(result["format"]["duration"])):
        raise ValueError("Media duration is invalid")
    return result


def video_info(path: str, config: dict, seconds: float, audio=False) -> dict:
    result = probe(path, config["ffprobe"])
    stream = next((s for s in result["streams"] if s["codec_type"] == "video"), {})
    duration = float(result["format"]["duration"])
    if stream.get("width") != WIDTH or stream.get("height") != HEIGHT or abs(duration - seconds) > 0.1:
        raise ValueError("Output is not the required 1080p duration")
    if stream.get("codec_name") != "h264" or stream.get("pix_fmt") != "yuv420p":
        raise ValueError("Output must be compatible H.264 yuv420p")
    numerator, denominator = stream.get("r_frame_rate", "0/1").split("/")
    if float(numerator) / float(denominator) != FPS:
        raise ValueError("Output must be twenty-four frames per second")
    if audio and not any(s["codec_type"] == "audio" for s in result["streams"]):
        raise ValueError("Final lesson has no narration")
    return {"width": WIDTH, "height": HEIGHT, "fps": FPS, "durationSeconds": duration,
            "codec": "h264", "hasAudio": audio}


def font(config: dict, language: str, size: int, math_font=False):
    name = "DejaVuSans-Bold.ttf" if math_font else FONTS[language]
    path = Path(config["fontsDir"]) / name
    if not path.is_file():
        raise ValueError(f"Missing caption/math font: {name}")
    if language != "en-IN" and not features.check("raqm"):
        raise ValueError("Indic captions require Pillow with libraqm")
    layout = ImageFont.Layout.RAQM if features.check("raqm") else ImageFont.Layout.BASIC
    return ImageFont.truetype(str(path), size, layout_engine=layout)


def preflight(config: dict):
    for tool in ("ffmpeg", "ffprobe"):
        command([config[tool], "-version"], 15)
    for language in FONTS:
        font(config, language, 48)
    font(config, "en-IN", 48, True)
    if not features.check("raqm"):
        raise ValueError("Pillow must support libraqm for Hindi/Kannada captions")


def sanitize_overlay(raw: dict) -> tuple[dict, str | None]:
    """Refuse malformed teaching graphics; never approximate their values."""
    try:
        kind = raw.get("kind", "none")
        if kind == "none":
            return {"kind": "none"}, None
        if kind == "arrow":
            if raw["direction"] not in {"up", "down", "left", "right", "up-right", "up-left", "down-right", "down-left"}:
                raise ValueError()
            return {"kind": kind, "direction": raw["direction"]}, None
        if kind == "equation":
            steps = raw["steps"]
            if not isinstance(steps, list) or not 1 <= len(steps) <= 4 or any(not re.fullmatch(r"[0-9a-z+\-*/=().^ <>]{1,32}", s)
                                               or re.search(r"[a-z]{3,}", s) for s in steps):
                raise ValueError()
            return {"kind": kind, "steps": steps}, None
        if kind == "groups":
            groups = raw["groups"]
            if not 1 <= len(groups) <= 5 or sum(g["count"] for g in groups) > 30 or any(
                type(g["count"]) is not int or not 1 <= g["count"] <= 12
                or not re.fullmatch(r"[0-9a-z]{0,3}", g.get("token", "")) for g in groups):
                raise ValueError()
            return {"kind": kind, "groups": groups, "showTotal": bool(raw.get("showTotal"))
                    and len({g.get("token", "") for g in groups}) == 1}, None
        if kind == "bars":
            values = raw["values"]
            if not 2 <= len(values) <= 6 or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in values) or max(values) <= 0:
                raise ValueError()
            unit = raw.get("unit", "")
            if not re.fullmatch(r"[%a-zA-Z/°]{0,6}", unit):
                raise ValueError()
            return {"kind": kind, "values": values, "unit": unit}, None
        if kind == "timeline":
            years = raw["years"]
            if not 2 <= len(years) <= 6 or years != sorted(set(years)) or raw["current"] not in years or any(
                type(y) is not int or not -3000 <= y <= 2100 for y in years):
                raise ValueError()
            return {"kind": kind, "years": years, "current": raw["current"]}, None
    except (KeyError, TypeError, ValueError):
        pass
    return {"kind": "none"}, "Invalid teaching overlay was omitted."


def caption_layer(caption: str, config: dict, language: str) -> Image.Image:
    layer = Image.new("RGBA", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(layer)
    caption = caption.strip()
    for size in range(66, 39, -2):
        chosen = font(config, language, size)
        if draw.textlength(caption, font=chosen) <= 1740:
            break
    else:
        raise ValueError("Caption cannot fit legibly")
    draw.text((WIDTH // 2, 996), caption, font=chosen, fill=INK, anchor="mm")
    return layer


def math_text(text: str) -> str:
    return text.replace("*", "×").replace("/", "÷").replace(" - ", " − ")


def draw_overlay(canvas: Image.Image, overlay: dict, t: float, mathfont, illustrated=False):
    draw = ImageDraw.Draw(canvas)
    kind = overlay["kind"]
    if kind == "none" or t < 0.5:
        return
    if kind == "arrow":
        direction = overlay["direction"]
        dx = -1 if "left" in direction else 1 if "right" in direction else 0
        dy = -1 if "up" in direction else 1 if "down" in direction else 0
        start = (630 - dx * 180, 500 - dy * 180)
        end = (630 + dx * 180, 500 + dy * 180)
        amount = min(1.0, (t - 0.5) / 0.7)
        tip = (start[0] + (end[0] - start[0]) * amount, start[1] + (end[1] - start[1]) * amount)
        draw.line([start, tip], fill=RED, width=12)
        angle = math.atan2(dy, dx)
        draw.polygon([tip, (tip[0] - 45 * math.cos(angle - .5), tip[1] - 45 * math.sin(angle - .5)),
                      (tip[0] - 45 * math.cos(angle + .5), tip[1] - 45 * math.sin(angle + .5))], fill=RED)
        return
    left, top, right, bottom = 1320, 150, 1830, 875
    draw.rounded_rectangle((left, top, right, bottom), radius=20,
                           fill="white" if illustrated else "#f8f4ea",
                           outline="#168d99" if illustrated else "#7c93a3", width=4)
    if kind == "equation":
        for i, text in enumerate(overlay["steps"]):
            if t < 0.7 + i * 1.2:
                continue
            draw.text((left + 255, top + 110 + i * 150), math_text(text), font=mathfont, fill=INK, anchor="mm")
    elif kind == "groups":
        total = 0
        for i, group in enumerate(overlay["groups"]):
            for j in range(group["count"]):
                total += 1
                if t < 0.6 + total * .1:
                    continue
                x, y = left + 45 + (j % 6) * 77, top + 55 + i * 110 + (j // 6) * 55
                draw.ellipse((x, y, x + 32, y + 32), fill=BLUE)
                if group.get("token"):
                    draw.text((x + 16, y + 16), group["token"], font=mathfont.font_variant(size=20), fill="white", anchor="mm")
        if overlay["showTotal"] and t > 4:
            draw.text((left + 255, bottom - 45), f"= {total}", font=mathfont, fill=INK, anchor="mm")
    elif kind == "bars":
        maximum = max(overlay["values"])
        slot = 440 / len(overlay["values"])
        for i, value in enumerate(overlay["values"]):
            growth = min(1, max(0, (t - .6 - i * .3) / .7))
            x = left + 35 + i * slot
            y = bottom - 90 - 500 * value / maximum * growth
            draw.rectangle((x, y, x + slot * .65, bottom - 90), fill=BLUE)
            if growth == 1:
                label = f"{value:g}{overlay['unit']}"
                draw.text((x + slot * .32, y - 30), label, font=mathfont.font_variant(size=28), fill=INK, anchor="mm")
    elif kind == "timeline":
        # Vertical timeline avoids squeezing six year labels into one row.
        draw.line((left + 60, top + 75, left + 60, bottom - 75), fill=BLUE, width=6)
        for i, year in enumerate(overlay["years"]):
            y = top + 75 + i * (bottom - top - 150) / (len(overlay["years"]) - 1)
            color = RED if year == overlay["current"] else BLUE
            draw.ellipse((left + 45, y - 15, left + 75, y + 15), fill=color)
            draw.text((left + 125, y), str(year), font=mathfont, fill=color, anchor="lm")


def render_scene(config: dict) -> dict:
    scene = config["scene"]
    if float(scene["duration_seconds"]) != SLOT_SECONDS:
        raise ValueError("Scene slot must be exactly 7.5 seconds")
    overlay, warning = sanitize_overlay(scene["overlay"])
    image_path = Path(config["image"])
    with Image.open(image_path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
    if image.width < WIDTH or image.height < HEIGHT:
        raise ValueError("Source keyframe is below 1080p")
    raw_clip = config.get("rawClip")
    if scene["motion_mode"] == "animate" and not raw_clip:
        raise ValueError("Animated scene is missing provider clip")
    if raw_clip:
        info = probe(raw_clip, config["ffprobe"])
        stream = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
        if not WIDTH <= stream.get("width", 0) <= 4096 or not HEIGHT <= stream.get("height", 0) <= 2160 or not 4.5 <= float(info["format"]["duration"]) <= 5.5:
            raise ValueError("Provider clip must be native 1080p and about five seconds")
    panel = overlay["kind"] not in ("none", "arrow")
    box = (90, 90, 1270, 920) if panel else (70, 60, 1850, 920)
    w, h = box[2] - box[0], box[3] - box[1]
    caption = caption_layer(scene["caption"], config, config["language"])
    mathfont = font(config, "en-IN", 44, True)
    if overlay["kind"] == "equation":
        sizing = ImageDraw.Draw(caption)
        if any(sizing.textlength(math_text(step), font=mathfont) > 460 for step in overlay["steps"]):
            overlay, warning = {"kind": "none"}, "Equation would not fit legibly and was omitted."
    illustrated = config.get("visualStyle", "editorial") == "illustrated"
    base = Image.new("RGB", (WIDTH, HEIGHT), "#edf5ff" if illustrated else PAPER)
    grid = ImageDraw.Draw(base)
    if not illustrated:
        for x in range(0, WIDTH, 48):
            grid.line((x, 0, x, HEIGHT), fill="#ded3bf")
        for y in range(0, HEIGHT, 48):
            grid.line((0, y, WIDTH, y), fill="#ded3bf")
    grid.rounded_rectangle((box[0] - 12, box[1] - 12, box[2] + 12, box[3] + 12), radius=24 if illustrated else 14,
                           fill="white" if illustrated else "#f8f4ea", outline="#168d99" if illustrated else "#7c93a3", width=5)
    if illustrated:
        grid.rounded_rectangle((90, 950, 1830, 1045), radius=28, fill="white")
    command_args = [config["ffmpeg"], "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}",
                    "-r", str(FPS), "-i", "-", "-an", "-frames:v", str(FRAMES), "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-threads", "2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", config["output"]]
    decoder = None
    with tempfile.TemporaryFile() as errors:
        encoder = subprocess.Popen(command_args, stdin=subprocess.PIPE, stderr=errors, stdout=subprocess.DEVNULL)
        CHILDREN.add(encoder)
        try:
            if raw_clip:
                decoder = subprocess.Popen([config["ffmpeg"], "-v", "error", "-protocol_whitelist", "file,pipe",
                    "-format_whitelist", "mov", "-threads", "2", "-i", raw_clip, "-vf",
                    f"fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
                    "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE, stderr=errors)
                CHILDREN.add(decoder)
            held = None
            decoded_frames = 0
            for i in range(FRAMES):
                t = i / FPS
                if decoder:
                    data = decoder.stdout.read(w * h * 3)
                    if len(data) == w * h * 3:
                        decoded_frames += 1
                        held = Image.frombytes("RGB", (w, h), data)
                    elif held is None or decoded_frames < int(4.5 * FPS):
                        raise ValueError("Provider clip is truncated or cannot be decoded")
                    photo = held
                else:
                    # Mild pan/zoom uses the 2K still's detail; no paid motion request.
                    zoom = 1 + .04 * i / (FRAMES - 1)
                    cropw, croph = image.width / zoom, image.height / zoom
                    x, y = (image.width - cropw) / 2, (image.height - croph) / 2
                    photo = ImageOps.fit(image.crop((x, y, x + cropw, y + croph)), (w, h), Image.Resampling.LANCZOS)
                canvas = base.copy()
                canvas.paste(photo, box[:2])
                if illustrated:
                    # Short fade-in/out smooths scene changes without shortening slots
                    # or shifting narration. Text stays crisp and stationary.
                    reveal = min(1.0, t / .35, (SLOT_SECONDS - t) / .35)
                    if reveal < 1:
                        canvas = Image.blend(base, canvas, max(0, reveal))
                    if t >= .25:
                        canvas.paste(caption, (0, 0), caption)
                    progress = ImageDraw.Draw(canvas)
                    progress.rounded_rectangle((90, 1058, 1830, 1066), radius=4, fill="#d8e6f2")
                    progress.rounded_rectangle((90, 1058, 90 + max(8, int(1740 * t / SLOT_SECONDS)), 1066), radius=4, fill="#168d99")
                else:
                    canvas.paste(caption, (0, 0), caption)
                draw_overlay(canvas, overlay, t, mathfont, illustrated=illustrated)
                encoder.stdin.write(canvas.tobytes())
            encoder.stdin.close()
            encoder.wait(timeout=180)
            if encoder.returncode:
                raise RuntimeError("Scene encoding failed")
        finally:
            for child in (encoder, decoder):
                if child:
                    if child.poll() is None:
                        child.kill()
                    child.wait()
                    CHILDREN.discard(child)
    metadata = video_info(config["output"], config, SLOT_SECONDS)
    metadata.update({"motionMode": scene["motion_mode"], "generatedMotionSeconds": 5 if raw_clip else 0,
                     "warnings": [warning] if warning else [], "visualStyle": config.get("visualStyle", "editorial"), "compositionVersion": 2})
    return metadata


def assemble(config: dict) -> dict:
    clips, scenes = config["clips"], config["scenes"]
    seconds = config.get("durationSeconds", 60)
    if seconds not in (30, 60):
        raise ValueError("Lesson duration must be 30 or 60 seconds")
    count = int(seconds / SLOT_SECONDS)
    if len(clips) != count or [s["scene_index"] for s in scenes] != list(range(1, count + 1)):
        raise ValueError("Assembly needs four or eight ordered scenes matching the duration")
    for path in clips:
        video_info(path, config, SLOT_SECONDS)
    audio = probe(config["narration"], config["ffprobe"])
    if abs(float(audio["format"]["duration"]) - seconds) > .25 or not any(s["codec_type"] == "audio" for s in audio["streams"]):
        raise ValueError("Narration must match the selected duration")
    args = [config["ffmpeg"], "-y", "-v", "error", "-filter_complex_threads", "2"]
    for clip in clips:
        args.extend(["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-threads", "2", "-i", clip])
    args.extend(["-protocol_whitelist", "file,pipe", "-format_whitelist", "wav", "-i", config["narration"]])
    filters = [f"[{i}:v]trim=duration=7.5,setpts=PTS-STARTPTS,setsar=1[v{i}]" for i in range(count)]
    filters.append("".join(f"[v{i}]" for i in range(count)) + f"concat=n={count}:v=1:a=0[video]")
    filters.append(f"[{count}:a]apad,atrim=duration={seconds},asetpts=PTS-STARTPTS[audio]")
    args.extend(["-filter_complex", ";".join(filters), "-map", "[video]", "-map", "[audio]", "-t", str(seconds),
                 "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p", "-r", str(FPS),
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", config["output"]])
    command(args, 900)
    metadata = video_info(config["output"], config, seconds, audio=True)
    metadata.update({"sceneCount": count, "sceneSeconds": SLOT_SECONDS, "compositionVersion": 2})
    return metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--config")
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    if args.preflight:
        preflight(json.loads(args.config))
        print(json.dumps({"ready": True}))
        return
    config = json.loads(args.manifest.read_text(encoding="utf-8"))
    # FFmpeg only sees local paths and fixed filters. Captions never enter a shell/filter.
    for key in ("image", "rawClip", "narration", "output"):
        if config.get(key) and not Path(config[key]).is_absolute():
            raise ValueError("Manifest media paths must be absolute")
    if any(not Path(path).is_absolute() for path in config.get("clips", [])):
        raise ValueError("Manifest clips must use absolute paths")
    if any(not Path(shot.get("image", "")).is_absolute() for shot in config.get("shots", [])) \
            or (config.get("music") and not Path(config["music"]).is_absolute()):
        raise ValueError("Manifest shots and music must use absolute paths")
    if config.get("visualStyle") == "storybook":
        # The storybook presentation lives in its own module; the other styles never reach it.
        sys.modules.setdefault("compositor", sys.modules[__name__])  # one module, so SIGTERM stops storybook's children too
        import storybook
        result = storybook.render_scene(config) if config["mode"] == "scene" else storybook.assemble(config)
    else:
        result = render_scene(config) if config["mode"] == "scene" else assemble(config)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
