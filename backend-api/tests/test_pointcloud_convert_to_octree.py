"""Tests for /api/pointcloud/convert_to_octree and /api/pointcloud/octree_metadata.

These tests need a real PotreeConverter binary to run. They look it up via the
same resolution chain the endpoint uses, and skip the whole module if no
binary is reachable. CI is expected to make one available either via
`resources/potree_converter/<platform>/` (preferred) or PHYTOGRAPH_POTREECONVERTER.

Cache root is isolated per-test via PHYTOGRAPH_OCTREE_CACHE_ROOT so successive
runs and parallel tests don't collide.
"""
import json
import os
from pathlib import Path

import pytest

import main


def _converter_available() -> bool:
    try:
        main._resolve_potree_converter_path()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _converter_available(),
    reason="PotreeConverter binary not found; build it via npm run build:potree-converter",
)


@pytest.fixture
def cache_root(tmp_path, monkeypatch) -> Path:
    """Per-test isolated cache root so tests don't share state."""
    root = tmp_path / "octree_cache"
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(root))
    return root


@pytest.fixture
def tiny_xyz(tmp_path) -> Path:
    """20 points spanning a known AABB with RGB + reflectance, in the
    BPPtree column layout. Small enough to convert in <1s."""
    f = tmp_path / "tiny.xyz"
    lines = []
    for i in range(20):
        x = (i % 5) * 0.5
        y = (i // 5) * 0.5
        z = i * 0.1
        r = (i * 13) % 256
        g = (i * 29) % 256
        b = (i * 47) % 256
        refl = (i * 0.05) % 1.0
        lines.append(f"{x:.4f} {y:.4f} {z:.4f} {r} {g} {b} {refl:.4f}")
    f.write_text("\n".join(lines) + "\n")
    return f


def test_convert_to_octree_produces_three_files(client, cache_root, tiny_xyz):
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={
            "source_path": str(tiny_xyz),
            "ascii_format": "x y z r255 g255 b255 reflectance",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["point_count"] == 20
    assert body["cached"] is False
    assert len(body["cache_id"]) == 40

    cache_dir = Path(body["cache_dir"])
    assert cache_dir.is_dir()
    assert (cache_dir / "metadata.json").is_file()
    assert (cache_dir / "hierarchy.bin").is_file()
    assert (cache_dir / "octree.bin").is_file()


def test_convert_to_octree_bounds_contain_input(client, cache_root, tiny_xyz):
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={
            "source_path": str(tiny_xyz),
            "ascii_format": "x y z r255 g255 b255 reflectance",
        },
    )
    body = res.json()

    # Input spans x=[0, 2], y=[0, 1.5], z=[0, 1.9]. PotreeConverter pads the
    # bounding box out to a cube so the octree has regular cells, so the
    # reported max may exceed the data max — what matters is containment.
    mn, mx = body["bounds"]["min"], body["bounds"]["max"]
    assert mn[0] <= 0.0 + 1e-3 and mx[0] >= 2.0 - 1e-3
    assert mn[1] <= 0.0 + 1e-3 and mx[1] >= 1.5 - 1e-3
    assert mn[2] <= 0.0 + 1e-3 and mx[2] >= 1.9 - 1e-3
    # Cube extension: max range across axes is the side length on every axis.
    sides = [mx[i] - mn[i] for i in range(3)]
    assert max(sides) - min(sides) < 1e-3, f"bbox not cubical: sides={sides}"


def test_tight_bounds_match_actual_data_extent(client, cache_root, tiny_xyz):
    """The `tight_bounds` field is the actual data range — used for crop-box
    init and camera framing. PotreeConverter's `bounds` is a cube-padded
    super-set; UI logic that uses it directly draws boxes much bigger than
    the data they're supposed to outline."""
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={
            "source_path": str(tiny_xyz),
            "ascii_format": "x y z r255 g255 b255 reflectance",
        },
    )
    body = res.json()

    assert "tight_bounds" in body
    tmn, tmx = body["tight_bounds"]["min"], body["tight_bounds"]["max"]
    # Tight bounds should match the actual input range within
    # PotreeConverter's quantisation step (0.001).
    assert tmn[0] == pytest.approx(0.0, abs=0.01)
    assert tmn[1] == pytest.approx(0.0, abs=0.01)
    assert tmn[2] == pytest.approx(0.0, abs=0.01)
    assert tmx[0] == pytest.approx(2.0, abs=0.01)
    assert tmx[1] == pytest.approx(1.5, abs=0.01)
    assert tmx[2] == pytest.approx(1.9, abs=0.01)
    # And tight_bounds must be strictly inside (or equal to) the padded bounds.
    pmn, pmx = body["bounds"]["min"], body["bounds"]["max"]
    for i in range(3):
        assert pmn[i] <= tmn[i] + 1e-6
        assert pmx[i] >= tmx[i] - 1e-6


