"""Install this local package into an existing Sine profile; close Zen first."""
from argparse import ArgumentParser
from datetime import datetime
from pathlib import Path
import json
import os
import shutil
import tempfile

FILES = ("theme.json", "preferences.json", "priority.uc.js", "priority.sys.mjs")


def install(profile, source, apply=False, backup_root=None):
    profile = Path(profile).expanduser().resolve(strict=True)
    source = Path(source)
    metadata = profile / "chrome" / "sine-mods" / "mods.json"
    if not metadata.is_file():
        raise ValueError("这个 profile 没有 Sine mods.json；请先安装并启动一次 Sine。")
    mods = json.loads(metadata.read_text(encoding="utf-8"))
    if not isinstance(mods, dict):
        raise ValueError("Sine mods.json 不是对象；未修改任何文件。")
    theme = json.loads((source / "theme.json").read_text(encoding="utf-8"))
    destination = metadata.parent / theme["id"]
    if destination.is_symlink():
        raise ValueError("模组目录是符号链接；拒绝覆盖。")
    for name in FILES:
        if not (source / name).is_file():
            raise ValueError(f"缺少模组文件：{name}")
    result = {"profile": str(profile), "destination": str(destination), "applied": False}
    if not apply:
        return result

    if backup_root is None:
        backup_root = (Path(os.environ["LOCALAPPDATA"]) if os.name == "nt" else
                       Path.home() / ".local" / "state") / "zen-urlbar-priority-backups"
    Path(backup_root).mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=backup_root))
    shutil.copy2(metadata, backup / "mods.json")
    if destination.exists():
        shutil.copytree(destination, backup / "mod")
    mods[theme["id"]] = {**theme, "enabled": True, "origin": "local", "no-updates": True}
    temporary = None
    try:
        destination.mkdir(exist_ok=True)
        for name in FILES:
            shutil.copy2(source / name, destination / name)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=metadata.parent,
                prefix="mods.urlbar-priority.", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(mods, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.replace(metadata)
    except Exception:
        # Restore only this mod and the registry. Unrelated mods are untouched.
        shutil.copy2(backup / "mods.json", metadata)
        shutil.rmtree(destination)
        if (backup / "mod").exists():
            shutil.copytree(backup / "mod", destination)
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    result.update(applied=True, backup=str(backup))
    return result


if __name__ == "__main__":
    parser = ArgumentParser(description="本地安装 Sine 模组（先完全退出 Zen；默认只预览）。")
    parser.add_argument("profile", help="about:profiles 中的根目录，而非 Local Directory")
    parser.add_argument("--apply", action="store_true", help="备份后写入模组和注册项")
    args = parser.parse_args()
    print(json.dumps(install(args.profile, Path(__file__).resolve().parent, args.apply), ensure_ascii=False, indent=2))
