#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPIKE-0002 AC-25 指标计算脚本（骨架 + 可运行部分）

用途：计算「3D 生成前输入人像照片」与「3D 供应商渲染预览图」之间的三项指标：
  1) 五官关键点归一化位移（normalized landmark displacement）
  2) 肤色差 ΔE（CIELAB，CIE76）
  3) 发型轮廓 IoU（hair silhouette IoU）

本脚本仅依赖 Pillow + numpy（运行环境已验证可用）。环境没有 OpenCV/mediapipe，
因此「五官关键点」一项无法做人脸关键点检测，当前用「人脸区域代理框（肤色区域）」的
归一化中心/尺寸位移作为代理指标，并在输出里明确标注 proxy=true 与局限；
正式 QA 建议接入 mediapipe / dlib 的 68 点或 468 点模型后替换 compute_landmark_proxy()。

用法：
  python ac25-metrics.py --input tests/fixtures/mat/mat-01-woman-fullbody.jpg \
      --rendered docs/dev/spike-0002/evidence/rendered-9906ae33-4412-49f4-811a-cc6af2f911db.webp \
      --out docs/dev/spike-0002/evidence/ac25-metrics.json
"""

import argparse
import json
import sys

import numpy as np
from PIL import Image


# 建议阈值（单样本基线，供 SE 用多样本标定后回填 SPEC；当前仅为建议值，不是验收结论）
THRESHOLDS = {
    "landmark_max_norm_displacement": 0.08,   # 归一化到人脸框宽度，P95 上限
    "landmark_mean_norm_displacement": 0.04,  # 归一化后均值
    "skin_delta_e_mean": 8.0,                 # CIE76 ΔE；≈8 为可感知但不突兀，需 SE 用样本标定
    "skin_delta_e_max": 12.0,
    "hair_iou_min": 0.55                      # 输入照片与 3D 预览构图不同，IoU 天然偏低
}


def load_rgb(path, max_side=1024):
    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = min(1.0, max_side / float(max(w, h)))
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    return img


def to_array(img):
    return np.asarray(img).astype(np.float32)


def ycbcr_mask(rgb):
    """返回肤色掩码（YCbCr 经验阈值）。"""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b
    mask = (cb >= 77) & (cb <= 127) & (cr >= 133) & (cr <= 173) & (y > 60)
    return mask


def rgb_to_lab(rgb):
    """sRGB(0-255) -> CIELAB（D65），返回与输入同形状数组。"""
    c = rgb / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ],
        dtype=np.float32,
    )
    xyz = c @ m.T
    white = np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    xyz = xyz / white
    delta = 6.0 / 29.0
    f = np.where(xyz > delta ** 3, np.cbrt(xyz), xyz / (3 * delta ** 2) + 4.0 / 29.0)
    lab = np.empty_like(xyz)
    lab[..., 0] = 116.0 * f[..., 1] - 16.0
    lab[..., 1] = 500.0 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200.0 * (f[..., 1] - f[..., 2])
    return lab


def skin_delta_e(input_img, rendered_img):
    in_arr = to_array(input_img)
    out_arr = to_array(rendered_img)
    in_mask = ycbcr_mask(in_arr)
    out_mask = ycbcr_mask(out_arr)
    if in_mask.sum() < 200 or out_mask.sum() < 200:
        return {
            "ok": False,
            "reason": "skin_pixels_insufficient",
            "input_skin_pixels": int(in_mask.sum()),
            "rendered_skin_pixels": int(out_mask.sum()),
        }
    in_mean = to_array(input_img)[in_mask].mean(axis=0)
    out_mean = to_array(rendered_img)[out_mask].mean(axis=0)
    in_lab = rgb_to_lab(in_mean.reshape(1, 1, 3))[0, 0]
    out_lab = rgb_to_lab(out_mean.reshape(1, 1, 3))[0, 0]
    delta = float(np.linalg.norm(in_lab - out_lab))
    return {
        "ok": True,
        "delta_e_mean": round(delta, 3),
        "input_skin_rgb": [round(float(v), 1) for v in in_mean],
        "rendered_skin_rgb": [round(float(v), 1) for v in out_mean],
        "input_skin_pixels": int(in_mask.sum()),
        "rendered_skin_pixels": int(out_mask.sum()),
    }


def head_region(rgb):
    h, w = rgb.shape[:2]
    return rgb[: int(h * 0.45), : int(w * 0.7)]


def hair_mask(rgb):
    """近似发型掩码：头部区域内低亮度像素（深色头发）。"""
    head = head_region(rgb)
    y = 0.299 * head[..., 0] + 0.587 * head[..., 1] + 0.114 * head[..., 2]
    mask = y < 120
    return mask


def hair_iou(input_img, rendered_img):
    in_mask = hair_mask(to_array(input_img))
    out_mask = hair_mask(to_array(rendered_img))
    h = min(in_mask.shape[0], out_mask.shape[0])
    w = min(in_mask.shape[1], out_mask.shape[1])
    in_mask = in_mask[:h, :w]
    out_mask = out_mask[:h, :w]
    inter = np.logical_and(in_mask, out_mask).sum()
    union = np.logical_or(in_mask, out_mask).sum()
    iou = float(inter) / float(union) if union else 0.0
    return {
        "ok": True,
        "hair_iou": round(iou, 4),
        "input_hair_pixels": int(in_mask.sum()),
        "rendered_hair_pixels": int(out_mask.sum()),
    }


def face_proxy_box(rgb):
    mask = ycbcr_mask(rgb)
    ys, xs = np.where(mask)
    if xs.size < 200:
        return None
    x0, x1 = int(np.percentile(xs, 5)), int(np.percentile(xs, 95))
    y0, y1 = int(np.percentile(ys, 5)), int(np.percentile(ys, 95))
    if x1 <= x0 or y1 <= y0:
        return None
    return {
        "x": float(x0),
        "y": float(y0),
        "w": float(x1 - x0),
        "h": float(y1 - y0),
        "cx": float((x0 + x1) / 2.0),
        "cy": float((y0 + y1) / 2.0),
    }


def landmark_proxy(input_img, rendered_img):
    """占位实现：真实 AC-25 要求「五官关键点归一化位移」，需 68/468 点人脸关键点模型。
    本环境无 OpenCV/mediapipe，因此本项标记为未计算（ok:false）；接入关键点模型后
    再实现：关键点 → 以两眼距离/人脸框宽度归一化 → 计算输入照片与 3D 预览的逐点位移
    的均值与 P95。当前不输出数值，避免用代理框得出误导性结论。
    """
    return {
        "ok": False,
        "reason": "keypoint_model_unavailable",
        "proxy": False,
        "needed": "mediapipe / dlib 68 点或 468 点人脸关键点模型（当前运行环境未提供）",
        "method_planned": [
            "检测输入照片与 3D 渲染预览中的人脸关键点",
            "以两眼中心距离（或人脸框宽度）归一化关键点坐标",
            "计算同序关键点位移向量，报告均值与 P95（归一化单位）",
            "建议阈值：均值 ≤0.04、P95 ≤0.08（以 5 组以上样本标定后回填 SPEC）"
        ]
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--rendered", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    input_img = load_rgb(args.input)
    rendered_img = load_rgb(args.rendered)

    result = {
        "script": "docs/dev/spike-0002/scripts/ac25-metrics.py",
        "note": "单样本基线，仅供 SE 标定参考；非真机渲染链路、非验收结论",
        "input": {"path": args.input, "size": list(input_img.size)},
        "rendered": {"path": args.rendered, "size": list(rendered_img.size)},
        "metrics": {
            "landmark": landmark_proxy(input_img, rendered_img),
            "skin": skin_delta_e(input_img, rendered_img),
            "hair": hair_iou(input_img, rendered_img),
        },
        "thresholds_proposed": THRESHOLDS,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
