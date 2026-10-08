"""
generate_storyboard_image.py — Storyboard Image Generator Tool
================================================================
Generates images in 9:16 (portrait / vertical) format using Google's
Nano Banana (Gemini native image generation) via the google-genai SDK.

Loads visual style templates from the  tools/styles/  folder so you can
maintain multiple looks (editorial collage, neon cyberpunk, etc.) and
switch between them per-frame.  Each style is a self-contained JSON file
that carries both the structural specification AND its own prompt template.

Usage (called by Agent.py automatically):
    python generate_storyboard_image.py '{"description": "...", "style_name": "editorial_collage", ...}'

Parameters (JSON via sys.argv[1]):
    description   (required)  — What the main photo/subject should depict.
    text_overlay  (optional)  — Text to render on the image (defaults to "").
    output_path   (optional)  — Where to save the image (defaults to generated_frames/).
    shot_number   (optional)  — Shot/frame number for filename (defaults to 1).
    style_name    (optional)  — Name of a style file in tools/styles/ (without .json).
                                Defaults to the first available style.
    list_styles   (optional)  — If true, just returns the available styles and exits.
"""

import os
import sys
import json
import uuid
import copy
import glob
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


# ═══════════════════════════════════════════════════════════════════════════════
# STYLE MANAGEMENT — load styles from  tools/styles/*.json
# ═══════════════════════════════════════════════════════════════════════════════

# Directory that holds all style JSON files (sibling to this script)
STYLES_DIR = os.path.join(os.path.dirname(__file__), "styles")


def list_styles() -> list[dict]:
    """
    Return a list of available style summaries from the styles/ folder.

    Each entry contains:
        - file_name:   e.g. 'editorial_collage'
        - name:        human-readable name from the JSON
        - description: short blurb from the JSON
    """
    styles = []
    if not os.path.isdir(STYLES_DIR):
        return styles

    for filepath in sorted(glob.glob(os.path.join(STYLES_DIR, "*.json"))):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            styles.append({
                "file_name": Path(filepath).stem,        # e.g. "editorial_collage"
                "name": data.get("name", Path(filepath).stem),
                "description": data.get("description", ""),
            })
        except (json.JSONDecodeError, OSError):
            continue  # skip malformed files silently

    return styles


def load_style(style_name: str = "") -> dict:
    """
    Load a style JSON file by name (the filename without .json).
    If *style_name* is empty or None, loads the first available style.

    Returns the parsed dict.
    Raises FileNotFoundError if no matching style is found.
    """
    if not os.path.isdir(STYLES_DIR):
        raise FileNotFoundError(
            f"Styles directory not found: {STYLES_DIR}. "
            "Create it and add at least one .json style file."
        )

    if style_name:
        target = os.path.join(STYLES_DIR, f"{style_name}.json")
        if not os.path.isfile(target):
            available = [Path(p).stem for p in glob.glob(os.path.join(STYLES_DIR, "*.json"))]
            raise FileNotFoundError(
                f"Style '{style_name}' not found. Available styles: {available}"
            )
        with open(target, "r", encoding="utf-8") as f:
            return json.load(f)

    # No name given — grab the first available style alphabetically
    all_styles = sorted(glob.glob(os.path.join(STYLES_DIR, "*.json")))
    if not all_styles:
        raise FileNotFoundError(
            f"No style files found in {STYLES_DIR}. Add at least one .json style."
        )
    with open(all_styles[0], "r", encoding="utf-8") as f:
        return json.load(f)


# ═══════════════════════════════════════════════════════════════════════════════
# PROMPT BUILDER
# ═══════════════════════════════════════════════════════════════════════════════

