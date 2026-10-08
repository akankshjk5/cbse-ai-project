"""
Agent.py — The Main Agent (Manager)
====================================
This is the brain of the system. It works like this:

    ┌─────────────────────────────────────────────┐
    │              MANAGER MODE                   │
    │  (Default — uses the MANAGER_PROMPT)        │
    │                                             │
    │  Has ONE universal tool:                    │
    │    • find_and_use_skill  → searches the     │
    │      skills/ folder, picks the right skill, │
    │      and loads it.                          │
    │                                             │
    │  When a skill is loaded:                    │
    │    1. System prompt switches to the skill's │
    │       prompt.                               │
    │    2. The skill's tools become available.   │
    │    3. The agent now acts as that specialist.│
    └──────────────────────┬──────────────────────┘
                           │  Skill finishes its job
                           ▼
    ┌─────────────────────────────────────────────┐
    │              KILL SWITCH                    │
    │  reset_to_manager() is called               │
    │    1. System prompt resets to MANAGER_PROMPT│
    │    2. Specialist tools are removed.         │
    │    3. Manager resumes control.              │
    └─────────────────────────────────────────────┘

Folder Structure:
    Agent.py        ← You are here (main agent)
    memory.py       ← Scratchpad (tracks steps & status)
    prompt.md       ← The manager's system prompt (edit this!)
    skills/         ← Each .md file is a skill/agent
    tools/          ← Python scripts that skills can call
"""

import os
import json
import subprocess
import sys
import time
import threading
from dotenv import load_dotenv
from memory import Memory
from google import genai
from google.genai import types

load_dotenv()


# ═══════════════════════════════════════════════════════════════════════════════
# TERMINAL STYLING (just colors for pretty output)
# ═══════════════════════════════════════════════════════════════════════════════

class Colors:
    """ANSI color codes for terminal output."""
    HEADER    = '\033[95m'   # Purple
    BLUE      = '\033[94m'
    CYAN      = '\033[96m'
    GREEN     = '\033[92m'
    YELLOW    = '\033[93m'
    RED       = '\033[91m'
    BOLD      = '\033[1m'
    UNDERLINE = '\033[4m'
    RESET     = '\033[0m'


class Spinner:
    """
    Shows a spinning animation in the terminal while the agent is thinking.
    Usage:
        with Spinner("Thinking..."):
            do_something_slow()
    """
    FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

    def __init__(self, message: str = "Thinking..."):
        self.message = message
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._spin, daemon=True)

    def _spin(self):
        for i in range(10**9):
            if self._stop.is_set():
                break
            frame = self.FRAMES[i % len(self.FRAMES)]
            sys.stdout.write(f"\r{Colors.CYAN}{frame}{Colors.RESET} {self.message}")
            sys.stdout.flush()
            time.sleep(0.1)
        # Clear the spinner line when done
        sys.stdout.write("\r" + " " * (len(self.message) + 4) + "\r")
        sys.stdout.flush()

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._thread.join()


# ═══════════════════════════════════════════════════════════════════════════════
# SYSTEM PROMPTS
# ═══════════════════════════════════════════════════════════════════════════════

