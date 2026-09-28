"""Run by test_ml_worker_isolation.py in a FRESH interpreter, set up the way the
seg worker is (PHYTOGRAPH_SEG_WORKER=1): import main, then run the bundled
wood/leaf model through the same `main.segment_wood(method="ml")` call the
worker's "wood" tool makes.

Prints one JSON object: whether libhelios was mapped after `import main`, the
OpenMP runtimes mapped after inference, and the label counts. Not a test module
(no `test_` prefix), so pytest never imports it into its own process.
"""
import ctypes
import json
import sys
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def _mapped_images() -> list:
    """Paths of every native image loaded into this process."""
    if sys.platform == "darwin":
        dyld = ctypes.CDLL(None)
        dyld._dyld_image_count.restype = ctypes.c_uint32
        dyld._dyld_get_image_name.restype = ctypes.c_char_p
        dyld._dyld_get_image_name.argtypes = [ctypes.c_uint32]
        return [dyld._dyld_get_image_name(i).decode() for i in range(dyld._dyld_image_count())]
    if sys.platform.startswith("linux"):
        with open("/proc/self/maps") as f:
            return sorted({line.split()[-1] for line in f if "/" in line})
    return []


import main  # noqa: E402

after_main = _mapped_images()
points = np.loadtxt(BACKEND / "tests" / "fixtures" / "leafwood" / "weiser_oak_small.xyz",
                    usecols=(0, 1, 2))
labels = main.segment_wood(points, method="ml")
after_inference = _mapped_images()

json.dump({
    "libhelios_after_main": [p for p in after_main if "libhelios" in p],
    "omp_after_inference": [p for p in after_inference if "libomp" in p or "libgomp" in p],
    "n_points": int(len(points)),
    "n_labels": int(len(labels)),
    "n_wood": int((labels == main.WOOD_CLASS_WOOD).sum()),
    "n_leaf": int((labels == main.WOOD_CLASS_LEAF).sum()),
}, sys.stdout)
