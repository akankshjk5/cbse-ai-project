import os
import json
from pathlib import Path

def list_frames() -> dict:
    """Lists all generated storyboard frames in the generated_frames/ folder."""
    try:
        frames_dir = os.path.join(os.path.dirname(__file__), "..", "generated_frames")
        if not os.path.exists(frames_dir):
            return {"success": False, "error": f"Folder {os.path.abspath(frames_dir)} not found."}
        
        # Get all .jpg files and sort them numerically by frame number if possible
        frames = []
        for f in os.listdir(frames_dir):
            if f.endswith(".jpg") or f.endswith(".png"):
                frames.append({
                    "name": f,
                    "path": os.path.abspath(os.path.join(frames_dir, f))
                })
        
        # Sort by filename (frame_1, frame_2, etc.)
        frames.sort(key=lambda x: x["name"])
        
        return {"success": True, "frames": frames}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    result = list_frames()
    print(json.dumps(result))
