import json
import os
import sys
from typing import Any


def load_script() -> dict[str, Any]:
    """Loads the script JSON from script.json and validates the new format."""
    try:
        input_file = os.path.join(os.path.dirname(__file__), "..", "script.json")
        if not os.path.exists(input_file):
            return {"success": False, "error": f"File {os.path.abspath(input_file)} not found."}
        with open(input_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        # Provide format info
        info: dict[str, Any] = {}
        if "prompt" in data:
            prompt = data["prompt"]
            info["format"] = "new (prompt-based)"
            info["has_audio_script"] = bool(prompt.get("audio_script"))
            info["image_count"] = len(prompt.get("images", []))
            info["motion_count"] = len(prompt.get("video_motions", []))
            if info["has_audio_script"]:
                word_count = len(prompt["audio_script"].split())
                info["audio_word_count"] = word_count
                info["estimated_duration_seconds"] = round(float(word_count) / 2.5, 1)
        elif "segments" in data:
            info["format"] = "legacy (segments-based)"
            info["segment_count"] = len(data["segments"])
        
        return {"success": True, "script_data": data, "info": info}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    # No input parameters needed, but the agent system passes a JSON {}
    result = load_script()
    print(json.dumps(result))
