import os
import json

def list_videos() -> dict:
    """Lists all generated video clips in the generated_videos/ folder."""
    try:
        videos_dir = os.path.join(os.path.dirname(__file__), "..", "generated_videos")
        if not os.path.exists(videos_dir):
            return {"success": False, "error": f"Folder {os.path.abspath(videos_dir)} not found."}
        
        videos = []
        for f in os.listdir(videos_dir):
            if f.endswith(".mp4") and f != "output.mp4":
                videos.append({
                    "name": f,
                    "path": os.path.abspath(os.path.join(videos_dir, f))
                })
        
        def extract_number(filename):
            try:
                name_part = filename.split(".mp4")[0]
                num_part = name_part.split("_")[-1]
                return int(num_part)
            except (ValueError, IndexError):
                return 999

        videos.sort(key=lambda x: extract_number(x["name"]))
        
        return {"success": True, "videos": videos}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    result = list_videos()
    print(json.dumps(result))