def build_prompt(subject_description: str, text_overlay: str,
                 style: dict) -> str:
    """
    Build the final prompt for Nano Banana by injecting the subject and text
    into the loaded style template.

    Each style JSON may carry two optional prompt helpers:
        prompt_template        — the human-readable prompt with {subject}
                                 and {text_section} placeholders.
        text_section_template  — the snippet inserted when text_overlay is
                                 provided (contains {text_overlay}).
    """
    # ── Feature Augmentation (Dynamic Keywords) ──────────────────────────────
    # If the description contains people or faces, we add quality-of-life tokens
    # for better character rendering in the Vox style.
    character_keywords = ["person", "man", "woman", "child", "celebrity", "portrait", "face", "standing", "sitting"]
    is_character = any(kw in subject_description.lower() for kw in character_keywords)
    
    # ── Logo & Brand Detection (Safety / Quality Check) ──────────────────────
    brand_keywords = ["logo", "brand", "trademark", "apple logo", "nike logo", "google logo", "icon of", "emblem", "symbol of"]
    is_brand_requested = any(kw in subject_description.lower() for kw in brand_keywords)
    
    logo_safety_instruction = ""
    if is_brand_requested:
        # If the user asks for a logo, prioritize rendering the name as text if the logo is complex
        brand_name = subject_description.split("logo")[0].strip() if "logo" in subject_description.lower() else subject_description
        logo_safety_instruction = (
            f" If an accurate logo for {brand_name} cannot be rendered, instead render the brand name '{brand_name}' "
            f"using stylized, high-quality typography matching the aesthetic. Avoid messy or distorted trademark symbols."
        )

    # ── Anti-Deepfake / Likeness Protection ──────────────────────────────────
    anti_deepfake_instruction = (
        " IMPORTANT: Do NOT generate realistic human faces or recognizable likenesses of "
        "real political figures, celebrities, or public individuals. Instead, represent them symbolically "
        "(e.g., from the back, silhouettes, using recognizable clothing without faces, or symbols like flags "
        "and podiums) so that the content is stylistically safe and universally recognizable."
    )

    enhanced_subject = subject_description + anti_deepfake_instruction
    if is_character and "vox" in style.get("name", "").lower():
        # Add cinematic lighting and high-detail features for generic characters
        enhanced_subject += ", highly detailed generic facial features, cinematic lighting"

    # ── Fill in the structural JSON spec ─────────────────────────────────────
    style_spec = copy.deepcopy(style)
    
    # Include logo guidelines in the spec if available
    logo_guidelines = style_spec.get("logo_guidelines", "")
    if logo_guidelines:
        enhanced_subject += f". Logo Guideline: {logo_guidelines}"

    # Search for subject field in various common structures
    if "image_style" in style_spec:
        # Check standard main_photo structure
        if "main_photo" in style_spec["image_style"]:
             style_spec["image_style"]["main_photo"]["subject"] = enhanced_subject + logo_safety_instruction
        # Support alternative "main_subject" key if used
        elif "main_subject" in style_spec["image_style"]:
            style_spec["image_style"]["main_subject"]["subject"] = enhanced_subject + logo_safety_instruction
            
        if "typography" in style_spec["image_style"]:
            style_spec["image_style"]["typography"]["text_content"] = text_overlay or ""

    # ── Build human-readable portion of the prompt ───────────────────────────
    prompt_tpl = style.get("prompt_template", "")
    text_tpl   = style.get("text_section_template", "")

    if prompt_tpl:
        # Build the text section (empty string when no overlay)
        text_section = ""
        if text_overlay and text_tpl:
            text_section = text_tpl.format(text_overlay=text_overlay)

        ai_prompt = prompt_tpl.format(
            subject=enhanced_subject,
            text_section=text_section,
        )
    else:
        # Fallback: construct a generic prompt from the style metadata
        style_name = style.get("name", "artistic")
        ai_prompt = (
            f"9:16 portrait canvas 1080x1920px, {style_name} style, "
            f"depicting {enhanced_subject}. "
        )
        if text_overlay:
            ai_prompt += f"Include visible text reading '{text_overlay}'. "

    # ── Append the full JSON style spec for maximum consistency ──────────────
    full_prompt = (
        f"{ai_prompt}\n\n"
        f"--- STYLE SPECIFICATION (follow exactly) ---\n"
        f"{json.dumps(style_spec.get('image_style', style_spec), indent=2)}"
    )

    return full_prompt


# ═══════════════════════════════════════════════════════════════════════════════
# IMAGE GENERATION
# ═══════════════════════════════════════════════════════════════════════════════

