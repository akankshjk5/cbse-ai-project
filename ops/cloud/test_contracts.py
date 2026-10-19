"""The client and the services must agree, checked without running either.

This exists because of a real mistake. `local_models.speak()` posted to
`/speak` with `{text, language, voice, pace}`. The service is
`ops/runpod/local_tts_service.py`, it serves `/synthesize`, and it reads
`transcript` and `languageCode`. Nothing caught it, because nothing could: the
only place the two meet is a running GPU host, and that is the worst place to
discover an invented schema.

So the service sources are parsed and compared against what the client sends.
These are static checks — they prove the names agree, not that a service
behaves. A real request still needs a real host, which is what the benchmark
is for.

    python -m pytest ops/cloud/test_contracts.py -q
"""
from __future__ import annotations

import ast
import re
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNPOD = HERE.parent / "runpod"
sys.path.insert(0, str(HERE))

import local_models as lm  # noqa: E402


def payload_keys(source: Path) -> set[str]:
    """Every `payload.get("x")` / `payload["x"]` key a service reads."""
    text = source.read_text(encoding="utf-8")
    keys = set(re.findall(r'payload\.get\(\s*"([A-Za-z0-9_]+)"', text))
    keys |= set(re.findall(r'payload\[\s*"([A-Za-z0-9_]+)"\s*\]', text))
    return keys


def served_paths(source: Path) -> set[str]:
    """Every path the handler compares `self.path` against."""
    text = source.read_text(encoding="utf-8")
    return set(re.findall(r'self\.path\s*[!=]=\s*"(/[A-Za-z0-9_/-]*)"', text))


