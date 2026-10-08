import json
import os
import wave
import sys
import subprocess
from typing import Any
from google import genai  # type: ignore[import-not-found]
from google.genai import types  # type: ignore[import-not-found]
from dotenv import load_dotenv  # type: ignore[import-not-found]

# Load environment variables
load_dotenv()

def wave_file(filename, pcm, channels=1, rate=24000, sample_width=2):
    """
    Saves PCM data to a wave file.
    Default rate for Gemini TTS is 24kHz.
    """
    with wave.open(filename, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(rate)
        wf.writeframes(pcm)

def convert_to_wav(input_path, output_path):
    """
    Converts any audio file to .wav using ffmpeg.
    Useful if some audios are .mp3 etc.
    """
    if input_path == output_path:
        return False
    
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-acodec", "pcm_s16le",
        "-ar", "24000",
        "-ac", "1",
        output_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0

def get_wav_duration(filename):
    """Returns the duration of a wav file in seconds."""
    try:
        with wave.open(filename, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            duration = frames / float(rate)
            return round(duration, 2)
    except:
        return 0

def generate_full_narration(text, voice_name="Kore"):
    """
    Generates a single continuous narration audio from the full audio_script.
    Saves to generated_audio/full_narration.wav.
    """
    # Initialize client
    api_key = os.getenv("VITE_VERTEX_API_KEY")
    # Vertex express keys default to a region (asia-southeast1) where the TTS
    # models aren't served, so pin the regional endpoint explicitly.
    location = os.getenv("VITE_GOOGLE_CLOUD_LOCATION", "us-central1")
    client = genai.Client(
        api_key=api_key,
        vertexai=True,
        http_options=types.HttpOptions(base_url=f"https://{location}-aiplatform.googleapis.com/"),
    )

    # Ensure output directory exists
    audio_dir = "generated_audio"
    if not os.path.exists(audio_dir):
        os.makedirs(audio_dir)

    output_filename = os.path.join(audio_dir, "full_narration.wav")

    # Define the advanced, improved Vox-style prompt
    prompt = f"""
# VOICE PROFILE: The Global Narrator (Vox Documentary Style)
## CHARACTER: 
A seasoned investigative journalist. Authoritative, intelligent, and deeply engaging. 
Not overly dramatic, but serious and analytical.

## WORLD: 
A high-end recording booth. The air is dry and quiet. Every syllable is crisp.

## EMOTIONAL BEATS:
* Informative and Precise: Speak with the weight of facts.
* Engaging Curiosity: Slight lift in tone when presenting a question or a "hook".
* Grave Reality: Drop the pitch slightly for serious or tragic segments.

## PACING & FLOW:
* Moderate-Slow Pacing: Allow space for the viewer to process complex information.
* Mid-Sentence Pauses: Use natural, slight pauses after commas for clarity.
* Emphasis: Subtle stress on crucial dates, figures, and names.
* TOTAL DURATION: The full narration MUST be 60 seconds or less.

### TRANSCRIPT TO PERFORM:
{text}
"""

    print("Generating full narration audio...", file=sys.stderr)
    
    try:
        # Use voice model from env if available
        model_name = os.getenv("VITE_GEMINI_VOICE_MODEL_AUDIO") or os.getenv("VITE_GEMINI_VISION_MODEL") or "gemini-2.0-flash"
        
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voice_name,
                        )
                    )
                ),
            )
        )

        # Get audio data
        audio_part = response.candidates[0].content.parts[0]
        if hasattr(audio_part, 'inline_data'):
            data = audio_part.inline_data.data
            wave_file(output_filename, data)
            duration = get_wav_duration(output_filename)
            
            if duration > 60:
                print(f"WARNING: Generated audio is {duration}s, exceeding 60s limit!")
            
            return {
                "success": True, 
                "message": f"Saved full narration to {output_filename}", 
                "audio_path": output_filename,
                "duration": duration,
            }
        else:
            return {"success": False, "error": "No audio data found in response."}

    except Exception as e:
        return {"success": False, "error": str(e)}


def generate_all_audio(script_path="script.json", voice_name="Kore"):
    """
    Reads script.json and generates a single continuous narration from audio_script.
    """
    if not os.path.exists(script_path):
        return {"success": False, "error": f"Script file {script_path} not found."}

    try:
        with open(script_path, "r") as f:
            script_data = json.load(f)
    except Exception as e:
        return {"success": False, "error": f"Failed to read {script_path}: {str(e)}"}

    # New format: prompt.audio_script
    prompt = script_data.get("prompt", {})
    audio_script = prompt.get("audio_script", "")
    
    if not audio_script:
        # Fallback: try old format with segments
        segments = script_data.get("segments", [])
        if segments:
            audio_script = " ".join(seg.get("narrator_speech", "") for seg in segments)
        else:
            return {"success": False, "error": "No audio_script found in script.json prompt."}

    word_count: int = len(audio_script.split())
    estimated_duration: float = float(word_count) / 2.5
    estimated_duration = round(estimated_duration, 1)
    
    if estimated_duration > 60:
        print(f"WARNING: Script has {word_count} words (~{estimated_duration}s). May exceed 60s limit.")

    result: dict[str, Any] = generate_full_narration(audio_script, voice_name)
    
    if result.get("success"):
        result["word_count"] = word_count
        result["estimated_duration"] = estimated_duration
    
    return result


def full_process(script_path="script.json", voice_name="Kore"):
    """
    1. Generates the full narration audio from script.json
    2. Merges it with videos in generated_videos/
    3. Produces final output.mp4
    """
    print("Step 1: Generating full narration audio...")
    audio_res = generate_all_audio(script_path, voice_name)
    if not audio_res.get("success"):
        return audio_res
    
    print("Step 2: Merging audio with videos and concatenating...")
    merge_res = merge_audio_and_video()
    return merge_res

