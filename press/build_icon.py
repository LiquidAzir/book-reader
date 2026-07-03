"""
Book Reader icon generator.

Renders an open book (aerial perspective) with page lines and a cyan bookmark
ribbon on a subtly dark rounded plate. Uses 4x supersampling for crisp edges
at any output size.

Outputs:
    ../glasses-app/favicon.png   128x128  (what the glasses launcher reads)
    icon-512.png                 512x512  (for the catalog submission)
    icon-256.png                 256x256  (extra size, in case the store wants it)
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

SUPER = 4                    # supersample factor for AA
BASE = 512                   # design canvas
W = BASE * SUPER             # 2048 working canvas

HERE = Path(__file__).parent
GLASSES = HERE.parent / "glasses-app"

# ---- Palette ----
PLATE_TOP    = (18, 22, 36, 255)          # top of plate gradient
PLATE_BOT    = (8, 10, 18, 255)           # bottom of plate gradient
PLATE_BORDER = (0, 212, 255, 60)          # subtle cyan glow on plate edge
BOOK_SHADOW  = (0, 0, 0, 130)             # cast shadow under book
PAGE         = (246, 236, 216, 255)       # warm cream page
PAGE_EDGE    = (208, 192, 165, 255)       # darker cream for outer edge shading
SPINE_DARK   = (52, 42, 32, 255)          # book spine crease
TEXT_LINE    = (140, 128, 108, 235)       # muted brown for text lines
TEXT_ACCENT  = (0, 92, 130, 245)          # first line accent (small chapter head hint)
BOOKMARK     = (0, 212, 255, 255)         # brand cyan
BOOKMARK_HI  = (110, 232, 255, 255)       # ribbon highlight edge


def s(v):
    """Scale a design-space coordinate into working-canvas pixels."""
    return int(round(v * SUPER))


def draw_plate(img):
    """Rounded square plate with a soft vertical gradient and a thin cyan glow."""
    # Vertical gradient plate.
    plate = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, W), (0, 0, 0, 0))
    for y in range(W):
        t = y / (W - 1)
        r = int(PLATE_TOP[0] + (PLATE_BOT[0] - PLATE_TOP[0]) * t)
        g = int(PLATE_TOP[1] + (PLATE_BOT[1] - PLATE_TOP[1]) * t)
        b = int(PLATE_TOP[2] + (PLATE_BOT[2] - PLATE_TOP[2]) * t)
        grad.putpixel((0, y), (r, g, b, 255))
    grad = grad.resize((W, W), Image.NEAREST)

    # Mask: rounded square, inset from the canvas edge.
    inset = s(28)
    radius = s(88)
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, W - inset, W - inset], radius=radius, fill=255
    )
    img.paste(grad, (0, 0), mask)

    # Thin cyan glow along the plate border.
    d = ImageDraw.Draw(img)
    for i, alpha in enumerate([70, 40, 20]):
        d.rounded_rectangle(
            [inset - i, inset - i, W - inset + i, W - inset + i],
            radius=radius + i,
            outline=(0, 212, 255, alpha),
            width=s(1),
        )


def draw_shadow(img):
    """Soft blurred shadow under the book to lift it off the plate."""
    shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    # Big soft ellipse under the book.
    sd.ellipse([s(60), s(340), s(452), s(430)], fill=BOOK_SHADOW)
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=s(9)))
    img.alpha_composite(shadow)


def draw_pages(img):
    """Open book: two page trapezoids with light perspective; edge shading; spine."""
    d = ImageDraw.Draw(img)

    # --- Edge shading (drawn first, slightly larger than pages) ---
    left_edge = [
        (s(65),  s(150)),
        (s(255), s(148)),
        (s(255), s(432)),
        (s(35),  s(438)),
    ]
    right_edge = [
        (s(257), s(148)),
        (s(447), s(150)),
        (s(477), s(438)),
        (s(257), s(432)),
    ]
    d.polygon(left_edge, fill=PAGE_EDGE)
    d.polygon(right_edge, fill=PAGE_EDGE)

    # --- Page surfaces (slightly inset from the edge shading) ---
    left_page = [
        (s(70),  s(157)),
        (s(255), s(155)),
        (s(255), s(425)),
        (s(45),  s(430)),
    ]
    right_page = [
        (s(257), s(155)),
        (s(442), s(157)),
        (s(467), s(430)),
        (s(257), s(425)),
    ]
    d.polygon(left_page, fill=PAGE)
    d.polygon(right_page, fill=PAGE)

    # --- Spine crease line down the middle ---
    d.line(
        [(s(256), s(155)), (s(256), s(428))],
        fill=SPINE_DARK,
        width=s(3),
    )

    # --- Text lines on each page ---
    #    top line is a shorter cyan-tinted "chapter head" to add visual accent
    line_specs_left = [
        (185, 80, 156, TEXT_ACCENT, 8),   # short chapter-head accent
        (205, 80, 168, TEXT_LINE,   5),
        (220, 80, 168, TEXT_LINE,   5),
        (235, 80, 168, TEXT_LINE,   5),
        (250, 80, 145, TEXT_LINE,   5),   # slightly shorter paragraph end
        (275, 80, 168, TEXT_LINE,   5),
        (290, 80, 168, TEXT_LINE,   5),
        (305, 80, 155, TEXT_LINE,   5),
        (330, 80, 168, TEXT_LINE,   5),
        (345, 80, 130, TEXT_LINE,   5),
        (370, 80, 168, TEXT_LINE,   5),
        (385, 80, 100, TEXT_LINE,   5),   # last (short) paragraph end
    ]
    for y, x0, w, color, h in line_specs_left:
        d.rounded_rectangle(
            [s(x0), s(y), s(x0 + w), s(y + h)],
            radius=s(2),
            fill=color,
        )

    # Right page (mirror x-alignment; slightly offset to fit trapezoid shape).
    line_specs_right = [
        (185, 275, 156, TEXT_ACCENT, 8),
        (205, 275, 168, TEXT_LINE,   5),
        (220, 275, 168, TEXT_LINE,   5),
        (235, 275, 168, TEXT_LINE,   5),
        (250, 275, 150, TEXT_LINE,   5),
        (275, 275, 168, TEXT_LINE,   5),
        (290, 275, 168, TEXT_LINE,   5),
        (305, 275, 140, TEXT_LINE,   5),
        (330, 275, 168, TEXT_LINE,   5),
        (345, 275, 168, TEXT_LINE,   5),
        (370, 275, 168, TEXT_LINE,   5),
        (385, 275, 110, TEXT_LINE,   5),
    ]
    for y, x0, w, color, h in line_specs_right:
        d.rounded_rectangle(
            [s(x0), s(y), s(x0 + w), s(y + h)],
            radius=s(2),
            fill=color,
        )


def draw_bookmark(img):
    """Cyan ribbon draped down the right page, extending below the book."""
    d = ImageDraw.Draw(img)
    x = 388            # ribbon left edge
    w = 30             # ribbon width
    top = 138          # slightly above the pages
    bot = 466          # below the book edge for the drape effect

    # Ribbon body with a V-notch at the bottom.
    ribbon = [
        (s(x),        s(top)),
        (s(x + w),    s(top)),
        (s(x + w),    s(bot - 4)),
        (s(x + w/2),  s(bot - 22)),   # notch center point
        (s(x),        s(bot - 4)),
    ]
    d.polygon(ribbon, fill=BOOKMARK)

    # Subtle highlight strip along the left edge for depth.
    hi = [
        (s(x),     s(top)),
        (s(x + 6), s(top)),
        (s(x + 6), s(bot - 10)),
        (s(x),     s(bot - 4)),
    ]
    d.polygon(hi, fill=BOOKMARK_HI)


def build():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw_plate(img)
    draw_shadow(img)
    draw_pages(img)
    draw_bookmark(img)

    # Downsample once with LANCZOS for the crispest possible edges.
    icon_512 = img.resize((512, 512), Image.LANCZOS)
    icon_256 = img.resize((256, 256), Image.LANCZOS)
    icon_128 = img.resize((128, 128), Image.LANCZOS)

    out_128 = GLASSES / "favicon.png"
    out_256 = HERE / "icon-256.png"
    out_512 = HERE / "icon-512.png"

    icon_128.save(out_128, optimize=True)
    icon_256.save(out_256, optimize=True)
    icon_512.save(out_512, optimize=True)

    for p in (out_128, out_256, out_512):
        print(f"wrote {p}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    build()
