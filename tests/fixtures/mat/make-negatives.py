#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MAT 派生负例生成脚本（QA-0001-05）。

用途：从本地已获取的 Pexels 素材（MAT-01..04）派生 4 张负例，供 L3 用例与人工复核使用：
  - mat-05-face-only.jpg   MAT-01 裁头部特写（非全身）
  - mat-06-lowres.jpg      MAT-02 缩到长边 400px（低于端上 L0 下限 1024）
  - mat-07-blur.jpg        MAT-03 高斯模糊（半径 8，视觉预检阶段应判不合格）
  - mat-09-two-persons.jpg MAT-01 与 MAT-02 并排拼合（多人物照；原计划编号 MAT-08，
                           因 MAT-08 改为衣服平铺素材而顺延为 MAT-09）

边界：
  * 派生自本地素材，**图片二进制不入库**（`.gitignore`: tests/fixtures/mat/*.jpg）；
  * 仅用于测试，不得作为素材再分发（见 MATERIALS-MANIFEST.json 与 docs/qa/MATERIALS-0001.md）；
  * 依赖 Pillow（工作区 Python 已自带），不引入其它第三方依赖。

复现：
  python tests/fixtures/mat/make-negatives.py
  # 输出应为：
  #   mat-05-face-only.jpg   1040x1200  186957B
  #   mat-06-lowres.jpg       267x400    23213B
  #   mat-07-blur.jpg        1600x2400  246127B
  #   mat-09-two-persons.jpg 1554x1200  315717B
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "MATERIALS-MANIFEST.json")


def load(path: str) -> Image.Image:
    if not os.path.isfile(path):
        raise SystemExit(f"缺少源素材: {path}（请先按 MANIFEST 获取图片）")
    return Image.open(path).convert("RGB")


def save(image: Image.Image, name: str) -> str:
    out = os.path.join(HERE, name)
    image.save(out, "JPEG", quality=90, optimize=True)
    return out


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def main() -> int:
    src = {item["matId"]: os.path.join(HERE, os.path.basename(item["file"]))
           for item in json.load(open(MANIFEST, encoding="utf-8"))["items"]}

    m1 = load(src["MAT-01"])
    m2 = load(src["MAT-02"])
    m3 = load(src["MAT-03"])

    # MAT-05：裁头部特写（保留上半身顶部区域，长边仍 >=1024，避免被 L0 以尺寸原因拦截）
    w1, _h1 = m1.size
    crop = m1.crop((max(0, w1 // 2 - 520), 0, min(w1, w1 // 2 + 520), 1200))
    face = crop.resize((1040, 1200), Image.LANCZOS)
    p05 = save(face, "mat-05-face-only.jpg")

    # MAT-06：长边缩到 400px，低于端上 L0 下限（MIN_LONG_SIDE=1024）
    w2, h2 = m2.size
    scale = 400.0 / max(w2, h2)
    low = m2.resize((max(1, round(w2 * scale)), max(1, round(h2 * scale))), Image.LANCZOS)
    p06 = save(low, "mat-06-lowres.jpg")

    # MAT-07：高斯模糊半径 8，模拟失焦/剧烈抖动
    p07 = save(m3.filter(ImageFilter.GaussianBlur(radius=8)), "mat-07-blur.jpg")

    # MAT-09：两图并排拼合（统一高度 1200），用于多人物负例（编号顺延说明见脚本头注释）
    target_h = 1200
    def fit(im: Image.Image) -> Image.Image:
        w, h = im.size
        return im.resize((max(1, round(w * target_h / h)), target_h), Image.LANCZOS)
    left, right = fit(m1), fit(m2)
    canvas = Image.new("RGB", (left.width + right.width, target_h), (255, 255, 255))
    canvas.paste(left, (0, 0))
    canvas.paste(right, (left.width, 0))
    p09 = save(canvas, "mat-09-two-persons.jpg")

    for path in (p05, p06, p07, p09):
        with Image.open(path) as im:
            w, h = im.size
        print(f"{os.path.basename(path)} {w}x{h} {os.path.getsize(path)}B sha256={sha256(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
