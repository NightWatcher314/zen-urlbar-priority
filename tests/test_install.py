from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from install import install


class InstallTests(unittest.TestCase):
    def test_preview_install_backup_and_unrelated_mod_preservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            registry = profile / "chrome/sine-mods/mods.json"
            registry.parent.mkdir(parents=True)
            original = '{"other":{"enabled":false,"name":"Keep me"}}'
            registry.write_text(original)
            preview = install(profile, ROOT)
            self.assertFalse(preview["applied"])
            self.assertEqual(registry.read_text(), original)
            self.assertFalse(Path(preview["destination"]).exists())
            result = install(profile, ROOT, apply=True, backup_root=Path(tmp) / "backups")
            mods = json.loads(registry.read_text())
            self.assertEqual(mods["other"], {"enabled": False, "name": "Keep me"})
            self.assertEqual((Path(result["backup"]) / "mods.json").read_text(), original)
            self.assertEqual((Path(result["destination"]) / "priority.uc.js").read_bytes(), (ROOT / "priority.uc.js").read_bytes())

    def test_failed_registry_write_restores_previous_mod_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile = Path(tmp) / "profile"
            registry = profile / "chrome/sine-mods/mods.json"
            registry.parent.mkdir(parents=True)
            original = '{}'
            registry.write_text(original)
            with patch('install.json.dump', side_effect=OSError('simulated disk write failure')):
                with self.assertRaises(OSError):
                    install(profile, ROOT, apply=True, backup_root=Path(tmp) / "backups")
            self.assertEqual(registry.read_text(), original)
            self.assertEqual(list(registry.parent.glob('*.tmp')), [])
            install(profile, ROOT, apply=True, backup_root=Path(tmp) / "backups")

    def test_missing_sine_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                install(tmp, ROOT, apply=True)


if __name__ == '__main__':
    unittest.main()
