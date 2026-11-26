"""Regression for printer marks versus dark page artwork."""
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cropmarks import detect_crop_marks


class CropMarkTests(unittest.TestCase):
    def make_page(self, inset):
        image = Image.new('RGB', (800, 1000), 'white')
        draw = ImageDraw.Draw(image)
        left, right = inset, 800 - inset
        top, bottom = inset, 1000 - inset
        for x in (left, right):
            draw.line((x, 2, x, 43), fill='#888888')
            draw.line((x, 957, x, 998), fill='#888888')
        for y in (top, bottom):
            draw.line((2, y, 43, y), fill='#888888')
            draw.line((757, y, 798, y), fill='#888888')
        return image

    def test_outer_marks_are_cropped(self):
        self.assertEqual(detect_crop_marks(self.make_page(50)), (50, 50, 750, 950))

    def test_inner_artwork_is_not_a_trim_mark(self):
        self.assertIsNone(detect_crop_marks(self.make_page(110)))


if __name__ == '__main__':
    unittest.main()
