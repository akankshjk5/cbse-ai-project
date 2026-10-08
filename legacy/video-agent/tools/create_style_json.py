"""
create_style_json.py — Storyboard Style Generator Tool
======================================================
This tool takes a style name, description, and an optional reference image.
It uses Gemini (Gemini 2.5 Flash for image analysis) to generate a
comprehensive style JSON file compatible with generate_storyboard_image.py.

Usage:
    python create_style_json.py '{"style_name": "neon_punk", "description": "Vibrant pinks and cyans, gritty urban background", "image_path": "path/to/ref.jpg"}'

Outputs:
    Saves a JSON file to tools/styles/neon_punk.json.
"""

import os
import sys
import json
from dotenv import load_dotenv

load_dotenv()

# Style directory location
STYLES_DIR = os.path.join(os.path.dirname(__file__), "styles")

def _guess_image_mime_type(image_path: str) -> str:
    ext = os.path.splitext(image_path)[1].lower()
    if ext in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if ext == ".png":
        return "image/png"
    if ext == ".webp":
        return "image/webp"
    if ext == ".gif":
        return "image/gif"
    return "image/jpeg"

def analyze_and_create_style(style_name: str, description: str, image_path: str = None) -> dict:
    from google import genai
    from google.genai import types

    # 1. Prepare Style Directory
    os.makedirs(STYLES_DIR, exist_ok=True)
    target_file = os.path.join(STYLES_DIR, f"{style_name}.json")

    # 2. Get the GenAI client
    client = genai.Client(
        api_key=os.getenv("VITE_VERTEX_API_KEY"),
        vertexai=True,
    )

    # 3. Construct Gemini Prompt — clearly define the schema we need.
    system_instruction = (
        "You are an expert visual designer. You create detailed 'Visual Style Specification' JSON files "
        "for an AI image generator (Google Nano Banana). These specs define everything: colors, "
        "layout, typography, and the literal prompt template used to generate consistent images."
    )

    style_prompt = f"""
    OBJECTIVE: Create a visual style JSON named '{style_name}' based on the provided inputs.
    
    INPUT DESCRIPTION: {description}
    
    LOGO EXTRACTION: If a reference image is provided, identify any brand logos, icons, or specific emblems. 
    In the 'logo_guidelines', describe how these should be rendered (colors, placement, simplicity). 
    If the image contains a logo for a known entity (e.g., Apple, Google, Nike), EXPLICITLY specify that 
    the AI generator should use the BRAND NAME as text if it cannot render the logo accurately.

    REQUIRED JSON FORMAT (FOLLOW EXACTLY):
    {{
      "name": "Human Readable Name of Style",
      "description": "Short summary of the visual vibe.",
      "prompt_template": "A full, dense prompt for Nano Banana. MUST include placeholders '{{subject}}' and '{{text_section}}'. Incorporate 'logo safety' logic: if a subject implies a brand, suggest rendering the name as text for clarity.",
      "text_section_template": "Detailed description of how to render text overlay. MUST include '{{text_overlay}}' placeholder.",
      "logo_guidelines": "Instructions on how to handle brand logos/emblems for this style. Prefer text-based names or stylized simplified icons.",
      "image_style": {{
        "dimensions": {{
          "aspect_ratio": "9:16",
          "orientation": "portrait",
          "width": 1080,
          "height": 1920
        }},
        "overall_style": "...",
        "aesthetic": "...",
        "background": {{
          "color": "#...",
          "texture": "...",
          "details": "..."
        }},
        "main_photo": {{
          "subject": "{{{{SUBJECT_DESCRIPTION}}}}",
          "style": "...",
          "position": "..."
        }},
        "typography": {{
          "font_family": "...",
          "color": "#...",
          "text_content": "{{{{TEXT_CONTENT}}}}"
        }},
        "color_palette": {{
           "background": "#...",
           "accent": "#...",
           "text": "#..."
        }}
      }}
    }}

    IMPORTANT: If a reference image is provided, extract its specific hex colors, background texture, 
    and subject-background relationship. If no image is provided, use the description to infer a high-quality, professional look.
    Return ONLY the raw JSON object.
    """

    contents = [style_prompt]

    # 4. Handle Image Path
    if image_path and os.path.exists(image_path):
        try:
            with open(image_path, "rb") as f:
                img_data = f.read()
            contents.append(
                types.Part.from_bytes(data=img_data, mime_type=_guess_image_mime_type(image_path))
            )
        except Exception as e:
            return {"success": False, "error": f"Failed to read image: {e}"}

    # 5. Call Gemini
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                response_mime_type="application/json",
            )
        )

        style_json_text = response.text.strip()
        # Ensure it's valid JSON
        style_data = json.loads(style_json_text)

        # 6. Save to File
        with open(target_file, "w", encoding="utf-8") as f:
            json.dump(style_data, f, indent=4)

        return {
            "success": True,
            "style_name": style_name,
            "file_path": os.path.abspath(target_file),
            "summary": style_data.get("description", "Style created successfully.")
        }

    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No input provided."}))
        sys.exit(1)

    try:
        args = json.loads(sys.argv[1])
        s_name = args.get("style_name")
        desc = args.get("description")
        img = args.get("image_path")

        if not s_name or not desc:
            print(json.dumps({"success": False, "error": "Missing 'style_name' or 'description'"}))
            sys.exit(1)

        res = analyze_and_create_style(s_name, desc, img)
        print(json.dumps(res, indent=2))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
