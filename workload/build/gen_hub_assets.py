"""Generate the Workload Hub assets Fabric expects, at the sizes it expects.

Fabric validates the banner at exactly 1920x240 (publishing requirements 3.1.5).
Every other field is unvalidated but rendered into a fixed slot, so an image of
the wrong shape is stretched rather than fitted: pointing all of them at the
square logo is what produced the distorted arc behind the title.

Run from the repository root:

    python workload/build/gen_hub_assets.py

Sources are the checked-in logo and the screenshots under docs/assets, so the
output is reproducible and no network call is involved.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / "workload" / "manifest" / "assets"
DOCS = REPO / "docs" / "assets"

# The asmdb.cloud palette, so the Hub page and the product site agree.
PAPER_DARK = (5, 7, 12)
PAPER_MID = (10, 13, 20)
CYAN = (34, 211, 238)
VIOLET = (168, 85, 247)
MAGENTA = (217, 70, 239)

BANNER = (1920, 240)
GET_STARTED = (320, 180)
GLANCE_WIDTH = 1920  # 16:9; the toolkit ships 985x552, this is the same shape


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def horizontal_gradient(size: tuple[int, int], left: tuple[int, int, int], right: tuple[int, int, int]) -> Image.Image:
    width, height = size
    base = Image.new("RGB", (width, 1))
    pixels = base.load()
    for x in range(width):
        pixels[x, 0] = lerp(left, right, x / max(1, width - 1))
    return base.resize(size, Image.BILINEAR)


def screen_add(base: Image.Image, layer: Image.Image) -> Image.Image:
    """Screen blend: brightens without clipping the darks to grey."""
    import PIL.ImageChops as chops

    return chops.screen(base, layer)


def build_banner() -> Image.Image:
    """1920x240. The portal overlays the workload title on the left and clips an
    arc over the top, so the left third stays quiet enough for white text to
    read, the interest sits centre-right, and nothing legible goes in the file."""
    width, height = BANNER
    canvas = horizontal_gradient(BANNER, PAPER_DARK, (8, 10, 18))

    # Circuit traces, flowing rightward and confined to the right half. Keeping
    # them off the left is not decoration: that is where the title is drawn.
    traces = Image.new("RGB", BANNER, (0, 0, 0))
    draw = ImageDraw.Draw(traces)
    for i in range(30):
        t = i / 29
        y = round(18 + t * (height - 36))
        x0 = round(880 + math.sin(i * 2.1) * 120)
        seg = round(120 + (i % 6) * 110)
        colour = lerp(CYAN, VIOLET, (math.sin(i * 0.7) + 1) / 2)
        # Traces brighten as they travel right, so the eye is led out of the title.
        strength = 0.14 + 0.34 * min(1.0, (x0 - 700) / 900)
        dim = tuple(round(c * strength) for c in colour)
        draw.line([(x0, y), (x0 + seg, y)], fill=dim, width=1)
        if i % 3 == 0:
            draw.line([(x0 + seg, y), (x0 + seg + 30, y - 30)], fill=dim, width=1)
            draw.line([(x0 + seg + 30, y - 30), (min(width, x0 + seg + 190), y - 30)], fill=dim, width=1)
        node = tuple(round(c * min(1.0, strength * 2.1)) for c in colour)
        draw.ellipse([x0 + seg - 3, y - 3, x0 + seg + 3, y + 3], fill=node)

    canvas = screen_add(canvas, traces)

    # Tight blooms rather than a wash. A large soft radius reads as a flat colour
    # band at this aspect ratio; small ones read as light.
    glow = Image.new("RGB", BANNER, (0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for cx, cy, r, colour, strength in (
        (1210, 128, 66, CYAN, 0.52),
        (1470, 96, 54, VIOLET, 0.46),
        (1690, 150, 44, MAGENTA, 0.34),
    ):
        tint = tuple(round(c * strength) for c in colour)
        gdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tint)
    canvas = screen_add(canvas, glow.filter(ImageFilter.GaussianBlur(58)))

    # A hairline at the foot, brightening to the right, ties the band together.
    line = Image.new("RGB", BANNER, (0, 0, 0))
    ldraw = ImageDraw.Draw(line)
    for x in range(0, width, 4):
        f = (x / width) ** 1.6
        ldraw.line([(x, height - 2), (x + 4, height - 2)], fill=tuple(round(c * 0.42 * f) for c in CYAN), width=2)
    canvas = screen_add(canvas, line.filter(ImageFilter.GaussianBlur(1.6)))

    return canvas


def build_get_started() -> Image.Image:
    """320x180. The logo is *contained* with padding, never stretched to fill."""
    canvas = horizontal_gradient(GET_STARTED, PAPER_DARK, PAPER_MID)

    glow = Image.new("RGB", GET_STARTED, (0, 0, 0))
    ImageDraw.Draw(glow).ellipse([70, 20, 250, 200], fill=tuple(round(c * 0.22) for c in VIOLET))
    canvas = screen_add(canvas, glow.filter(ImageFilter.GaussianBlur(40)))

    logo = Image.open(ASSETS / "logo.png").convert("RGBA")
    # Fit inside ~62% of the card height so the mark breathes inside the slot.
    target = round(GET_STARTED[1] * 0.62)
    logo.thumbnail((target, target), Image.LANCZOS)
    out = canvas.convert("RGBA")
    out.alpha_composite(logo, ((GET_STARTED[0] - logo.width) // 2, (GET_STARTED[1] - logo.height) // 2))
    return out.convert("RGB")


def to_sixteen_nine(path: Path, width: int = GLANCE_WIDTH) -> Image.Image:
    """Pad a screenshot to 16:9 rather than crop it.

    The captures are about 1.65:1, so reaching 16:9 means adding width. Cropping
    would remove interface the slide exists to show; padding with the capture's
    own edge colour is invisible and keeps both themes correct.
    """
    src = Image.open(path).convert("RGB")
    edge = src.getpixel((2, src.height // 2))
    target_h = round(width * 9 / 16)

    scale = min(width / src.width, target_h / src.height)
    resized = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)

    canvas = Image.new("RGB", (width, target_h), edge)
    canvas.paste(resized, ((width - resized.width) // 2, (target_h - resized.height) // 2))
    return canvas


def save(img: Image.Image, name: str, limit: int = 1_572_864) -> None:
    out = ASSETS / name
    img.save(out, "PNG", optimize=True)
    size = out.stat().st_size
    if size > limit:
        # Fabric rejects assets over 1.5 MB at upload, not at packaging, so shrink
        # here rather than discover it after everything else is done.
        for width in (1600, 1440, 1280):
            scaled = img.resize((width, round(width * img.height / img.width)), Image.LANCZOS)
            scaled.save(out, "PNG", optimize=True)
            size = out.stat().st_size
            if size <= limit:
                break
    status = "ok" if size <= limit else "TOO LARGE"
    print(f"{status:9} {name:34} {img.size[0]}x{img.size[1]} -> {size:,} bytes")
    if size > limit:
        sys.exit(1)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    save(build_banner(), "hub-banner.png")
    save(build_get_started(), "hub-get-started.png")

    slides = [
        ("asmdb-workload.png", "hub-glance-1.png"),
        ("asmdb-workload-notebooks.png", "hub-glance-2.png"),
        ("asmdb-workload-monitoring-dark.png", "hub-glance-3.png"),
        ("asmdb-workload-monitoring.png", "hub-glance-4.png"),
    ]
    for source, name in slides:
        src = DOCS / source
        if not src.exists():
            print(f"missing   {src}")
            sys.exit(1)
        save(to_sixteen_nine(src), name)


if __name__ == "__main__":
    main()