def merge_audio_and_video(videos_dir="generated_videos", audio_dir="generated_audio", output_final="output.mp4"):
    """
    Concatenates all sense_X.mp4 videos from videos_dir/ into one video,
    then overlays the full narration audio from audio_dir/full_narration.wav.
    """
    temp_dir = "temp_merges"
    if not os.path.exists(videos_dir):
        return {"success": False, "error": f"Folder {videos_dir} not found."}
    
    if not os.path.exists(temp_dir):
        os.makedirs(temp_dir)

    # Find all video clips
    video_files = [f for f in os.listdir(videos_dir) if f.startswith("sense_") and f.endswith(".mp4")]
    
    def extract_number(filename):
        try:
            name_part = filename.split(".")[0]
            num_part = name_part.split("_")[-1]
            return int(num_part)
        except:
            return 999

    video_files.sort(key=extract_number)
    
    if not video_files:
        return {"success": False, "error": "No sense_X.mp4 video clips found."}

    # Step 1: Concatenate all video clips (video-only) into one continuous video
    list_file_path = os.path.join(temp_dir, "concat_list.txt")
    with open(list_file_path, "w") as f:
        for vf in video_files:
            abs_path = os.path.abspath(os.path.join(videos_dir, vf))
            f.write(f"file '{abs_path}'\n")

    concat_video_path = os.path.join(temp_dir, "concat_video.mp4")
    print("Concatenating video clips...")
    concat_cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", list_file_path,
        "-c", "copy",
        concat_video_path
    ]
    result = subprocess.run(concat_cmd, capture_output=True, text=True)
    
    if not os.path.exists(concat_video_path):
        return {"success": False, "error": f"Concat failed: {result.stderr}"}

    # Step 2: Overlay full narration audio
    narration_path = os.path.join(audio_dir, "full_narration.wav")
    
    if os.path.exists(narration_path):
        print("Overlaying full narration audio...")
        
        # Check if concatenated video has audio (from Veo)
        probe_cmd = ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", concat_video_path]
        has_audio = subprocess.run(probe_cmd, capture_output=True, text=True).stdout.strip() != ""
        
        if has_audio:
            # Mix: Video audio at 30% volume, narration at 100%
            merge_cmd = [
                "ffmpeg", "-y",
                "-i", concat_video_path,
                "-i", narration_path,
                "-filter_complex", "[0:a]volume=0.3[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=shortest[aout]",
                "-map", "0:v",
                "-map", "[aout]",
                "-c:v", "libx264",
                "-c:a", "aac",
                "-shortest",
                output_final
            ]
        else:
            # No video audio, just use narration
            merge_cmd = [
                "ffmpeg", "-y",
                "-i", concat_video_path,
                "-i", narration_path,
                "-map", "0:v",
                "-map", "1:a",
                "-c:v", "libx264",
                "-c:a", "aac",
                "-shortest",
                output_final
            ]
        subprocess.run(merge_cmd, capture_output=True, text=True)
    else:
        # No narration audio, just copy the concatenated video
        print("Warning: No full_narration.wav found. Using video-only.")
        import shutil
        shutil.copy2(concat_video_path, output_final)

    if os.path.exists(output_final):
        return {
            "success": True, 
            "message": "Successfully compiled final video with narration.", 
            "output_file": os.path.abspath(output_final),
            "clips_used": len(video_files)
        }
    else:
        return {"success": False, "error": "Final output.mp4 was not created."}


def get_all_durations(audio_dir="generated_audio"):
    """Scans the audio directory and returns duration info."""
    if not os.path.exists(audio_dir):
        return {"success": False, "error": f"Directory {audio_dir} not found."}
    
    durations = {}
    
    # Check for full narration file
    full_narration = os.path.join(audio_dir, "full_narration.wav")
    if os.path.exists(full_narration):
        durations["full_narration"] = get_wav_duration(full_narration)
    
    # Also check for any legacy sense_X.wav files
    files = [f for f in os.listdir(audio_dir) if f.startswith("sense_") and f.endswith(".wav")]
    for f in files:
        try:
            sense_id = int(f.split("_")[1].split(".")[0])
            path = os.path.join(audio_dir, f)
            durations[f"sense_{sense_id}"] = get_wav_duration(path)
        except:
            continue
            
    return {"success": True, "durations": durations}

if __name__ == "__main__":
    try:
        # Default to full_process if no params or empty params
        params = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        action = params.get("action", "full_process")

        if action == "generate":
            text = params.get("text")
            voice_name = params.get("voice_name", "Kore")
            
            if text is None:
                print(json.dumps({"error": "text is required for generate action"}))
            else:
                result = generate_full_narration(text, voice_name)
                print(json.dumps(result))

        elif action == "generate_all":
            script_path = params.get("script_path", "script.json")
            voice_name = params.get("voice_name", "Kore")
            result = generate_all_audio(script_path, voice_name)
            print(json.dumps(result))

        elif action == "full_process":
            script_path = params.get("script_path", "script.json")
            voice_name = params.get("voice_name", "Kore")
            result = full_process(script_path, voice_name)
            print(json.dumps(result))

        elif action == "merge":
            result = merge_audio_and_video()
            print(json.dumps(result))

        elif action == "get_durations":
            audio_dir = params.get("audio_dir", "generated_audio")
            result = get_all_durations(audio_dir)
            print(json.dumps(result))

        else:
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
