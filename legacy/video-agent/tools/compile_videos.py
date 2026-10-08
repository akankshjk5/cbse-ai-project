import sys
import json
import subprocess
import os

def compile_videos(input_dir="temp_merges", output_path="final_output.mp4") -> dict:
    """Compiles all video clips in input_dir/ into a single output file using ffmpeg."""
    try:
        abs_input_dir = os.path.abspath(input_dir)
        if not os.path.exists(abs_input_dir):
            return {"success": False, "error": f"Folder {abs_input_dir} not found."}
        
        videos = []
        for f in os.listdir(abs_input_dir):
            if f.endswith(".mp4"):
                videos.append(f)
        
        def extract_number(filename):
            try:
                # Expects sense_1.mp4 or ready_1.mp4 etc.
                name_part = filename.split(".mp4")[0]
                num_part = "".join(filter(str.isdigit, name_part))
                return int(num_part) if num_part else 999
            except:
                return 999

        videos.sort(key=extract_number)

        if not videos:
            return {"success": False, "error": f"No videos found in {abs_input_dir} to compile."}

        abs_output_path = os.path.abspath(output_path)
        list_file_path = os.path.join(abs_input_dir, "concat_list.txt")
        
        with open(list_file_path, "w") as f:
            for video in videos:
                f.write(f"file '{video}'\n")

        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", "concat_list.txt",
            "-c", "copy", abs_output_path
        ]
        
        result = subprocess.run(cmd, cwd=abs_input_dir, capture_output=True, text=True)
        
        # Cleanup
        if os.path.exists(list_file_path):
            os.remove(list_file_path)

        if result.returncode != 0:
            return {"success": False, "error": f"ffmpeg failed: {result.stderr}"}

        return {
            "success": True, 
            "message": "Videos successfully compiled.", 
            "output_file": abs_output_path,
            "included_videos": videos
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    try:
        if len(sys.argv) > 1:
            params = json.loads(sys.argv[1])
            idir = params.get("input_dir", "temp_merges")
            opath = params.get("output_path", "final_output.mp4")
            result = compile_videos(idir, opath)
        else:
            result = compile_videos()
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
