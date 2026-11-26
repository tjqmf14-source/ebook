"""Conservative four-corner trim-mark detection on a rendered page."""
from __future__ import annotations
from PIL import Image


def detect_crop_marks(image: Image.Image):
    """Return (left, top, right, bottom) pixels only for four consistent corners."""
    gray = image.convert('L')
    width, height = gray.size
    if width < 300 or height < 300:
        return None
    # Work at a bounded preview resolution; scale the verified coordinates back.
    factor = min(1, 1200 / max(width, height))
    if factor < 1:
        gray = gray.resize((round(width * factor), round(height * factor)))
    w, h = gray.size
    pixels = gray.load()

    def strongest(positions, samples):
        scores = [(sum(pixels[x, y] < 220 for x, y in samples(p)), p) for p in positions]
        count, position = max(scores, default=(0, None))
        if position is None or count < len(samples(position)) * .55:
            return None
        return position

    vertical = []
    for top in (True, False):
        ys = range(2, max(3, round(h * .045))) if top else range(round(h * .955), h - 2)
        for left in (True, False):
            xs = range(round(w * .025), round(w * .15)) if left else range(round(w * .85), round(w * .975))
            vertical.append(strongest(xs, lambda x: [(x, y) for y in ys]))
    horizontal = []
    for top in (True, False):
        ys = range(round(h * .025), round(h * .15)) if top else range(round(h * .85), round(h * .975))
        for left in (True, False):
            xs = range(2, max(3, round(w * .055))) if left else range(round(w * .945), w - 2)
            horizontal.append(strongest(ys, lambda y: [(x, y) for x in xs]))
    if any(v is None for v in vertical + horizontal):
        return None
    left_top, right_top, left_bottom, right_bottom = vertical
    top_left, top_right, bottom_left, bottom_right = horizontal
    if abs(left_top - left_bottom) > w * .012 or abs(right_top - right_bottom) > w * .012:
        return None
    if abs(top_left - top_right) > h * .012 or abs(bottom_left - bottom_right) > h * .012:
        return None
    left = round((left_top + left_bottom) / 2 / factor)
    right = round((right_top + right_bottom) / 2 / factor)
    top = round((top_left + top_right) / 2 / factor)
    bottom = round((bottom_left + bottom_right) / 2 / factor)
    # Printer trim marks sit in the outer bleed, not deep inside page artwork.
    # Dark illustrations can otherwise form four consistent false corners.
    if (left > width * .10 or top > height * .10 or
        width - right > width * .10 or height - bottom > height * .10):
        return None
    if right - left < width * .65 or bottom - top < height * .65:
        return None
    return left, top, right, bottom