def _load_manager_prompt() -> str:
    """
    Load the manager's system prompt from prompt.md.
    If the file is empty or missing, use a sensible default.
    """
    prompt_file = os.path.join(os.path.dirname(__file__), "prompt.md")
    local_prompt = ""
    if os.path.exists(prompt_file):
        content = open(prompt_file, encoding="utf-8").read().strip()
        if content:
            local_prompt = content

    # Fallback default prompt (used only if prompt.md is empty/missing)
    if not local_prompt:
        local_prompt = """You are the Main Agent Manager. Your job is to oversee the complete video production pipeline.

### VIDEO GENERATION WORKFLOW (ORDER OF OPERATIONS):
1. **Scripting**: Use `scriptwriter_agent` to create `script.json`.
2. **Storyboarding**: Use `storyboard_artist` to generate frames in `generated_frames/`.
3. **Voiceover**: Use `voiceover_agent` to generate audio. 
   - **IMPORTANT**: Record the **durations** of the generated audio files for the next step.
4. **Motion Design**: Use `motion_designer_agent` with the saved frames and **audio durations**.
   - Set `duration_seconds` to match the audio for each scene.
5. **Final Assembly**: Use `video_editor_agent` to merge and compile the final `output.mp4`.

Always check your memory for next steps and durations before proceeding to the next phase."""

    # Optional: fetch manager prompt from Langfuse so prompt updates can be
    # versioned/refined without redeploying code.
    use_langfuse_prompt = os.getenv("LANGFUSE_USE_MANAGED_PROMPT", "0").strip() == "1"
    if use_langfuse_prompt:
        try:
            from langfuse import get_client

            langfuse = get_client()
            prompt_name = os.getenv("LANGFUSE_MANAGER_PROMPT_NAME", "et-agent-manager")
            prompt_label = os.getenv("LANGFUSE_MANAGER_PROMPT_LABEL", "production")
            ttl_raw = os.getenv("LANGFUSE_MANAGER_PROMPT_CACHE_TTL_SECONDS", "30")
            try:
                cache_ttl = max(0, int(ttl_raw))
            except ValueError:
                cache_ttl = 30

            managed_prompt = langfuse.get_prompt(
                prompt_name,
                label=prompt_label,
                fallback=local_prompt,
                cache_ttl_seconds=cache_ttl,
            )

            prompt_text = ""
            if hasattr(managed_prompt, "compile"):
                compiled = managed_prompt.compile()
                if isinstance(compiled, str):
                    prompt_text = compiled.strip()
            if not prompt_text:
                candidate = getattr(managed_prompt, "prompt", "")
                if isinstance(candidate, str):
                    prompt_text = candidate.strip()

            if prompt_text:
                return prompt_text
        except Exception:
            pass

    return local_prompt


# This instruction is appended to EVERY specialist's prompt so they know to hand back.
REPORTING_INSTRUCTION = """

IMPORTANT: When you finish your job, you MUST call 'reset_to_manager'.
Provide a clear 'work_summary' and list any 'next_steps' or 'durations' discovered during your task."""




# ═══════════════════════════════════════════════════════════════════════════════
# TOOL DECLARATIONS (what the LLM sees as available functions)
# ═══════════════════════════════════════════════════════════════════════════════

# --- Manager Tools ---
# These are ALWAYS available. The manager uses them to find & load skills.

MANAGER_TOOLS = [
    {
        # See what skills are available.
        "name": "list_skills",
        "description": "List all available specialist skills/agents with their descriptions.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        # Load a skill — switches the agent INTO specialist mode.
        "name": "find_and_use_skill",
        "description": (
            "Load a specialist skill/agent by name. This switches you into that "
            "specialist's mode (new prompt + tools). Use list_skills first to see what's available."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Name of the skill to load (without .md extension).",
                },
            },
            "required": ["skill_name"],
        },
    },
    {
        # Run a skill in isolation — Manager stays in control.
        # Use this when you need to run MULTIPLE skills for one task.
        "name": "run_skill",
        "description": (
            "Run a specialist skill in the background and get its result back. "
            "Unlike find_and_use_skill, this does NOT switch modes — you stay as Manager. "
            "Use this to chain multiple skills for complex tasks."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_name": {
                    "type": "string",
                    "description": "Name of the skill to run (without .md extension).",
                },
                "query": {
                    "type": "string",
                    "description": "The task/question to send to the skill.",
                },
            },
            "required": ["skill_name", "query"],
        },
    },
    {
        # Return control to manager.
        "name": "reset_to_manager",
        "description": "Return control to the main manager. Call this when your job is done.",
        "parameters": {
            "type": "object",
            "properties": {
                "work_summary": {
                    "type": "string",
                    "description": "Short description of what was accomplished.",
                },
                "next_steps": {
                    "type": "string",
                    "description": "What the manager should do next, if anything.",
                },
            },
            "required": ["work_summary"],
        },
    },
    {
        "name": "load_script",
        "description": "Utility: Load the video script JSON from script.json.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "list_videos",
        "description": "Utility: List all produced video clips in the generated_videos/ directory.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "list_frames",
        "description": "Utility: List all storyboard frames in the generated_frames/ directory.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "list_audio",
        "description": "Utility: List all voiceover audio files in the generated_audio/ directory.",
        "parameters": {"type": "object", "properties": {}},
    },
]



