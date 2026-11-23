"""Post-merge patch recovery using stub installers; no network or database."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PostMergePatchRecoveryTests(unittest.TestCase):
    def run_setup(self, initial=0, repaired=0, install=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            (scripts / "post-merge.sh").write_text(
                (ROOT / "scripts/post-merge.sh").read_text()
            )
            (scripts / "validate-merged.sh").write_text(
                'echo "validate $*" >> "$CALLS"\n'
            )
            bin_dir = root / "bin"
            bin_dir.mkdir()
            stubs = {
                "pnpm": (
                    'echo "pnpm $*" >> "$CALLS"\n'
                    'if [[ "$*" == "install --force --frozen-lockfile" ]]; then\n'
                    '  touch "$REFRESHED"\n'
                    f'  exit {install}\n'
                    'fi\n'
                    '[[ "$*" == "install --frozen-lockfile" ]]\n'
                ),
                "node": (
                    '[[ "$*" == "scripts/test-braces-nesting.mjs" ]] || exit 99\n'
                    'echo probe >> "$CALLS"\n'
                    f'if [[ -f "$REFRESHED" ]]; then exit {repaired}; fi\n'
                    f'exit {initial}\n'
                ),
            }
            for name, body in stubs.items():
                executable = bin_dir / name
                executable.write_text("#!/bin/bash\n" + body)
                executable.chmod(0o755)
            result = subprocess.run(
                ["bash", str(scripts / "post-merge.sh")],
                env={
                    "PATH": f"{bin_dir}:{os.defpath}",
                    "ENVIRONMENT": "test",
                    "CALLS": str(root / "calls"),
                    "REFRESHED": str(root / "refreshed"),
                },
                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10,
            )
            return result, (root / "calls").read_text().splitlines()

    def test_healthy_install_needs_no_refresh(self):
        result, calls = self.run_setup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "pnpm install --frozen-lockfile", "probe", "validate --setup-only",
        ])

    def test_stale_patch_is_refreshed_once_then_verified(self):
        result, calls = self.run_setup(initial=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            "pnpm install --frozen-lockfile", "probe",
            "pnpm install --force --frozen-lockfile", "probe", "validate --setup-only",
        ])

    def test_failed_repair_blocks_validation(self):
        for options in ({"repaired": 1}, {"install": 2}):
            with self.subTest(options=options):
                result, calls = self.run_setup(initial=1, **options)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("validate --setup-only", calls)
                self.assertEqual(calls.count("pnpm install --force --frozen-lockfile"), 1)


if __name__ == "__main__":
    unittest.main()
