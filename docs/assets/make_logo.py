#!/usr/bin/env python3
"""Reproducible generator for the asmdb hero banner and logo mark.

    python docs/assets/make_logo.py

Produces (rendered at 2x then downsampled for crisp anti-aliasing):
    docs/assets/asmdb-hero.png   1280 x 400   README hero
    docs/assets/asmdb-logo.png    512 x 512    square app mark
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = r"C:\Windows\Fonts"
S = 2  # supersample factor

# ---- palette -----------------------------------------------------------------
BG_TOP      = (9, 12, 22)
BG_BOT      = (17, 23, 43)
GLOW_BLUE   = (37, 99, 235)
GLOW_INDIGO = (106, 61, 214)
GLOW_CYAN   = (34, 170, 240)
WHITE       = (233, 239, 245)
SUB         = (150, 162, 178)
DIM         = (96, 112, 138)
ACC_A       = (86, 170, 255)   # cyan-blue  (top of gradients)
ACC_B       = (124, 92, 232)   # indigo     (bottom of gradients)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), int(size * S))


def px(v):
    return int(v * S)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(w, h, top, bot):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(top, bot, y / max(1, h - 1)))
    return img


def glow(size, center, radius, color, alpha):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius],
              fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.55))


def hex_texture(size, box, fnt, alpha=14):
    """Faint monospace hex-dump texture inside `box` (x0,y0,x1,y1)."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, y0, x1, y1 = box
    rng = 0x9E3779B97F4A7C15
    v = 0x4D5A9000
    line_h = int(fnt.size * 1.55)
    y = y0
    while y < y1:
        parts = []
        for _ in range((x1 - x0) // px(26)):
            v = (v * 2654435761 + 12345) & 0xFFFFFFFF
            parts.append(f"{(v >> 8) & 0xFF:02X}")
        d.text((x0, y), " ".join(parts), font=fnt, fill=(120, 150, 200, alpha))
        y += line_h
    return layer


def rounded_mask(size, box, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def db_glyph(draw, cx, cy, w, h, color, ring=None):
    """A clean stacked-disk database cylinder centered at (cx, cy)."""
    rx = w / 2
    ry = w / 6.2
    top = cy - h / 2
    bot = cy + h / 2
    # body
    draw.rectangle([cx - rx, top, cx + rx, bot], fill=color)
    draw.ellipse([cx - rx, bot - ry, cx + rx, bot + ry], fill=color)
    # disk seams
    seam = ring or (255, 255, 255)
    for frac in (0.0, 0.5):
        yy = top + h * frac
        draw.ellipse([cx - rx, yy - ry, cx + rx, yy + ry], fill=color,
                     outline=seam, width=px(3))
    # top cap
    draw.ellipse([cx - rx, top - ry, cx + rx, top + ry], fill=color,
                 outline=seam, width=px(3))


def tile(side, radius):
    """The square gradient app-tile with the DB glyph + a >_ accent."""
    canvas = px(side)
    g = vgrad(canvas, canvas, ACC_A, ACC_B)
    # diagonal sheen
    sheen = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).polygon(
        [(0, 0), (canvas * 0.6, 0), (0, canvas * 0.6)], fill=(255, 255, 255, 26))
    g = Image.alpha_composite(g.convert("RGBA"), sheen)
    mask = rounded_mask((canvas, canvas), [0, 0, canvas - 1, canvas - 1], px(radius))
    tile_img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    tile_img.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(tile_img)
    db_glyph(d, canvas * 0.5, canvas * 0.43, canvas * 0.46, canvas * 0.46,
             (255, 255, 255), ring=(228, 238, 255))
    # prompt accent
    pf = font("consolab.ttf", side * 0.16)
    txt = ">_"
    tw = d.textlength(txt, font=pf)
    d.text((canvas * 0.5 - tw / 2, canvas * 0.7), txt, font=pf,
           fill=(255, 255, 255))
    return tile_img, mask


def make_hero():
    W, H = px(1280), px(400)
    img = vgrad(W, H, BG_TOP, BG_BOT).convert("RGBA")
    # ambient glows
    img.alpha_composite(glow((W, H), (px(560), px(150)), px(300), GLOW_BLUE, 90))
    img.alpha_composite(glow((W, H), (px(200), px(210)), px(240), GLOW_CYAN, 70))
    img.alpha_composite(glow((W, H), (px(980), px(300)), px(320), GLOW_INDIGO, 70))
    # hex texture band
    img.alpha_composite(hex_texture((W, H), (px(360), px(40), px(1240), px(360)),
                                    font("consola.ttf", 15), alpha=12))

    # logo tile
    side, radius = 210, 46
    tile_img, _ = tile(side, radius)
    # soft shadow under the tile
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [px(84), px(99), px(84 + side), px(99 + side)], radius=px(radius),
        fill=(0, 0, 0, 150))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(px(18))))
    img.alpha_composite(tile_img, (px(84), px(95)))

    d = ImageDraw.Draw(img)
    # wordmark: "asm" white + "db" cyan
    wf = font("consolab.ttf", 132)
    x = px(350)
    y = px(120)
    d.text((x, y), "asm", font=wf, fill=WHITE)
    x += d.textlength("asm", font=wf)
    d.text((x, y), "db", font=wf, fill=ACC_A)

    # tagline
    tf = font("segoeuib.ttf", 33)
    d.text((px(356), px(278)), "a transactional database in x86-64 assembly",
           font=tf, fill=SUB)

    # tag chips (drawn on their own layer for correct translucency)
    cf = font("consola.ttf", 21)
    chips = ["nasm -f bin", "no linker", "no CRT", "WAL", "~10 KB"]
    chip_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(chip_layer)
    cx = px(356)
    cy = px(330)
    for c in chips:
        tw = cd.textlength(c, font=cf)
        pad = px(15)
        cd.rounded_rectangle([cx, cy, cx + tw + pad * 2, cy + px(36)],
                             radius=px(18), fill=(120, 150, 200, 34),
                             outline=(150, 180, 220, 90), width=max(1, px(1)))
        cd.text((cx + pad, cy + px(7)), c, font=cf, fill=(196, 212, 232, 255))
        cx += tw + pad * 2 + px(12)
    img.alpha_composite(chip_layer)

    # bottom accent bar
    bar = vgrad(W, px(6), ACC_A, ACC_A)
    for xx in range(W):
        t = xx / W
        col = lerp(GLOW_CYAN, GLOW_INDIGO, t)
        ImageDraw.Draw(bar).line([(xx, 0), (xx, px(6))], fill=col)
    img.alpha_composite(bar.convert("RGBA"), (0, H - px(6)))

    out = img.convert("RGB").resize((1280, 400), Image.LANCZOS)
    out.save(os.path.join(HERE, "asmdb-hero.png"))
    print("wrote asmdb-hero.png")


def make_logo():
    side = 512
    canvas = px(side)
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    tile_img, _ = tile(side, 108)
    # outer glow
    g = glow((canvas, canvas), (canvas // 2, canvas // 2), px(220), GLOW_BLUE, 80)
    img.alpha_composite(g)
    img.alpha_composite(tile_img, (0, 0))
    out = img.resize((side, side), Image.LANCZOS)
    out.save(os.path.join(HERE, "asmdb-logo.png"))
    print("wrote asmdb-logo.png")


if __name__ == "__main__":
    make_hero()
    make_logo()
