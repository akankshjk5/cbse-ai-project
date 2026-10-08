import os
import json

def list_audio() -> dict:
    """Lists all generated audio files in the 'generated_audio/' folder."""
    try:
        audio_dir = os.path.join(os.path.dirname(__file__), "..", "generated_audio")
        if not os.path.exists(audio_dir):
            return {"success": False, "error": f"Folder {os.path.abspath(audio_dir)} not found."}
        
        audio = []
        for f in os.listdir(audio_dir):
            if f.endswith(".wav") or f.endswith(".mp3"):
                audio.append({
                    "name": f,
                    "path": os.path.abspath(os.path.join(audio_dir, f))
                })
        
        def extract_number(name):
            try:
                # Expects sense_1.wav or segment_1.wav
                base = os.path.splitext(name)[0]
                num_part = base.split("_")[-1]
                return int(num_part)
            except (ValueError, IndexError):
                return 999

        audio.sort(key=lambda x: extract_number(x["name"]))
        
        return {"success": True, "audio_files": audio}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    result = list_audio()
    print(json.dumps(result))
