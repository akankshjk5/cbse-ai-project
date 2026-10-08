import sys
import json
import subprocess
import os

def add_audio_to_video(video_path: str, audio_path: str, output_path: str):
    try:
        # 1. Ensure output directory exists
        out_dir = os.path.dirname(output_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir)

        # 2. Check if source video has audio
        probe_cmd = [
            "ffprobe", "-v", "error", "-select_streams", "a", 
            "-show_entries", "stream=index", "-of", "csv=p=0", video_path
        ]
        probe_res = subprocess.run(probe_cmd, capture_output=True, text=True)
        has_audio = probe_res.stdout.strip() != ""

        if has_audio:
            # Mix: Video audio (30%) + VO (100%)
            # Loop video to fill audio duration
            command = [
                "ffmpeg", "-y", 
                "-stream_loop", "-1", "-i", video_path, 
                "-i", audio_path,
                "-filter_complex", "[0:a]volume=0.3[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=shortest[aout]",
                "-map", "0:v:0", "-map", "[aout]",
                "-c:v", "libx264", "-c:a", "aac", "-shortest",
                output_path
            ]
        else:
            # No audio in video, just use VO and loop video
            command = [
                "ffmpeg", "-y", 
                "-stream_loop", "-1", "-i", video_path, 
                "-i", audio_path,
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "libx264", "-c:a", "aac", "-shortest",
                output_path
            ]
        
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            return {"success": False, "error": f"FFmpeg error: {result.stderr}"}
            
        return {"success": True, "output_path": os.path.abspath(output_path)}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No parameters provided."}))
        sys.exit(1)
        
    try:
        params = json.loads(sys.argv[1])
        video_path = params.get("video_path")
        audio_path = params.get("audio_path")
        output_path = params.get("output_path")
        
        if not all([video_path, audio_path, output_path]):
            print(json.dumps({"success": False, "error": "Missing parameters."}))
            sys.exit(1)
            
        result = add_audio_to_video(video_path, audio_path, output_path)
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
