import collections

from PIL import Image

path = "docs/dev/spike-0002/evidence/render-xr-1794445051119.png"
im = Image.open(path).convert("RGB")
w, h = im.size
print("size", w, h)
cnt = collections.Counter(im.getdata())
print("top colors:", cnt.most_common(8))
for y in (60, 100, 150, 250, 350, 450):
    row = [im.getpixel((x, y)) for x in range(0, w, 12)]
    print(y, row[:12])
