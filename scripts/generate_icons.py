#!/usr/bin/env python3
"""Generate simple PNG icons for the extension: a blue rounded square with
three stacked white bars evoking a tab group."""

from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
BG = (47, 111, 237, 255)  # accent blue
FG = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size: int) -> Image.Image:
    scale = 4  # supersample for crisp edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = s * 0.04
    radius = s * 0.22
    rounded_rect(draw, (pad, pad, s - pad, s - pad), radius, BG)

    # three stacked bars: a group header chip + two tab bars
    x0 = s * 0.22
    x1 = s * 0.78
    bar_r = s * 0.055

    # group chip (shorter, on top)
    chip_y0 = s * 0.24
    chip_y1 = s * 0.36
    rounded_rect(draw, (x0, chip_y0, x0 + (x1 - x0) * 0.55, chip_y1), bar_r, FG)

    # tab bar 1
    t1_y0 = s * 0.45
    t1_y1 = s * 0.57
    rounded_rect(draw, (x0, t1_y0, x1, t1_y1), bar_r, FG)

    # tab bar 2
    t2_y0 = s * 0.64
    t2_y1 = s * 0.76
    rounded_rect(draw, (x0, t2_y0, x1 * 0.92, t2_y1), bar_r, FG)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for size in SIZES:
        icon = make_icon(size)
        out = f"static/icons/icon{size}.png"
        icon.save(out)
        print(f"wrote {out}")