def generate_image(description: str, text_overlay: str = "",
                   output_path: str = "", shot_number: int = 1,
                   style_name: str = "") -> dict:
    """
    Generate a single storyboard frame image using Nano Banana.

    Parameters:
        description  — what the subject of the photo should be.
        text_overlay — optional text to render on the image.
        output_path  — where to save the file (auto-generated if empty).
        shot_number  — frame number used in the default filename.
        style_name   — name of a style file in tools/styles/ (without .json).
                       Defaults to the first available style.

    Returns a dict with:
        - success: bool
        - image_path: str (absolute path to saved image)
        - prompt_used: str (the prompt sent to the model)
        - style_used: str (which style was loaded)
        - error: str (only if success is False)
    """
    from google import genai
    from google.genai import types

    # ── Load the requested style ─────────────────────────────────────────────
    try:
        style = load_style(style_name)
    except FileNotFoundError as e:
        return {"success": False, "error": str(e)}

    used_style_name = style.get("name", style_name or "unknown")

    # ── Initialize the GenAI client (Vertex AI mode) ─────────────────────────
    client = genai.Client(
        api_key=os.getenv("VITE_VERTEX_API_KEY"),
        vertexai=True,
    )

    # ── Build the prompt with the loaded style ───────────────────────────────
    prompt = build_prompt(description, text_overlay, style)

    # ── Determine output path ────────────────────────────────────────────────
    if not output_path:
        frames_dir = os.path.join(os.path.dirname(__file__), "..", "generated_frames")
        os.makedirs(frames_dir, exist_ok=True)
        filename = f"frame_{shot_number}.jpg"
        output_path = os.path.join(frames_dir, filename)
    else:
        # Ensure parent directory exists
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    # ── Read the aspect ratio from the style (default 9:16) ──────────────────
    aspect_ratio = (
        style.get("image_style", {})
             .get("dimensions", {})
             .get("aspect_ratio", "9:16")
    )

    # ── Call Nano Banana (Gemini native image generation) ─────────────────────
    try:
        response = client.models.generate_content(
            model="gemini-3-pro-image",
            contents=[prompt],
            config=types.GenerateContentConfig(
                response_modalities=["Image"],
                image_config=types.ImageConfig(
                    aspect_ratio=aspect_ratio,
                ),
            ),
        )

        # ── Extract and save the image ───────────────────────────────────────
        image_saved = False
        for part in response.parts:
            if part.inline_data is not None:
                # Use PIL to save the image
                image = part.as_image()
                image.save(output_path)
                image_saved = True
                break

        if not image_saved:
            return {
                "success": False,
                "error": "No image was returned by the model. The response may have contained only text.",
                "prompt_used": prompt[:500] + "..."
            }

        abs_path = os.path.abspath(output_path)
        return {
            "success": True,
            "image_path": abs_path,
            "prompt_used": prompt[:500] + "...",
            "dimensions": f"{style.get('image_style', {}).get('dimensions', {}).get('width', '?')}x"
                          f"{style.get('image_style', {}).get('dimensions', {}).get('height', '?')} "
                          f"({aspect_ratio})",
            "style_used": used_style_name,
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "prompt_used": prompt[:500] + "..."
        }


# ═══════════════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT (called by Agent.py via subprocess)
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "success": False,
            "error": "No parameters provided. Pass a JSON string as the first argument."
        }))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON input: {e}"
        }))
        sys.exit(1)

    # ── Handle "list_styles" request ─────────────────────────────────────────
    if params.get("list_styles", False):
        available = list_styles()
        print(json.dumps({
            "success": True,
            "styles": available,
            "styles_dir": STYLES_DIR,
        }, indent=2))
        sys.exit(0)

    # ── Extract parameters ───────────────────────────────────────────────────
    description  = params.get("description", "")
    text_overlay = params.get("text_overlay", "")
    output_path  = params.get("output_path", "")
    shot_number  = params.get("shot_number", 1)
    style_name   = params.get("style_name", "")

    if not description:
        print(json.dumps({
            "success": False,
            "error": "Missing required parameter: 'description'"
        }))
        sys.exit(1)

    result = generate_image(
        description=description,
        text_overlay=text_overlay,
        output_path=output_path,
        shot_number=shot_number,
        style_name=style_name,
    )

    print(json.dumps(result, indent=2))
