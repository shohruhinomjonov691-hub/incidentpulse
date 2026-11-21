# Builds docs/demo.gif from the PNG frames written by record-demo.ts.
#   uv run --with pillow apps/web/scripts/frames-to-gif.py <frames-dir> <out.gif> [max-megabytes]
# Pacing is kept but long idle stretches are capped; frames are shrunk until the file fits.
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

CAPTIONS = {
    "investigating": "1 · Alert → agents investigate (timeline streams live)",
    "awaiting-approval": "2 · Root cause + runbook proposed → waiting for a human",
    "approving": "3 · Human clicks Approve (single-use token)",
    "recovering": "4 · certbot_renew runs, recovery is verified",
    "recovered": "5 · Incident recovered",
    "postmortem": "6 · Postmortem written by the CrewAI crew",
}

frames_dir, out = Path(sys.argv[1]), Path(sys.argv[2])
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 7.5
files = sorted(frames_dir.glob("*.png"))
assert files, "no frames"


def build(width: int, colors: int, step_ms: int = 450):
    font = ImageFont.load_default(size=max(12, width // 48))
    frames, durations, last = [], [], None
    for path in files:
        phase = path.stem.split("-", 1)[1]
        image = Image.open(path).convert("RGB")
        height = round(image.height * width / image.width)
        image = image.resize((width, height), Image.LANCZOS)
        draw = ImageDraw.Draw(image, "RGBA")
        text = CAPTIONS.get(phase, phase)
        box = draw.textbbox((0, 0), text, font=font)
        pad = 8
        draw.rectangle((0, 0, box[2] + 2 * pad, box[3] + 2 * pad), fill=(15, 23, 42, 220))
        draw.text((pad, pad), text, font=font, fill=(255, 255, 255, 255))
        if last is not None and ImageChops.difference(last, image).getbbox() is None:
            durations[-1] += step_ms  # identical frame: hold the previous one longer
            continue
        last = image
        frames.append(image)
        durations.append(step_ms)
    durations = [min(d, 1600) for d in durations]
    palette = [f.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
    palette[0].save(
        out, save_all=True, append_images=palette[1:], duration=durations, loop=0, optimize=True, disposal=1
    )
    return out.stat().st_size / 1e6, len(frames)


for width, colors in [(1100, 256), (960, 192), (880, 128), (800, 96), (720, 80), (640, 64), (560, 48)]:
    size, count = build(width, colors)
    print(f"{width}px {colors} colors: {count} frames, {size:.2f} MB")
    if size <= limit:
        break
else:
    raise SystemExit(f"could not get under {limit} MB")