# ═══════════════════════════════════════════════════════════════════════════════
# THE AGENT
# ═══════════════════════════════════════════════════════════════════════════════

class Agent:
    """
    The main agent. It starts in "Manager" mode and can switch to
    "Specialist" mode by loading a skill from the skills/ folder.

    Key idea:
        - Manager mode  → has find_and_use_skill + run_skill tools
        - find_and_use_skill → switches INTO the skill (full handover)
        - run_skill          → runs a skill in isolation (Manager stays in control)
        - Specialist mode → has whatever tools the skill defines
        - When specialist is done → kill switch resets back to Manager
    """

    MODEL_ID   = "gemini-3-flash-preview"    # The LLM model to use
    BASE_DIR   = os.path.dirname(__file__)   # Project root for this file
    SKILLS_DIR = os.path.join(BASE_DIR, "skills")  # Where skill .md files live
    TOOLS_DIR  = os.path.join(BASE_DIR, "tools")   # Where tool .py scripts live

    def __init__(self):
        # Load the manager prompt (from prompt.md or default)
        self._manager_prompt = _load_manager_prompt()

        # Current state
        self.system_prompt  = self._manager_prompt   # Active system prompt
        self.current_tools  = []                      # Extra tools from loaded skill
        self.chat           = None                    # Chat session (reset on skill switch)
        memory_file = os.path.join(self.BASE_DIR, "memory.json")
        self.memory = Memory(storage_file=memory_file)  # The scratchpad

        # Initialize the Google GenAI client
        self.client = genai.Client(
            api_key=os.getenv("VITE_VERTEX_API_KEY"),
            vertexai=True,
        )
        self._log("System", f"Agent initialized with {self.MODEL_ID}.", Colors.GREEN)

    # ── Helper Properties ─────────────────────────────────────────────────────

    @property
    def is_manager(self) -> bool:
        """True if the agent is currently in Manager mode."""
        return self.system_prompt == self._manager_prompt

    @property
    def _role_label(self) -> str:
        """Display label for the current mode."""
        return "MANAGER" if self.is_manager else "SPECIALIST"

    @property
    def _role_color(self) -> str:
        """Color for the current mode."""
        return Colors.CYAN if self.is_manager else Colors.HEADER

    # ── Logging ───────────────────────────────────────────────────────────────

    def _log(self, tag: str, message: str, color: str = Colors.BLUE):
        """Print a formatted log message."""
        print(f"{color}[{tag}]{Colors.RESET} {message}")

    # ═══════════════════════════════════════════════════════════════════════════
    # TOOL HANDLERS (what actually happens when the LLM calls a tool)
    # ═══════════════════════════════════════════════════════════════════════════

    def find_and_use_skill(self, skill_name: str = "") -> str:
        """
        The ONE universal tool.

        - If skill_name is empty → list all available skills with their descriptions.
        - If skill_name is given → load that skill (switch system prompt + tools).

        This is the only tool the manager needs. It can discover what's available
        and then load the right specialist.
        """

        # ── Case 1: No skill_name → just list available skills ────────────────
        if not skill_name:
            return self._list_skills()

        # ── Case 2: skill_name given → load the skill ─────────────────────────
        return self._load_skill(skill_name)

    def _list_skills(self) -> str:
        """
        Scan the skills/ folder and return a summary of all available skills.
        Each skill's first line (after the # heading) is used as its description.
        """
        if not os.path.exists(self.SKILLS_DIR):
            return "No skills directory found."

        # Find all .md files in the skills folder
        skill_files = [f for f in os.listdir(self.SKILLS_DIR) if f.endswith(".md")]

        if not skill_files:
            return "No skills found in the skills/ folder."

        # Build a summary with name + first-line description
        summaries = []
        for filename in skill_files:
            name = filename.removesuffix(".md")
            path = os.path.join(self.SKILLS_DIR, filename)

            # Read the first non-empty, non-heading line as the description
            description = "(no description)"
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        description = line[:100]  # Truncate long descriptions
                        break

            summaries.append(f"  • {name}: {description}")

        return "Available skills:\n" + "\n".join(summaries)

    def _load_skill(self, skill_name: str) -> str:
        """
        Load a skill from skills/<skill_name>.md.

        The .md file format:
            # Skill Title
            You are a specialist...  (this becomes the system prompt)

            ---TOOLS---              (optional separator)
            [ ...JSON array... ]     (tool declarations for this skill)
        """
        step_id = self.memory.add_step(f"Loading skill: {skill_name}", status="in_progress")
        skill_file = os.path.join(self.SKILLS_DIR, f"{skill_name}.md")

        # Check the skill file exists
        if not os.path.exists(skill_file):
            self.memory.update_step(step_id, "error")
            return f"Skill '{skill_name}' not found in skills/ folder."

        try:
            content = open(skill_file, encoding="utf-8").read().strip()

            # Split into prompt and tools (if ---TOOLS--- separator exists)
            if "---TOOLS---" in content:
                prompt_part, tools_part = content.split("---TOOLS---", 1)
                self.system_prompt = prompt_part.strip() + REPORTING_INSTRUCTION
                self.current_tools = json.loads(tools_part.strip())
            else:
                # No tools — just a prompt-only skill
                self.system_prompt = content + REPORTING_INSTRUCTION
                self.current_tools = []

            # Reset the chat session so the new prompt takes effect
            self.chat = None

            self.memory.update_step(step_id, "success")
            self._log("System", f"Skill '{skill_name}' loaded. Switching to SPECIALIST mode.", Colors.GREEN)
            return f"Skill '{skill_name}' loaded successfully."

        except Exception as e:
            self.memory.update_step(step_id, "error")
            return f"Error loading skill '{skill_name}': {e}"

    def reset_to_manager(self, work_summary: str, next_steps: str = "") -> str:
        """
        ╔═══════════════════════════════════════════╗
        ║            THE KILL SWITCH                ║
        ║  Resets everything back to Manager mode.  ║
        ╚═══════════════════════════════════════════╝

        Called by the specialist when it's done with its job.
        - Restores the manager's system prompt.
        - Clears specialist tools.
        - Logs what was accomplished in memory.
        """
        # Reset to manager state
        self.system_prompt = self._manager_prompt
        self.current_tools = []
        self.chat = None  # Fresh chat session for the manager

        # Log the handover in memory
        summary_text = f"Specialist done → {work_summary}"
        if next_steps:
            summary_text += f" | Next: {next_steps}"
        self.memory.add_step(summary_text, status="done")

        self._log("Kill Switch", "Specialist finished. Manager resumed.", Colors.YELLOW)
        return f"Manager restored. Work done: {work_summary}"

    # ═══════════════════════════════════════════════════════════════════════════
    # RUN SKILL IN ISOLATION (runs a skill without switching the manager)
    # ═══════════════════════════════════════════════════════════════════════════

    def _run_skill_isolated(self, skill_name: str, query: str) -> dict:
        """
        Run a specialist skill in an isolated chat session.

        Unlike find_and_use_skill, this does NOT switch the manager's mode.
        It creates a temporary chat with the skill's prompt and tools,
        runs the query through it, handles tool calls, and returns the result.
        """
        step_id = self.memory.add_step(f"Running skill (isolated): {skill_name}", status="in_progress")
        skill_file = os.path.join(self.SKILLS_DIR, f"{skill_name}.md")

        if not os.path.exists(skill_file):
            self.memory.update_step(step_id, "error")
            return {"error": f"Skill '{skill_name}' not found in skills/ folder."}

        try:
            content = open(skill_file, encoding="utf-8").read().strip()

            # Parse skill prompt and tools
            if "---TOOLS---" in content:
                prompt_part, tools_part = content.split("---TOOLS---", 1)
                skill_prompt = prompt_part.strip() + REPORTING_INSTRUCTION
                skill_tools = json.loads(tools_part.strip())
            else:
                skill_prompt = content + REPORTING_INSTRUCTION
                skill_tools = []

            # Build tool declarations for the isolated session
            seen_tools = {}
            for t in (MANAGER_TOOLS + skill_tools):
                if "name" in t:
                    seen_tools[t["name"]] = t
            tool_declarations = [
                types.Tool(function_declarations=[types.FunctionDeclaration(**t)])
                for t in seen_tools.values()
            ]

            # Create an isolated chat session
            isolated_chat = self.client.chats.create(
                model=self.MODEL_ID,
                config=types.GenerateContentConfig(
                    system_instruction=skill_prompt,
                    tools=tool_declarations,
                ),
            )

            # Send the query
            with Spinner(f"Running skill '{skill_name}'..."):
                response = isolated_chat.send_message(query)

            # Handle tool calls within the isolated session
            max_iterations = 20  # Safety limit
            iteration = 0
            while (response.candidates[0].content.parts
                   and any(p.function_call for p in response.candidates[0].content.parts)
                   and iteration < max_iterations):
                iteration += 1
                function_responses = []

                for part in response.candidates[0].content.parts:
                    if not part.function_call:
                        continue

                    fn_name = part.function_call.name
                    fn_args = dict(part.function_call.args)
                    self._log("Isolated Tool", f"{skill_name}.{fn_name}({fn_args})")

                    if fn_name == "reset_to_manager":
                        # Skill is done — capture the summary and stop
                        work_summary = fn_args.get("work_summary", "Completed")
                        self.memory.update_step(step_id, "success")
                        self.memory.add_step(
                            f"Isolated skill '{skill_name}' done → {work_summary}",
                            status="done",
                        )
                        return {"result": work_summary}
                    elif fn_name in ("list_skills", "find_and_use_skill", "run_skill"):
                        # Don't allow nested skill switching from isolated mode
                        function_responses.append(
                            types.Part.from_function_response(
                                name=fn_name,
                                response={"error": "Not available in isolated skill mode."},
                            )
                        )
                    else:
                        # Run the tool script normally
                        tool_result = self._run_tool_script(fn_name, fn_args)
                        function_responses.append(
                            types.Part.from_function_response(name=fn_name, response=tool_result)
                        )

                if function_responses:
                    with Spinner(f"Skill '{skill_name}' processing..."):
                        response = isolated_chat.send_message(function_responses)
                else:
                    break

            self.memory.update_step(step_id, "success")
            return {"result": response.text or "[No response from skill]"}

        except Exception as e:
            self.memory.update_step(step_id, "error")
            return {"error": f"Error running skill '{skill_name}': {e}"}

    # ═══════════════════════════════════════════════════════════════════════════
    # TOOL SCRIPT RUNNER (runs Python scripts from tools/ folder)
    # ═══════════════════════════════════════════════════════════════════════════

    def _run_tool_script(self, tool_name: str, params: dict) -> dict:
        """
        Execute a Python script from the tools/ folder.

        The script is expected to:
          - Accept a JSON string as its first argument (sys.argv[1])
          - Print a JSON result to stdout

        Example: tools/add.py '{"a": 1, "b": 2}' → {"result": 3}
        """
        step_id = self.memory.add_step(f"Running tool: {tool_name}", status="in_progress")
        script_path = os.path.join(self.TOOLS_DIR, f"{tool_name}.py")

        if not os.path.exists(script_path):
            self.memory.update_step(step_id, "error")
            return {"error": f"Tool script '{tool_name}.py' not found in tools/ folder."}

        with Spinner(f"Running '{tool_name}'..."):
            try:
                result = subprocess.run(
                    [sys.executable, script_path, json.dumps(params)],
                    cwd=self.BASE_DIR,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                # Tools may print progress lines before their JSON result
                # (which may itself span several lines); parse the last
                # JSON object found in stdout.
                output = None
                stdout = result.stdout.strip()
                decoder = json.JSONDecoder()
                for i in range(len(stdout)):
                    if stdout[i] not in "{[":
                        continue
                    try:
                        output, end = decoder.raw_decode(stdout, i)
                    except json.JSONDecodeError:
                        continue
                    if not stdout[end:].strip():
                        break
                    output = None
                if output is None:
                    raise ValueError(
                        f"Tool returned no JSON. stdout: {result.stdout[-500:]!r} "
                        f"stderr: {result.stderr[-500:]!r}"
                    )
                self.memory.update_step(step_id, "success")
                return output
            except Exception as e:
                self.memory.update_step(step_id, "error")
                return {"error": str(e)}

    # ═══════════════════════════════════════════════════════════════════════════
    # CORE RUN LOOP — where the magic happens
    # ═══════════════════════════════════════════════════════════════════════════

    def _build_tool_declarations(self) -> list:
        """
        Build the complete list of tools available to the LLM.
        Always includes MANAGER_TOOLS + any tools from the loaded skill.
        Deduplicates tools by name to avoid 'Duplicate function declaration' errors.
        """
        # Deduplicate tools by name (skill-specific tools override global ones if names clash)
        seen_tools = {}
        for t in (MANAGER_TOOLS + self.current_tools):
            if "name" in t:
                seen_tools[t["name"]] = t
            
        return [
            types.Tool(function_declarations=[types.FunctionDeclaration(**t)])
            for t in seen_tools.values()
        ]

    def _ensure_chat(self):
        """Create a chat session if one doesn't exist (or was reset)."""
        if not self.chat:
            # Inject memory context into the system prompt so the LLM knows what happened
            memory_context = self.memory.get_summary()
            full_prompt = self.system_prompt
            if memory_context != "No activity recorded yet.":
                full_prompt += f"\n\n--- MEMORY (what you've done so far) ---\n{memory_context}"

            self.chat = self.client.chats.create(
                model=self.MODEL_ID,
                config=types.GenerateContentConfig(
                    system_instruction=full_prompt,
                    tools=self._build_tool_declarations(),
                ),
            )

    def run(self, user_message: str) -> str:
        """
        Process a user message. This is the main entry point.

        Flow:
            1. Send message to the LLM.
            2. If the LLM wants to call a tool → execute it and send the result back.
            3. Repeat step 2 until the LLM gives a text response.
            4. Return the text response.

        Special cases:
            - find_and_use_skill → may switch to specialist mode.
            - reset_to_manager  → switches back to manager mode (kill switch).
        """
        self._log(self._role_label, "Processing...", self._role_color)
        self._ensure_chat()

        # Send the message to the LLM
        with Spinner(f"{self._role_label} thinking..."):
            response = self.chat.send_message(user_message)

        # ── Tool Call Loop ────────────────────────────────────────────────────
        while response.candidates[0].content.parts and any(p.function_call for p in response.candidates[0].content.parts):
            function_responses = []
            immediate_return = None

            for part in response.candidates[0].content.parts:
                if not part.function_call:
                    continue

                fn_name = part.function_call.name
                fn_args = dict(part.function_call.args)
                self._log("Tool Call", f"{fn_name}({fn_args})")

                # ── Handle: list_skills ────────────────────────────────────────
                if fn_name == "list_skills":
                    result = self._list_skills()
                    function_responses.append(
                        types.Part.from_function_response(name=fn_name, response={"skills": result})
                    )

                # ── Handle: find_and_use_skill (load & switch to specialist) ──
                elif fn_name == "find_and_use_skill":
                    skill_name = fn_args.get("skill_name", "")
                    self.find_and_use_skill(skill_name)
                    # This switches modes — we must restart the 'run' with the original query
                    immediate_return = self.run(
                        f"User's original request: '{user_message}'. "
                        f"Please complete this and call reset_to_manager when done."
                    )
                    break

                # ── Handle: run_skill (run a skill without switching modes) ──
                elif fn_name == "run_skill":
                    skill_result = self._run_skill_isolated(
                        fn_args.get("skill_name", ""),
                        fn_args.get("query", ""),
                    )
                    self._log("Skill Result", f"{fn_args.get('skill_name', '?')} → done", Colors.GREEN)
                    function_responses.append(
                        types.Part.from_function_response(name=fn_name, response=skill_result)
                    )

                # ── Handle: reset_to_manager (KILL SWITCH) ────────────────────
                elif fn_name == "reset_to_manager":
                    result = self.reset_to_manager(
                        fn_args.get("work_summary", ""),
                        fn_args.get("next_steps", ""),
                    )
                    # This switches back to manager — restart with context
                    immediate_return = self.run(
                        f"Specialist finished. {result}. "
                        f"Check memory for any next steps."
                    )
                    break

                # ── Handle: Any other tool (from a loaded skill) ──────────────
                else:
                    tool_result = self._run_tool_script(fn_name, fn_args)
                    function_responses.append(
                        types.Part.from_function_response(name=fn_name, response=tool_result)
                    )

            if immediate_return:
                return immediate_return

            if function_responses:
                with Spinner("Processing results..."):
                    response = self.chat.send_message(function_responses)
            else:
                break

        # ── Done — return the LLM's text response ────────────────────────────
        return response.text or "[No response]"

    # ═══════════════════════════════════════════════════════════════════════════
    # DIAGNOSTICS — show what the agent has been doing
    # ═══════════════════════════════════════════════════════════════════════════

    def show_history(self):
        """Print the full activity log from memory."""
        divider = "─" * 50
        print(f"\n{Colors.BOLD}{divider}{Colors.RESET}")
        print(f"{Colors.BOLD}  📋 Agent Activity Log{Colors.RESET}")
        print(f"{Colors.BOLD}{divider}{Colors.RESET}")
        print(self.memory.get_summary())
        print(f"{Colors.BOLD}{divider}{Colors.RESET}\n")


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT — run this file directly to test
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    agent = Agent()

    print(f"\n{Colors.BOLD}{'═' * 50}{Colors.RESET}")
    print(f"{Colors.BOLD}  🤖 Agent System — Interactive Mode{Colors.RESET}")
    print(f"{Colors.BOLD}{'═' * 50}{Colors.RESET}")
    print(f"{Colors.CYAN}Type 'quit' to exit, 'history' to see activity log.{Colors.RESET}\n")

    while True:
        try:
            query = input(f"{Colors.BOLD}You: {Colors.RESET}").strip()

            if not query:
                continue
            if query.lower() in ("quit", "exit", "q"):
                print(f"\n{Colors.GREEN}Goodbye! 👋{Colors.RESET}\n")
                break
            if query.lower() == "history":
                agent.show_history()
                continue
            if query.lower() == "clear":
                agent.memory.clear()
                print(f"{Colors.GREEN}Memory cleared.{Colors.RESET}")
                continue

            answer = agent.run(query)
            print(f"\n{Colors.GREEN}{Colors.BOLD}Agent:{Colors.RESET} {answer}\n")

        except KeyboardInterrupt:
            print(f"\n\n{Colors.GREEN}Goodbye! 👋{Colors.RESET}\n")
            break
