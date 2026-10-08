"""
memory.py — Scratchpad for the Agent
=====================================
This acts as the agent's notepad. Every action the agent takes is logged here
as a "step" so the agent can look back and understand:
  - What has been done so far
  - Whether each step succeeded or failed
  - What to do next

Steps are saved to a JSON file on disk so they survive restarts.
Think of it like a to-do list that the agent writes for itself.
"""

import json
import os
from datetime import datetime


class Memory:
    """
    A simple scratchpad that stores steps as a list of dicts.

    Each step looks like:
        {
            "id": 1,
            "description": "Loading skill: math_agent",
            "status": "success",          # pending | in_progress | success | error | done
            "timestamp": "2026-03-20 20:30:00"
        }
    """

    def __init__(self, storage_file="memory.json"):
        """
        Args:
            storage_file: Path to the JSON file where steps are saved.
        """
        self.storage_file = storage_file
        self.steps = []
        self._load()  # Load any existing steps from disk

    # ── Add / Update Steps ────────────────────────────────────────────────────

    def add_step(self, description: str, status: str = "pending") -> int:
        """
        Record a new step in the scratchpad.

        Args:
            description: What this step is about (e.g. "Loading skill: math_agent")
            status:      Current status — one of: pending, in_progress, success, error, done

        Returns:
            The ID of the newly created step.
        """
        step = {
            "id": len(self.steps) + 1,
            "description": description,
            "status": status,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        self.steps.append(step)
        self._save()
        return step["id"]

    def update_step(self, step_id: int, status: str) -> bool:
        """
        Update the status of an existing step.

        Args:
            step_id: The ID of the step to update.
            status:  New status string.

        Returns:
            True if the step was found and updated, False otherwise.
        """
        for step in self.steps:
            if step["id"] == step_id:
                step["status"] = status
                self._save()
                return True
        return False

    # ── Read Steps ────────────────────────────────────────────────────────────

    def get_all_steps(self) -> list:
        """Return the full list of steps."""
        return self.steps

    def get_last_step(self) -> dict | None:
        """Return the most recent step, or None if there are no steps."""
        return self.steps[-1] if self.steps else None

    def get_summary(self) -> str:
        """
        Return a human-readable summary of all steps.
        Useful for injecting into the agent's context so it knows what happened.
        """
        if not self.steps:
            return "No activity recorded yet."

        lines = []
        for s in self.steps:
            icon = "✓" if s["status"] in ("success", "done") else "✗" if s["status"] == "error" else "…"
            lines.append(f"  {icon} [{s['id']}] {s['description']}  →  {s['status']}")
        return "\n".join(lines)

    # ── Clear ─────────────────────────────────────────────────────────────────

    def clear(self):
        """Wipe all steps (fresh start)."""
        self.steps = []
        self._save()

    # ── Persistence (private) ─────────────────────────────────────────────────

    def _save(self):
        """Write steps to disk as JSON."""
        with open(self.storage_file, "w") as f:
            json.dump(self.steps, f, indent=4)

    def _load(self):
        """Read steps from disk if the file exists."""
        if os.path.exists(self.storage_file):
            try:
                with open(self.storage_file, "r") as f:
                    self.steps = json.load(f)
            except (json.JSONDecodeError, IOError):
                self.steps = []
