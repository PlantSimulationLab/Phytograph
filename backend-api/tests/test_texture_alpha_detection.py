"""Tests for `_texture_has_alpha`, which drives alpha-test cutout rendering.

The flag must reflect the image bytes, not the file extension:

- a JPEG never has transparency, even named ".png" (bark rendered as a cutout
  was the bug that introduced byte-sniffing in the first place);
- an RGBA / grey+alpha PNG has it in the IHDR colour type;
- an INDEXED (colour type 3) or colour-keyed PNG carries it in a `tRNS` chunk
  instead, and reading only the colour type misses it. Roughly a quarter of the
  bundled plantarchitecture leaf textures are palette PNGs, so that miss showed
  up as opaque grey rectangles on some leaves of a generated bean while the
  RGBA leaflets on the same plant cut out correctly.
"""
import struct
import zlib
from pathlib import Path

import pytest

import main


def _png(color_type: int, *, trns: bool, depth: int = 8) -> bytes:
    """Build a minimal 1x1 PNG with the given colour type, optionally + tRNS."""

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, depth, color_type, 0, 0, 0))
    if color_type == 3:
        out += chunk(b"PLTE", b"\x00\xff\x00")  # single green entry
    if trns:
        payload = {
            0: b"\x00\x00",          # grey: 2-byte transparent sample
            2: b"\x00\x00\x00\x00\x00\x00",  # truecolour: RGB key
            3: b"\x00",              # indexed: per-entry alpha
        }[color_type]
        out += chunk(b"tRNS", payload)
    # Raw scanline: filter byte + one pixel's worth of samples.
    samples = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    out += chunk(b"IDAT", zlib.compress(b"\x00" + b"\x00" * samples))
    out += chunk(b"IEND", b"")
    return out


JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


@pytest.mark.parametrize(
    "name, data, expected",
    [
        # IHDR alpha bit set — detected by the colour type alone.
        ("rgba", _png(6, trns=False), True),
        ("grey_alpha", _png(4, trns=False), True),
        # tRNS-only transparency — the regression this test guards.
        ("indexed_trns", _png(3, trns=True), True),
        ("grey_trns", _png(0, trns=True), True),
        ("truecolour_trns", _png(2, trns=True), True),
        # Genuinely opaque.
        ("indexed_opaque", _png(3, trns=False), False),
        ("rgb_opaque", _png(2, trns=False), False),
        ("grey_opaque", _png(0, trns=False), False),
    ],
)
def test_texture_has_alpha_reads_the_bytes(tmp_path, name, data, expected):
    path = tmp_path / f"{name}.png"
    path.write_bytes(data)
    assert main._texture_has_alpha(str(path)) is expected


def test_jpeg_is_opaque_even_when_named_png(tmp_path):
    """A JPEG has no transparency regardless of its extension.

    Helios plant assets ship opaque JPG bark; treating it as a cutout punched
    holes in the trunk.
    """
    path = tmp_path / "bark.png"
    path.write_bytes(JPEG)
    assert main._texture_has_alpha(str(path)) is False


def test_truncated_png_is_not_a_cutout(tmp_path):
    """A file too short to hold an IHDR must not crash or claim transparency."""
    path = tmp_path / "stub.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00")
    assert main._texture_has_alpha(str(path)) is False


def test_missing_file_falls_back_to_extension(tmp_path):
    assert main._texture_has_alpha(str(tmp_path / "gone.png")) is True
    assert main._texture_has_alpha(str(tmp_path / "gone.jpg")) is False
    assert main._texture_has_alpha(None) is False
    assert main._texture_has_alpha("") is False


def test_trns_after_idat_is_not_scanned(tmp_path):
    """The scan stops at IDAT, where the PNG spec requires tRNS to already be.

    Guards the early-out that keeps this from reading a multi-megabyte image.
    """
    data = _png(3, trns=False)
    # Splice a tRNS chunk in after IEND — illegal placement, must be ignored.
    path = tmp_path / "late.png"
    path.write_bytes(data + b"\x00\x00\x00\x01tRNS\x00\x00\x00\x00\x00")
    assert main._texture_has_alpha(str(path)) is False


# ---------------------------------------------------------------------------
# The real bundled assets
# ---------------------------------------------------------------------------

ASSETS = (
    Path(main.__file__).resolve().parent.parent
    / "pyhelios"
    / "helios-core"
    / "plugins"
    / "plantarchitecture"
    / "assets"
    / "textures"
)


@pytest.mark.skipif(not ASSETS.is_dir(), reason="plantarchitecture assets not checked out")
def test_palette_leaf_textures_report_alpha():
    """Every bundled leaf texture that encodes transparency must report it.

    BeanLeaf_tip is the concrete case from the bug report: a bean's trifoliate
    leaflets mix RGBA (left/right) with palette+tRNS (tip), so only the tip
    rendered as an opaque grey quad.
    """
    palette_leaves = [
        "BeanLeaf_tip.png",
        "TomatoLeaf_centered.png",
        "RedbudLeaf.png",
        "OliveLeaf_upper.png",
        "OliveLeaf_lower.png",
        "PistachioLeaf.png",
        "CapsicumLeaf.png",
        "CherryTomatoLeaf.png",
    ]
    present = [n for n in palette_leaves if (ASSETS / n).exists()]
    assert present, "no palette leaf textures found; asset layout changed?"
    for name in present:
        assert main._texture_has_alpha(str(ASSETS / name)) is True, (
            f"{name} encodes transparency via tRNS but was reported opaque; "
            "the viewer will render it as a solid rectangle"
        )


@pytest.mark.skipif(not ASSETS.is_dir(), reason="plantarchitecture assets not checked out")
def test_every_bean_leaf_texture_cuts_out():
    """All of a bean's leaf textures must be cutouts — that is the user-visible
    symptom: some leaves transparent, some opaque grey, on the same plant."""
    beans = sorted(ASSETS.glob("BeanLeaf*.png"))
    assert len(beans) >= 4, f"expected several bean leaf textures, found {beans}"
    opaque = [p.name for p in beans if not main._texture_has_alpha(str(p))]
    assert not opaque, f"bean leaf textures reported opaque: {opaque}"
