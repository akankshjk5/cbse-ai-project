import json
import os
import sys

def validate_script(script_data: dict) -> dict:
    """
    Validates the script data matches the required format:
    {
      "prompt": {
        "audio_script": "<string>",
        "images": [<exactly 8 strings>],
        "video_motions": [<exactly 8 strings>]
      }
    }
    Returns {"valid": True} or {"valid": False, "error": "<reason>"}.
    """
    if "prompt" not in script_data:
        return {"valid": False, "error": "Missing 'prompt' key in script_data."}

    prompt = script_data["prompt"]

    if "audio_script" not in prompt:
        return {"valid": False, "error": "Missing 'audio_script' in prompt."}
    if not isinstance(prompt["audio_script"], str) or not prompt["audio_script"].strip():
        return {"valid": False, "error": "'audio_script' must be a non-empty string."}

    if "images" not in prompt:
        return {"valid": False, "error": "Missing 'images' array in prompt."}
    if not isinstance(prompt["images"], list):
        return {"valid": False, "error": "'images' must be an array."}
    if len(prompt["images"]) != 8:
        return {"valid": False, "error": f"'images' must contain exactly 8 items, got {len(prompt['images'])}."}
    for i, img in enumerate(prompt["images"]):
        if not isinstance(img, str) or not img.strip():
            return {"valid": False, "error": f"Image description at index {i} must be a non-empty string."}

    if "video_motions" not in prompt:
        return {"valid": False, "error": "Missing 'video_motions' array in prompt."}
    if not isinstance(prompt["video_motions"], list):
        return {"valid": False, "error": "'video_motions' must be an array."}
    if len(prompt["video_motions"]) != 8:
        return {"valid": False, "error": f"'video_motions' must contain exactly 8 items, got {len(prompt['video_motions'])}."}
    for i, motion in enumerate(prompt["video_motions"]):
        if not isinstance(motion, str) or not motion.strip():
            return {"valid": False, "error": f"Motion description at index {i} must be a non-empty string."}

    return {"valid": True}


def save_script(script_data: dict) -> dict:
    """Validates and saves the provided script JSON to script.json."""
    try:
        # Validate format
        validation = validate_script(script_data)
        if not validation["valid"]:
            return {"success": False, "error": f"Validation failed: {validation['error']}"}

        output_file = os.path.join(os.path.dirname(__file__), "..", "script.json")
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(script_data, f, indent=2, ensure_ascii=False)

        # Count words in audio_script for info
        word_count = len(script_data["prompt"]["audio_script"].split())
        estimated_duration = round(word_count / 2.5, 1)

        return {
            "success": True,
            "message": f"Successfully saved to {os.path.abspath(output_file)}",
            "word_count": word_count,
            "estimated_audio_duration_seconds": estimated_duration,
            "image_count": len(script_data["prompt"]["images"]),
            "motion_count": len(script_data["prompt"]["video_motions"]),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No input provided."}))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        # The tool receives a dictionary of parameters.
        # It's called with 'script_data' as the key.
        script_data = params.get("script_data", params)
        result = save_script(script_data)
        print(json.dumps(result))
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)