def client_sends(function_name: str) -> set[str]:
    """The JSON keys a client function puts in its payload.

    Read from the AST rather than by calling it, so no service is needed and a
    renamed key cannot slip past by never being exercised.
    """
    tree = ast.parse((HERE / "local_models.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function_name:
            keys: set[str] = set()
            for inner in ast.walk(node):
                if isinstance(inner, ast.Dict):
                    for key in inner.keys:
                        if isinstance(key, ast.Constant) and isinstance(key.value, str):
                            keys.add(key.value)
                # payload["x"] = ...
                if isinstance(inner, ast.Subscript) and isinstance(inner.slice, ast.Constant):
                    if isinstance(inner.slice.value, str):
                        keys.add(inner.slice.value)
            return keys
    raise AssertionError(f"{function_name} is not defined in local_models.py")


class ServicePaths(unittest.TestCase):
    """Each client posts to a path its service actually serves."""

    CASES = [
        ("tts", "local_tts_service.py", "/synthesize"),
        ("translate", "local_translation_service.py", "/translate"),
        ("planner", "local_planner_service.py", "/structured"),
    ]

    def test_paths_are_served(self):
        for name, filename, expected in self.CASES:
            with self.subTest(service=name):
                source = RUNPOD / filename
                self.assertTrue(source.is_file(), f"{filename} is missing")
                self.assertEqual(
                    lm.SERVICE_PATHS[name], expected,
                    f"the client posts to {lm.SERVICE_PATHS[name]} for {name}")
                paths = served_paths(source)
                # A service that only guards /health still routes everything
                # else to its one handler, so an exact match is not required —
                # but a path it explicitly rejects would be a bug.
                if paths and expected not in paths:
                    self.assertNotIn(
                        expected, {p for p in paths if p != "/health"},
                        f"{filename} appears to reject {expected}")

    def test_vision_path_matches_the_worker(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        self.assertIn('"/check"', worker.replace("+ \"/check\"", '"/check"'),
                      "the worker no longer posts to /check")
        self.assertEqual(lm.SERVICE_PATHS["vision"], "/check")

    def test_health_is_served_everywhere(self):
        for filename in ("local_tts_service.py", "local_translation_service.py",
                         "local_planner_service.py"):
            with self.subTest(service=filename):
                self.assertIn("/health", served_paths(RUNPOD / filename),
                              f"{filename} serves no /health, so readiness cannot probe it")


class PayloadShapes(unittest.TestCase):
    """Every key the client sends is a key the service reads."""

    def test_tts(self):
        service = payload_keys(RUNPOD / "local_tts_service.py")
        sent = client_sends("synthesize")
        for key in ("transcript", "languageCode", "pace"):
            self.assertIn(key, sent, f"the client no longer sends {key}")
            self.assertIn(key, service, f"local_tts_service.py no longer reads {key}")
        # The old invented names must not come back.
        for wrong in ("text", "language", "voice"):
            self.assertNotIn(wrong, sent, f"the client sends the invented key {wrong}")

    def test_translate(self):
        service = payload_keys(RUNPOD / "local_translation_service.py")
        sent = client_sends("translate")
        for key in ("texts", "languageCode"):
            self.assertIn(key, sent)
            self.assertIn(key, service)

    def test_planner(self):
        service = payload_keys(RUNPOD / "local_planner_service.py")
        sent = client_sends("plan_structured")
        for key in ("systemPrompt", "userPrompt", "jsonSchema", "maxNewTokens"):
            self.assertIn(key, sent)
            self.assertIn(key, service)

    def test_vision(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        sent = client_sends("vision_check")
        for key in ("description", "mode", "imageBase64"):
            self.assertIn(key, sent)
            self.assertIn(f'"{key}"', worker,
                          f"the worker no longer sends {key} to the vision service")


class VerdictKeys(unittest.TestCase):
    """The vision verdict keys the benchmark reads are the ones the worker reads."""

    def test_verdict_keys_match_the_worker(self):
        worker = (RUNPOD / "media_worker.py").read_text(encoding="utf-8")
        for key in ("passed", "shows_subject", "deformed", "has_writing", "unsafe"):
            self.assertIn(f'verdict.get("{key}"', worker,
                          f"the worker no longer reads {key}")


class WorkflowSlots(unittest.TestCase):
    """The benchmark fills exactly the slots the shipped workflows declare."""

    def test_every_slot_is_supplied(self):
        import json
        workflows = RUNPOD / "workflows" / "api"
        supplied = {
            "image-fast.json": {"prompt", "width", "height", "seed"},
            "video-fast.json": {"prompt", "negative_prompt", "width", "height",
                                "frames", "seed", "steps", "fps", "source_image"},
        }
        for name, provided in supplied.items():
            with self.subTest(workflow=name):
                graph = json.loads((workflows / name).read_text(encoding="utf-8"))
                declared = {
                    value[2:-2].lower()
                    for node in graph.values()
                    for value in (node.get("inputs") or {}).values()
                    if isinstance(value, str) and value.startswith("__") and value.endswith("__")
                }
                self.assertEqual(
                    declared, provided,
                    f"{name} declares {sorted(declared)}, benchmark supplies {sorted(provided)}")


class TypeScriptPlannerClient(unittest.TestCase):
    """Agents/local-planner.ts and the planner service must agree too.

    The Python client is checked above. The TypeScript one is what
    `Agents/lesson-deck.ts` calls, so it is the first thing that will reach a
    real planner on the GPU server — and nothing compared the two until now.
    """

    def ts_source(self) -> str:
        return (HERE.parent.parent / "Agents" / "local-planner.ts").read_text(encoding="utf-8")

    def body_keys(self) -> set[str]:
        """The JSON keys the client actually sends.

        Taken by POSITION, not by substring. `assertIn("jsonSchema", body)`
        passes happily on `schema: jsonSchema` — the key renamed, the value
        untouched — which is exactly the drift this class exists to catch, and
        a mutation test caught the first version failing to catch it.
        """
        ts = self.ts_source()
        # The body literal only: `signal` is a sibling of `body` in the fetch
        # init and is not part of the payload.
        body = ts.split("body: JSON.stringify({", 1)[1].split("}),", 1)[0]
        keys = set()
        for line in body.splitlines():
            match = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:,]", line)
            if match:
                keys.add(match.group(1))
        return keys

    def test_request_keys_match(self):
        service = payload_keys(RUNPOD / "local_planner_service.py")
        sent = self.body_keys()
        for key in ("systemPrompt", "userPrompt", "jsonSchema", "maxNewTokens"):
            self.assertIn(key, sent, f"local-planner.ts stopped sending {key}")
            self.assertIn(key, service, f"the service stopped reading {key}")
        self.assertEqual(
            sent, {"systemPrompt", "userPrompt", "jsonSchema", "maxNewTokens"},
            f"local-planner.ts sends unexpected keys: {sorted(sent)}")

    def test_response_keys_match(self):
        ts = self.ts_source()
        service = (RUNPOD / "local_planner_service.py").read_text(encoding="utf-8")
        for key in ("output", "model"):
            self.assertIn(f"envelope.{key}", ts, f"local-planner.ts stopped reading {key}")
            self.assertIn(f'"{key}"', service, f"the service stopped writing {key}")

    def test_token_bounds_agree(self):
        """Both sides clamp to 512..5000. A client that asked for more would
        have its request silently shortened, and a plan truncated mid-JSON
        fails schema validation with no hint of why."""
        ts = self.ts_source()
        service = (RUNPOD / "local_planner_service.py").read_text(encoding="utf-8")
        self.assertIn("512", ts)
        self.assertIn("5000", ts.replace("5_000", "5000"))
        self.assertIn("512", service)
        self.assertIn("5000", service.replace("5_000", "5000"))

    def test_path_is_structured(self):
        self.assertIn("/structured", self.ts_source(),
                      "local-planner.ts must post to /structured")


class RunbookMatchesServices(unittest.TestCase):
    """The runbook must describe the services that exist, not remembered ones.

    This exists because of a real mistake too, and a worse one than the
    `/speak` invention: `RUNBOOK-48GB.md` told an operator to
    `pip install pillow fonttools pynvml`, and that was the whole list. All
    four services import `transformers`, TTS also needs `parler_tts`, `scipy`
    and `numpy`, and translation needs `IndicTransToolkit`. Following the
    runbook exactly produced four `ModuleNotFoundError`s on a rented GPU
    charged by the minute.

    It also claimed 48 GB "keeps them resident". Every service parks on the
    CPU and borrows the GPU per request, so nothing is resident -- and the
    weights total ~61 GiB, which would not fit in 48 GB anyway. Two
    unverifiable claims in one sentence, in the document whose entire purpose
    is to be followed on a machine the author cannot inspect.

    Prose cannot be type-checked, so these parse the services and assert the
    runbook mentions what they actually require. A doc test is a weak test; it
    is still much stronger than nobody having read the file.
    """

    #: import name -> what an operator would search the runbook for.
    PIP_NAME = {"PIL": "pillow", "parler_tts": "parler-tts",
                "IndicTransToolkit": "IndicTransToolkit"}

    SERVICES = ("local_planner_service.py", "local_tts_service.py",
                "local_translation_service.py", "local_vision_service.py")

    def runbook(self) -> str:
        return (HERE / "RUNBOOK-48GB.md").read_text(encoding="utf-8")

    def third_party_imports(self, source: Path) -> set[str]:
        tree = ast.parse(source.read_text(encoding="utf-8"))
        found: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                found.add(node.module.split(".")[0])
        return {m for m in found if m not in sys.stdlib_module_names}

    def env_vars(self, source: Path) -> set[str]:
        """Every `os.environ.get("NAME", ...)` the service reads.

        Taken from the AST, not a line regex: three of these have their
        default on a continuation line, and a line-oriented grep silently
        missed them while appearing to work.
        """
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names: set[str] = set()
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "get" and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                    and node.args[0].value.isupper()):
                names.add(node.args[0].value)
        return names

    def install_commands(self) -> str:
        """Only the `pip install` lines.

        Searching the whole document was not enough: `transformers` is named in
        a prose paragraph about `torch_dtype`, so deleting its install command
        left this test green. A package has to be installed, not discussed.
        """
        return "\n".join(
            line for line in self.runbook().splitlines()
            if line.strip().startswith("pip install"))

    def test_every_service_dependency_is_installed_by_the_runbook(self):
        runbook = self.install_commands()
        self.assertTrue(runbook.strip(), "the runbook has no pip install lines at all")
        for filename in self.SERVICES:
            for module in sorted(self.third_party_imports(RUNPOD / filename)):
                if module == "torch":
                    continue  # installed from the CUDA index, its own step
                searched = self.PIP_NAME.get(module, module)
                with self.subTest(service=filename, package=searched):
                    self.assertIn(
                        searched, runbook,
                        f"{filename} imports {module}, but no `pip install` "
                        f"line in the runbook installs {searched}")

    def test_every_env_var_the_services_read_is_documented(self):
        runbook = self.runbook()
        for filename in self.SERVICES:
            for var in sorted(self.env_vars(RUNPOD / filename)):
                with self.subTest(service=filename, var=var):
                    self.assertIn(
                        var, runbook,
                        f"{filename} reads {var}, and the runbook never names "
                        f"it -- an operator cannot set what is not written down")

    def test_runbook_does_not_claim_models_stay_resident(self):
        """The specific false claim, kept out by name.

        A reader who believes it rents a 48 GB card to avoid a model swap that
        no code path avoids.
        """
        # Blockquotes are excluded: the runbook quotes the old wrong claim in
        # order to retract it, and a document that cannot quote its own
        # mistakes cannot correct them in public. Only the runbook's own voice
        # is checked.
        runbook = "\n".join(
            line for line in self.runbook().lower().splitlines()
            if not line.lstrip().startswith(">"))
        for claim in ("keeps them resident", "keeps them loaded",
                      "stay resident", "remain resident"):
            self.assertNotIn(
                claim, runbook,
                f'the runbook claims models "{claim}", but every service calls '
                f'.to("cpu") after each request')

    def test_runbook_warns_that_nothing_self_fetches(self):
        """`local_files_only=True` turns a missing directory into a crash."""
        uses_it = [f for f in self.SERVICES
                   if "local_files_only" in (RUNPOD / f).read_text(encoding="utf-8")]
        self.assertTrue(uses_it, "no service pins local_files_only any more")
        self.assertIn(
            "local_files_only", self.runbook(),
            f"{len(uses_it)} services refuse to download their own weights; the "
            f"runbook must say so, or a missing directory looks like a hang")

    def test_runbook_addresses_the_transformers_keyword_split(self):
        """One service uses `dtype=`, two use `torch_dtype=`.

        Both spellings must be accepted by whatever version is installed, so
        the version is a real constraint and the runbook has to mention it.
        """
        sources = {f: (RUNPOD / f).read_text(encoding="utf-8") for f in self.SERVICES}
        new_style = [f for f, s in sources.items() if re.search(r"[^_]dtype=torch", s)]
        old_style = [f for f, s in sources.items() if "torch_dtype=" in s]
        if not (new_style and old_style):
            self.skipTest("the sources no longer mix dtype= and torch_dtype=")
        runbook = self.runbook()
        self.assertIn(
            "torch_dtype", runbook,
            f"{new_style} use dtype= while {old_style} use torch_dtype=, so the "
            f"installed transformers must accept both -- the runbook must say so")

    def test_runbook_does_not_cite_env_example_for_variables_it_lacks(self):
        """`.env.example` named three of six model paths.

        The runbook cited it as the source for a variable it does not contain,
        which sends an operator to a file that will not help them.
        """
        example = RUNPOD / ".env.example"
        if not example.is_file():
            self.skipTest(".env.example does not exist")
        declared = set(re.findall(r"^([A-Z_0-9]+)=", example.read_text(encoding="utf-8"),
                                  re.MULTILINE))
        paths = {v for f in self.SERVICES for v in self.env_vars(RUNPOD / f)
                 if v.endswith("_PATH")}
        missing = sorted(paths - declared)
        if not missing:
            return
        runbook = self.runbook()
        for var in missing:
            with self.subTest(var=var):
                self.assertIn(
                    var, runbook,
                    f"{var} is not in .env.example, so the runbook is the only "
                    f"place an operator could learn it exists")


class BenchmarkBudget(unittest.TestCase):
    """The ceilings that stop a metered box running unattended.

    The benchmark had neither a time nor a money limit. A stage that hangs --
    Wan on an undersized card being the obvious candidate -- ran until someone
    noticed, and the only record of the cost was the invoice. A benchmark whose
    purpose is to measure cost should not be the thing that produces an
    unmeasured one.

    The cost is `estimated` and never `measured`: elapsed time times a rate the
    operator typed. Asserted here because the difference is the whole point of
    the cost_basis vocabulary used across this codebase.
    """

    def budget(self, *args, **kwargs):
        import benchmark  # noqa: PLC0415 — imported late; it pulls in optional deps
        return benchmark.Budget(*args, **kwargs)

    def exhausted(self):
        import benchmark  # noqa: PLC0415
        return benchmark.BudgetExhausted

    def test_no_limits_never_aborts_and_reports_unknown_cost(self):
        b = self.budget(None, None, None)
        b.check()  # must not raise
        facts = b.facts()
        self.assertFalse(facts["aborted"])
        self.assertIsNone(facts["estimated_cost_usd"])
        self.assertEqual(facts["cost_basis"], "unknown",
                         "with no rate supplied the cost is unknown, not zero")

    def test_wall_clock_ceiling_aborts_with_a_reason(self):
        b = self.budget(0.0001, None, None)
        time.sleep(0.02)
        with self.assertRaises(self.exhausted()) as caught:
            b.check()
        self.assertIn("wall-clock budget", str(caught.exception))
        self.assertTrue(b.facts()["aborted"])
        self.assertIn("wall-clock", b.facts()["abort_reason"])

    def test_money_ceiling_aborts_with_a_reason(self):
        # $3600/hour makes a second cost a dollar, so the ceiling is reachable
        # without the test sleeping for any length of time.
        b = self.budget(None, 3600.0, 0.5)
        time.sleep(0.6)
        with self.assertRaises(self.exhausted()) as caught:
            b.check()
        self.assertIn("exceeded", str(caught.exception))
        self.assertIn("ceiling", b.facts()["abort_reason"])

    def test_cost_is_estimated_never_measured(self):
        b = self.budget(None, 0.33, None)
        time.sleep(0.02)
        facts = b.facts()
        self.assertEqual(facts["cost_basis"], "estimated")
        self.assertNotEqual(facts["cost_basis"], "measured",
                            "a rate times elapsed time is not a measurement")
        self.assertEqual(facts["usd_per_hour"], 0.33)

    def test_a_rate_without_a_ceiling_records_but_does_not_abort(self):
        b = self.budget(None, 0.33, None)
        time.sleep(0.02)
        b.check()  # must not raise
        self.assertFalse(b.facts()["aborted"])
        self.assertIsNotNone(b.facts()["estimated_cost_usd"])

    def test_the_report_carries_a_budget_field(self):
        """A report with no budget section would hide an abort."""
        source = (HERE / "benchmark.py").read_text(encoding="utf-8")
        self.assertIn("budget: dict = field(default_factory=dict)", source,
                      "Benchmark must carry a budget field")
        self.assertIn("report.budget = budget.facts()", source,
                      "the budget must be written onto the report")

    def test_skipped_stages_are_not_executed_rather_than_failed(self):
        """A stage that never started must not read as a stage that failed.

        Checked in the source because exercising it needs a ready host: the
        benchmark refuses before measuring when readiness fails, so the
        between-stages abort path cannot run on a box with no GPU.
        """
        source = (HERE / "benchmark.py").read_text(encoding="utf-8")
        self.assertIn("NOT_EXECUTED:", source,
                      "stages skipped by the budget must be marked NOT_EXECUTED")
        self.assertIn("for skipped in stage_names[index:]", source,
                      "the remaining stages must be recorded, not dropped")

    def test_the_benchmark_starts_nothing_it_has_to_pay_for(self):
        """It requires an already-running host; it must not create one.

        Checked by IMPORTS, not by substring. The first version of this test
        searched the source text for "runpod" and failed on
        `ops/runpod/workflows/api` -- a directory path, not a provisioning
        call. A test that cannot tell those apart would have to be silenced,
        and a silenced test guards nothing.
        """
        tree = ast.parse((HERE / "benchmark.py").read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {a.name.split(".")[0] for a in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module.split(".")[0])
        for sdk in ("boto3", "runpod", "googleapiclient", "azure", "paramiko", "libcloud"):
            self.assertNotIn(sdk, imported,
                             f"the benchmark imports {sdk}; it must not be able to "
                             f"provision or bill anything")
        # And no shelling out to a provisioning CLI.
        source = (HERE / "benchmark.py").read_text(encoding="utf-8")
        for command in ("terraform", "docker run", "runpodctl", "aws ec2", "gcloud compute"):
            self.assertNotIn(command, source,
                             f"the benchmark shells out to {command!r}")


class PreflightProbes(unittest.TestCase):
    """The three gates added to check_server.py.

    Each existed as a paragraph in RUNBOOK-48GB.md and as a defect that had
    already happened: following the runbook installed none of the services'
    dependencies, and all four died at import.
    """

    def server(self):
        import check_server  # noqa: PLC0415
        return check_server

    def test_service_dependencies_match_the_sources(self):
        """The hardcoded list must be what the services actually import."""
        cs = self.server()
        for filename, declared in cs.SERVICE_DEPS.items():
            with self.subTest(service=filename):
                source = RUNPOD / filename
                self.assertTrue(source.is_file(), f"{filename} is missing")
                tree = ast.parse(source.read_text(encoding="utf-8"))
                imported = set()
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        imported |= {a.name.split(".")[0] for a in node.names}
                    elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                        imported.add(node.module.split(".")[0])
                third_party = {m for m in imported
                               if m not in sys.stdlib_module_names and m != "torch"}
                self.assertEqual(
                    set(declared), third_party,
                    f"{filename} imports {sorted(third_party)} but preflight checks "
                    f"{sorted(declared)}")

    def test_disk_probe_reports_a_floor_and_a_verdict(self):
        cs = self.server()
        facts = cs.disk_facts(HERE)
        self.assertTrue(facts["checked"])
        for key in ("free_gib", "total_gib", "floor_gib", "ok"):
            self.assertIn(key, facts)
        self.assertGreater(facts["floor_gib"], 0, "a floor of zero gates nothing")
        self.assertEqual(facts["ok"], facts["free_gib"] >= facts["floor_gib"])

    def test_disk_probe_walks_up_to_an_existing_parent(self):
        """--models-root may name a directory that does not exist yet."""
        cs = self.server()
        facts = cs.disk_facts(HERE / "no-such-dir" / "deeper" / "still-not-there")
        self.assertTrue(facts["checked"],
                        "a missing path must resolve to its nearest real parent")

    def test_torch_probe_never_claims_cuda_it_did_not_see(self):
        cs = self.server()
        facts = cs.torch_facts()
        self.assertIn("installed", facts)
        self.assertIn("cuda_available", facts)
        if not facts["installed"]:
            self.assertFalse(facts["cuda_available"],
                             "CUDA cannot be available when torch is absent")
            self.assertIn("error", facts, "an absent torch must say so")

    def test_dependency_probe_names_the_service_that_needs_each_module(self):
        cs = self.server()
        facts = cs.dependency_facts()
        self.assertIn("ok", facts)
        self.assertIn("missing_by_service", facts)
        self.assertEqual(facts["ok"], not facts["missing_by_service"])
        for service in facts["missing_by_service"]:
            self.assertIn(service, cs.SERVICE_DEPS,
                          "a reported service must be one preflight knows about")


class ModelManifest(unittest.TestCase):
    """models.json must describe the models the code actually loads.

    docs/model-licences.md is the prose audit. This is its machine-readable
    companion, and the two drifting apart would be worse than having only one:
    a report that cites a licence nobody checked reads as evidence.

    Every revision is currently null. That is asserted rather than treated as
    incomplete, because a plausible commit SHA written by hand would be
    invented evidence, and `reproducible: false` is the honest state until a
    download has happened.
    """

    def manifest(self):
        import model_manifest  # noqa: PLC0415
        return model_manifest

    def data(self):
        return self.manifest().load()

    def test_every_comfyui_weight_is_in_the_manifest(self):
        """REQUIRED_WEIGHTS is what the workflows load; the manifest must cover it."""
        declared = {m.get("file") for m in self.data()["models"] if m.get("file")}
        for files in lm.REQUIRED_WEIGHTS.values():
            for subdir, name in files:
                with self.subTest(weight=f"{subdir}/{name}"):
                    self.assertIn(
                        f"{subdir}/{name}", declared,
                        "a weight the workflows load is absent from models.json, so "
                        "no report can say which revision produced it")

    def test_every_service_model_names_a_variable_a_service_reads(self):
        """A manifest entry pointing at an unread variable would never resolve."""
        read = set()
        for filename in ("local_planner_service.py", "local_tts_service.py",
                         "local_translation_service.py", "local_vision_service.py"):
            source = (RUNPOD / filename).read_text(encoding="utf-8")
            read |= set(re.findall(r'"([A-Z][A-Z_0-9]*_PATH)"', source))
        for model in self.data()["models"]:
            if model["kind"] != "service":
                continue
            with self.subTest(model=model["name"]):
                self.assertIn(
                    model["env"], read,
                    f"{model['name']} points at {model['env']}, which no service reads")

    def test_licences_agree_with_the_prose_audit(self):
        """A licence in two places must be the same licence in both."""
        audit = (HERE.parent.parent / "docs" / "model-licences.md").read_text(encoding="utf-8")
        for model in self.data()["models"]:
            with self.subTest(model=model["name"]):
                self.assertIn(
                    model["repo"], audit,
                    f"{model['repo']} is in models.json but not in "
                    f"docs/model-licences.md")

    def test_nothing_claims_a_revision_it_has_not_observed(self):
        facts = self.manifest().facts()
        for model in facts["models"]:
            with self.subTest(model=model["name"]):
                if model["pinned_revision"] is None:
                    self.assertFalse(model["pinned"])
                    self.assertFalse(model["matches_pin"],
                                     "an unpinned model cannot match a pin")
        self.assertFalse(
            facts["reproducible"],
            "no model has been downloaded, so nothing may report reproducible. "
            "If this fails because revisions were genuinely pinned after a real "
            "download, update this test and say so in the commit.")

    def test_the_unresolved_licence_and_the_gated_model_stay_flagged(self):
        """The two facts a commercial decision turns on."""
        facts = self.manifest().facts()
        self.assertIn("image-vae", facts["licences_unresolved"],
                      "ae.safetensors provenance is unresolved; it must stay flagged")
        self.assertIn("translation", facts["gated_models"],
                      "IndicTrans2 is gated; an unattended download fails")

    def test_a_plain_directory_reports_no_revision_rather_than_guessing(self):
        mm = self.manifest()
        import tempfile  # noqa: PLC0415
        plain = Path(tempfile.mkdtemp())
        revision, why = mm.revision_from_path(plain)
        self.assertIsNone(revision)
        self.assertIn("no revision", why)
        revision, why = mm.revision_from_path(plain / "absent")
        self.assertIsNone(revision)
        self.assertEqual(why, "not on disk")

    def test_a_hub_snapshot_path_yields_its_commit(self):
        mm = self.manifest()
        import tempfile  # noqa: PLC0415
        root = Path(tempfile.mkdtemp())
        sha = "0" * 40
        snapshot = root / "models--Qwen--Qwen3-4B" / "snapshots" / sha
        snapshot.mkdir(parents=True)
        revision, why = mm.revision_from_path(snapshot)
        self.assertEqual(revision, sha)
        self.assertIn("snapshot", why)

    def test_the_benchmark_records_the_manifest(self):
        source = (HERE / "benchmark.py").read_text(encoding="utf-8")
        self.assertIn("models: dict = field(default_factory=dict)", source,
                      "the report must carry a models section")
        self.assertEqual(
            source.count("report.models = "), 1,
            "report.models must be assigned exactly once, before the readiness "
            "gate, so a refusal still records which models were expected")


if __name__ == "__main__":
    unittest.main()