def test_convert_to_octree_preserves_rgb_and_intensity_attrs(client, cache_root, tiny_xyz):
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={
            "source_path": str(tiny_xyz),
            "ascii_format": "x y z r255 g255 b255 reflectance",
        },
    )
    attrs = {a["name"] for a in res.json()["attributes"]}
    # The output schema is locked to "position rgb intensity" by the
    # backend's --attributes flag. Position is always present; rgb +
    # intensity must survive XYZ→LAS→octree.
    assert "position" in attrs
    assert "rgb" in attrs
    assert "intensity" in attrs


def test_second_call_hits_cache(client, cache_root, tiny_xyz):
    body1 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()
    assert body1["cached"] is False

    # Note the cache dir's mtime; if the converter ran again it would be touched.
    cache_dir = Path(body1["cache_dir"])
    bin_mtime = (cache_dir / "octree.bin").stat().st_mtime_ns

    body2 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()
    assert body2["cached"] is True
    assert body2["cache_id"] == body1["cache_id"]
    assert (cache_dir / "octree.bin").stat().st_mtime_ns == bin_mtime


def test_cache_key_changes_when_source_mtime_changes(client, cache_root, tiny_xyz):
    body1 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()

    # Bump mtime by writing the file again. Content can be different, but
    # the mtime alone is enough — the cache key includes it precisely to
    # catch edits to the source.
    os.utime(tiny_xyz, ns=(0, tiny_xyz.stat().st_mtime_ns + 1_000_000_000))

    body2 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()
    assert body2["cache_id"] != body1["cache_id"]
    assert body2["cached"] is False


def test_missing_source_returns_404(client, cache_root):
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": "/nonexistent/path/foo.xyz"},
    )
    assert res.status_code == 404


def test_ascii_format_without_xyz_returns_400(client, cache_root, tmp_path):
    f = tmp_path / "no_xyz.xyz"
    f.write_text("1 2 3\n4 5 6\n")
    res = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(f), "ascii_format": "r255 g255 b255"},
    )
    # _xyz_to_las raises 400 when x/y/z aren't in the format. The error
    # propagates through the staging dir cleanup unchanged.
    assert res.status_code == 400
    assert "x/y/z" in res.text


def test_octree_metadata_returns_expected_shape(client, cache_root, tiny_xyz):
    create = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()
    cache_id = create["cache_id"]

    res = client.get(f"/api/pointcloud/octree_metadata?cache_id={cache_id}")
    assert res.status_code == 200
    meta = res.json()
    assert meta["cache_id"] == cache_id
    assert meta["point_count"] == 20
    assert "bounds" in meta and "min" in meta["bounds"] and "max" in meta["bounds"]
    assert "attributes" in meta
    assert {"position", "rgb", "intensity"} <= {a["name"] for a in meta["attributes"]}


def test_octree_metadata_rejects_bad_cache_id(client, cache_root):
    res = client.get("/api/pointcloud/octree_metadata?cache_id=../../etc/passwd")
    assert res.status_code == 400


def test_octree_metadata_404_on_unknown_id(client, cache_root):
    # Valid sha1 shape but no cache entry.
    fake_id = "0" * 40
    res = client.get(f"/api/pointcloud/octree_metadata?cache_id={fake_id}")
    assert res.status_code == 404


