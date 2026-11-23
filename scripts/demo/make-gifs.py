"""The OffAIce — assemble les images de scripts/demo/record.mjs en GIF pour le README.

    python scripts/demo/make-gifs.py <dossier des images> <dossier de sortie> [largeur]
"""
import sys
from pathlib import Path

from PIL import Image

src = Path(sys.argv[1])
out = Path(sys.argv[2])
width = int(sys.argv[3]) if len(sys.argv) > 3 else 880
out.mkdir(parents=True, exist_ok=True)

for scene in ("office", "kanban", "break", "retro"):
    files = sorted((src / scene).glob("*.jpg"))
    if not files:
        continue
    frames = []
    for f in files:
        im = Image.open(f).convert("RGB")
        h = round(im.height * width / im.width)
        frames.append(im.resize((width, h), Image.LANCZOS))
    # One palette for the whole clip: no flicker between frames, smaller file.
    sample = Image.new("RGB", (width, h * 4))
    for i, k in enumerate(range(0, len(frames), max(1, len(frames) // 4))):
        if i < 4:
            sample.paste(frames[k], (0, i * h))
    palette = sample.quantize(colors=200, method=Image.Quantize.MEDIANCUT)
    gif = [fr.quantize(palette=palette, dither=Image.Dither.NONE) for fr in frames]
    durations = [110] * len(gif)
    durations[-1] = 1800  # pause on the last frame before looping
    target = out / f"{scene}.gif"
    gif[0].save(target, save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{target.name}: {len(gif)} images, {target.stat().st_size / 1e6:.1f} Mo")
