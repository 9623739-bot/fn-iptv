from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


BASE = Path(__file__).resolve().parent


def rounded_gradient(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(canvas * 0.23)
    mask = Image.new("L", (canvas, canvas), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=radius, fill=255)

    top = (34, 197, 94)
    mid = (37, 99, 235)
    bottom = (124, 58, 237)
    grad = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    px = grad.load()
    for y in range(canvas):
      t = y / max(1, canvas - 1)
      if t < 0.5:
          k = t / 0.5
          color = tuple(round(top[i] * (1 - k) + mid[i] * k) for i in range(3))
      else:
          k = (t - 0.5) / 0.5
          color = tuple(round(mid[i] * (1 - k) + bottom[i] * k) for i in range(3))
      for x in range(canvas):
          px[x, y] = (*color, 255)
    img.alpha_composite(Image.composite(grad, Image.new("RGBA", (canvas, canvas)), mask))

    # Subtle screen/play glyph: TV screen with a play button, readable at 64px.
    inset = int(canvas * 0.18)
    screen = (inset, int(canvas * 0.24), canvas - inset, int(canvas * 0.70))
    draw.rounded_rectangle(screen, radius=int(canvas * 0.08), outline=(255, 255, 255, 240), width=max(4, canvas // 36))
    stand_y = int(canvas * 0.78)
    draw.line((int(canvas * 0.46), int(canvas * 0.70), int(canvas * 0.41), stand_y), fill=(255, 255, 255, 230), width=max(3, canvas // 32))
    draw.line((int(canvas * 0.54), int(canvas * 0.70), int(canvas * 0.59), stand_y), fill=(255, 255, 255, 230), width=max(3, canvas // 32))
    draw.line((int(canvas * 0.34), stand_y, int(canvas * 0.66), stand_y), fill=(255, 255, 255, 230), width=max(3, canvas // 32))

    tri = [
        (int(canvas * 0.45), int(canvas * 0.38)),
        (int(canvas * 0.45), int(canvas * 0.60)),
        (int(canvas * 0.63), int(canvas * 0.49)),
    ]
    draw.polygon(tri, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.Resampling.LANCZOS)


def save_png(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    icon = rounded_gradient(size)
    icon.save(path, "PNG", optimize=True)
    print(f"wrote {path} {size}")


def main() -> None:
    save_png(BASE / "ICON.PNG", 256)
    save_png(BASE / "ICON_256.PNG", 256)
    save_png(BASE / "app/ui/images/icon_64.png", 64)
    save_png(BASE / "app/ui/images/icon_128.png", 128)
    save_png(BASE / "app/ui/images/icon_256.png", 256)
    save_png(BASE / "app/ui/html/images/icon_64.png", 64)
    save_png(BASE / "app/ui/html/images/icon_128.png", 128)
    save_png(BASE / "app/ui/html/images/icon_256.png", 256)
    save_png(BASE / "app/ui/html/favicon.png", 64)

    ico = rounded_gradient(256)
    ico.save(
        BASE / "app/ui/html/favicon.ico",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {BASE / 'app/ui/html/favicon.ico'}")


if __name__ == "__main__":
    main()
