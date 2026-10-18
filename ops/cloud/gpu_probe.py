"""Measuring GPU use honestly, including the parts we cannot measure.

A before/after memory difference is not a peak. It is two samples with
everything interesting in between: a stage that allocates 14 GiB and frees it
before returning looks identical to one that allocated nothing. Reporting that
difference as "peak VRAM" is the single most tempting wrong number in a
benchmark, so this module does not produce it at all.

What it produces instead:

  * `CudaMemory` — exact figures from PyTorch for work in THIS process.
    `torch.cuda.max_memory_allocated` is a true peak, tracked by the allocator
    rather than sampled, so it cannot miss a spike.
  * `DeviceSamples` — timestamped NVML samples of the whole device, for work
    in another process. ComfyUI runs separately, so its memory is only
    visible this way. The maximum of a sample series is a LOWER BOUND on the
    true peak: a spike shorter than the interval is invisible, and the series
    records its own interval so a reader can see how much it could have
    missed.

The two are never added together and never conflated. Device-wide memory
includes every other process on the card; process memory excludes everything
ComfyUI does. Which one a figure came from is recorded on the figure.
"""
from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass, field


@dataclass
class CudaMemory:
    """Exact allocator figures, for work inside this process."""
    available: bool
    scope: str = "process"
    allocated_mib: float | None = None
    reserved_mib: float | None = None
    peak_allocated_mib: float | None = None
    peak_reserved_mib: float | None = None
    method: str = "torch.cuda memory_stats"
    exact: bool = True
    note: str = ("True peak: tracked by the CUDA caching allocator, not sampled. "
                 "Covers only tensors allocated in this process.")


@dataclass
class DeviceSample:
    at: float
    used_mib: int
    total_mib: int
    utilisation_percent: int | None


@dataclass
class DeviceSamples:
    """Timestamped device-wide samples, for work in another process."""
    scope: str = "device"
    method: str = ""
    interval_seconds: float = 0.0
    samples: list = field(default_factory=list)
    exact: bool = False
    limitation: str = ""

    @property
    def max_used_mib(self) -> int | None:
        return max((s.used_mib for s in self.samples), default=None)

    @property
    def max_utilisation_percent(self) -> int | None:
        values = [s.utilisation_percent for s in self.samples if s.utilisation_percent is not None]
        return max(values) if values else None

    def summary(self) -> dict:
        return {
            "scope": self.scope,
            "method": self.method,
            "interval_seconds": self.interval_seconds,
            "sample_count": len(self.samples),
            # Deliberately not called "peak". It is the largest value seen.
            "max_observed_used_mib": self.max_used_mib,
            "max_observed_utilisation_percent": self.max_utilisation_percent,
            "exact": self.exact,
            "limitation": self.limitation,
            "samples": [
                {"at": round(s.at, 3), "used_mib": s.used_mib,
                 "total_mib": s.total_mib, "utilisation_percent": s.utilisation_percent}
                for s in self.samples
            ],
        }


# ── In-process, from the allocator ──────────────────────────────────────────

def _torch():
    try:
        import torch  # noqa: PLC0415 — optional; absence is a reportable fact
        return torch if torch.cuda.is_available() else None
    except ImportError:
        return None


def reset_cuda_peak() -> bool:
    """Zero the allocator's high-water mark before timing a stage."""
    torch = _torch()
    if torch is None:
        return False
    torch.cuda.reset_peak_memory_stats()
    return True


def read_cuda_memory() -> CudaMemory:
    torch = _torch()
    if torch is None:
        return CudaMemory(
            available=False,
            note="torch is absent or reports no CUDA device, so no in-process figures exist.")
    mib = 1024 * 1024
    return CudaMemory(
        available=True,
        allocated_mib=round(torch.cuda.memory_allocated() / mib, 1),
        reserved_mib=round(torch.cuda.memory_reserved() / mib, 1),
        peak_allocated_mib=round(torch.cuda.max_memory_allocated() / mib, 1),
        peak_reserved_mib=round(torch.cuda.max_memory_reserved() / mib, 1),
    )


# ── Device-wide, sampled ────────────────────────────────────────────────────

def _nvml_handle():
    """NVML if the bindings are installed; None otherwise."""
    try:
        import pynvml  # noqa: PLC0415
        pynvml.nvmlInit()
        return pynvml, pynvml.nvmlDeviceGetHandleByIndex(0)
    except Exception:
        return None


def _sample_nvml(state) -> DeviceSample | None:
    pynvml, handle = state
    try:
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        try:
            util = pynvml.nvmlDeviceGetUtilizationRates(handle).gpu
        except Exception:
            util = None
        return DeviceSample(time.monotonic(), memory.used // (1024 * 1024),
                            memory.total // (1024 * 1024), util)
    except Exception:
        return None


def _sample_smi() -> DeviceSample | None:
    """nvidia-smi, for hosts without the NVML python bindings.

    Each call spawns a process, so the interval cannot be as tight as NVML's
    and the overhead is real. It is still a genuine timestamped reading.
    """
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10)
        if out.returncode != 0 or not out.stdout.strip():
            return None
        used, total, util = [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]
        return DeviceSample(time.monotonic(), int(used), int(total), int(util))
    except Exception:
        return None


class DeviceWatcher:
    """Samples the device on a background thread for the life of a stage.

    Used for ComfyUI, which runs in its own process: nothing the CUDA
    allocator in THIS process knows about covers it, so sampling is the only
    option available. The interval is recorded alongside the readings, because
    a maximum over samples means nothing without knowing how often they were
    taken.
    """

    def __init__(self, interval_seconds: float = 0.25) -> None:
        self.interval = interval_seconds
        self._nvml = _nvml_handle()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._samples: list = []
        self.method = "pynvml" if self._nvml else "nvidia-smi"

    def _read(self) -> DeviceSample | None:
        return _sample_nvml(self._nvml) if self._nvml else _sample_smi()

    def available(self) -> bool:
        return self._read() is not None

    def __enter__(self) -> "DeviceWatcher":
        first = self._read()
        if first is not None:
            self._samples.append(first)
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            sample = self._read()
            if sample is not None:
                self._samples.append(sample)

    def __exit__(self, *_exc) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        last = self._read()
        if last is not None:
            self._samples.append(last)

    def result(self) -> DeviceSamples:
        effective = self.interval if self.method == "pynvml" else max(self.interval, 0.5)
        return DeviceSamples(
            method=self.method,
            interval_seconds=effective,
            samples=self._samples,
            limitation=(
                f"Device-wide, including every other process on the card. Sampled every "
                f"~{effective}s, so a shorter spike is not represented: the maximum here is a "
                f"LOWER BOUND on true peak usage, not a peak."
            ),
        )


def device_facts() -> dict:
    """Static facts about the card, read once."""
    out: dict = {"measured": True, "sources": []}
    state = _nvml_handle()
    if state:
        pynvml, handle = state
        try:
            name = pynvml.nvmlDeviceGetName(handle)
            out["name"] = name.decode() if isinstance(name, bytes) else name
            memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
            out["total_vram_mib"] = memory.total // (1024 * 1024)
            out["driver"] = pynvml.nvmlSystemGetDriverVersion()
            if isinstance(out["driver"], bytes):
                out["driver"] = out["driver"].decode()
            out["sources"].append("pynvml")
        except Exception as error:
            out["nvml_error"] = str(error)
    if "name" not in out:
        sample = _sample_smi()
        if sample:
            out["total_vram_mib"] = sample.total_mib
            out["sources"].append("nvidia-smi")
    return out
