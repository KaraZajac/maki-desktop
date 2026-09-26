#!/usr/bin/env python3
"""Draw maki's icons: a maki roll in cross-section (nori, rice, filling). No dependencies.

    python3 scripts/icons.py      # writes resources/*.png

The tray icon's filling is grey while looking for maki and salmon once linked.
"""
import pathlib
import struct
import zlib

NORI = (29, 58, 42)
RICE = (243, 239, 230)
SALMON = (255, 122, 89)
IDLE = (140, 140, 140)
OUT = pathlib.Path(__file__).resolve().parent.parent / "resources"


def roll(size, filling, sub=4):
    """RGBA rows for a roll filling the square, antialiased by supersampling."""
    c = size / 2
    r_nori, r_rice, r_fill = size * 0.47, size * 0.39, size * 0.17
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(sub):
                for sx in range(sub):
                    px, py = x + (sx + 0.5) / sub, y + (sy + 0.5) / sub
                    d = ((px - c) ** 2 + (py - c) ** 2) ** 0.5
                    color = filling if d <= r_fill else RICE if d <= r_rice else NORI if d <= r_nori else None
                    if color:
                        for i in range(3):
                            acc[i] += color[i]
                        acc[3] += 255
            n = sub * sub
            alpha = acc[3] / n
            if alpha:
                row += bytes(round(acc[i] / (acc[3] / 255)) for i in range(3)) + bytes([round(alpha)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(path, size, rows):
    raw = b"".join(b"\0" + r for r in rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    png(OUT / "icon.png", 512, roll(512, SALMON, sub=2))
    for name, filling in (("tray", IDLE), ("tray-linked", SALMON)):
        png(OUT / f"{name}.png", 32, roll(32, filling))
        png(OUT / f"{name}@2x.png", 64, roll(64, filling))
    print("wrote", sorted(p.name for p in OUT.glob("*.png")))