def test_canonical_ascii_format_collapses_whitespace_and_case():
    assert main._canonical_ascii_format("X Y Z r255 g255 b255") == "x y z r255 g255 b255"
    assert main._canonical_ascii_format("  x   y\tz ") == "x y z"
    assert main._canonical_ascii_format(None) == ""
    assert main._canonical_ascii_format("") == ""


def test_cache_key_changes_with_ascii_format(client, cache_root, tiny_xyz):
    body1 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()
    body2 = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(tiny_xyz), "ascii_format": "x y z"},
    ).json()
    assert body1["cache_id"] != body2["cache_id"]


def test_eviction_keeps_fresh_drops_old(client, cache_root, tmp_path, monkeypatch):
    """When the cache is over cap, the just-created dir survives and at
    least one older one gets dropped."""
    # Make 4 distinct sources so we get 4 cache dirs.
    def make_xyz(idx: int) -> Path:
        f = tmp_path / f"src_{idx}.xyz"
        lines = [f"{x:.4f} 0 0 100 100 100 0.5" for x in range(20)]
        f.write_text("\n".join(lines) + "\n")
        return f

    sources = [make_xyz(i) for i in range(4)]

    # First three with a huge cap — none evicted.
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES", "1000000000")
    bodies = []
    for s in sources[:3]:
        b = client.post(
            "/api/pointcloud/convert_to_octree",
            json={"source_path": str(s), "ascii_format": "x y z r255 g255 b255 reflectance"},
        ).json()
        bodies.append(b)

    # Confirm three dirs exist.
    assert sum(1 for d in cache_root.iterdir() if d.is_dir() and not d.name.endswith(".staging")) == 3

    # Manually backdate atime on the oldest one so we know which the LRU
    # will pick. (The tests run too fast for ctime to differ reliably.)
    oldest = cache_root / bodies[0]["cache_id"]
    import os as _os_test
    _os_test.utime(oldest, ns=(0, 0))  # epoch

    # Cap below current usage to force eviction; tiny clouds are <1 KB each.
    total = sum(
        sum(f.stat().st_size for f in (cache_root / b["cache_id"]).rglob("*") if f.is_file())
        for b in bodies
    )
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES", str(total // 2))

    fresh = client.post(
        "/api/pointcloud/convert_to_octree",
        json={"source_path": str(sources[3]), "ascii_format": "x y z r255 g255 b255 reflectance"},
    ).json()

    # The just-created cache entry must still exist.
    assert (cache_root / fresh["cache_id"]).is_dir()
    # The backdated one must be gone.
    assert not oldest.exists()


def test_evict_helper_under_cap_is_noop(cache_root, monkeypatch, tmp_path):
    """If total cache size is below the cap, _evict_octree_cache returns
    an empty list and removes nothing."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(cache_root))
    cache_root.mkdir(parents=True, exist_ok=True)
    fake = cache_root / ("a" * 40)
    fake.mkdir()
    (fake / "octree.bin").write_bytes(b"x" * 100)

    evicted = main._evict_octree_cache(max_bytes=10_000_000)
    assert evicted == []
    assert fake.is_dir()


def test_evict_helper_ignores_non_sha1_entries(cache_root, monkeypatch):
    """Stray files / non-sha1 dirs in the cache root must not be touched
    even when the cap is set to 0."""
    monkeypatch.setenv("PHYTOGRAPH_OCTREE_CACHE_ROOT", str(cache_root))
    cache_root.mkdir(parents=True, exist_ok=True)
    (cache_root / "README.txt").write_text("user dropped a file in here")
    (cache_root / "not-a-hash").mkdir()
    (cache_root / "not-a-hash" / "foo").write_bytes(b"bar")
    valid = cache_root / ("c" * 40)
    valid.mkdir()
    (valid / "octree.bin").write_bytes(b"x" * 1000)

    main._evict_octree_cache(max_bytes=0)
    # Non-sha1 entries survive; only valid cache dirs are subject to LRU.
    assert (cache_root / "README.txt").exists()
    assert (cache_root / "not-a-hash").exists()
    assert not valid.exists()
