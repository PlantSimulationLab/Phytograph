"""Built-in tasks: a class schema plus how the unified corpus codes map onto it.

A task's ``classes`` become the model package's class schema, so their
``value``/``name``/``color`` are what the app writes and shows. ``wood_leaf``
is deliberately the ``wood_class`` column the geometric segmenter writes (1 =
wood, 2 = leaf, colors from ``WOOD_SCHEME_CLASSES`` in
``src/renderer/lib/classification.ts``). An ML result is then a drop-in for
LAD, export, split and remove, which all read that column.
"""

from __future__ import annotations

from .data.crops import TaskMap
from .data.readers import (SEM_BLADE, SEM_CROWN, SEM_FRUIT, SEM_GROUND, SEM_LEAF, SEM_LEAF_WHOLE,
                           SEM_ROOT, SEM_STEM, SEM_WOOD, SEM_YOUNG_LEAF)

TASKS = {
    "wood_leaf": {
        "classes": [
            {"value": 1, "name": "Wood", "color": "#664221"},
            {"value": 2, "name": "Leaf", "color": "#4db04f"},
        ],
        # SEM code -> output index. Petioles are leaf in the synthetic organ
        # grouping, as hand labelers treat them. Fruit and ground are
        # ignored: the tool, like the geometric one, expects ground removed,
        # and fruit is neither class.
        "sem_to_index": {SEM_WOOD: 0, SEM_LEAF: 1},
        "minority_codes": (SEM_WOOD,),
        "output_slug": "wood_class",
    },
    "wood_leaf_fruit": {
        "classes": [
            {"value": 1, "name": "Wood", "color": "#664221"},
            {"value": 2, "name": "Leaf", "color": "#4db04f"},
            {"value": 3, "name": "Fruit", "color": "#e0452b"},
        ],
        "sem_to_index": {SEM_WOOD: 0, SEM_LEAF: 1, SEM_FRUIT: 2},
        "minority_codes": (SEM_WOOD, SEM_FRUIT),
        "output_slug": "organ_class",
    },
    # Herbaceous plants, in the scheme PlantCloudFit reads: soil, stem (with
    # petioles, rachises and petiolules), leaf blade, plus one instance per
    # leaflet blade from the offset head. A code may map to several classes:
    # Sugar4D's leaf is blade AND petiole undivided, and its crown is petiole
    # bases plus leaves too young to separate, so both only say "not soil".
    # Their instances still train the offset head. An exposed taproot is the
    # reverse: nobody would call it soil or stem with confidence, but it is
    # certainly not a leaf blade. Ignoring it instead let the model call 90 %
    # of it leaf, and each beet shoulder became a phantom leaf instance.
    "plant_organ": {
        "classes": [
            {"value": 1, "name": "Soil", "color": "#8a6a4a"},
            {"value": 2, "name": "Stem", "color": "#c9a227"},
            {"value": 3, "name": "Leaf", "color": "#3f9b3a"},
        ],
        "sem_to_index": {SEM_GROUND: 0, SEM_STEM: 1, SEM_BLADE: 2},
        "sem_to_allowed": {SEM_LEAF_WHOLE: (1, 2), SEM_CROWN: (1, 2), SEM_ROOT: (0, 1), SEM_YOUNG_LEAF: (1, 2)},
        "minority_codes": (SEM_STEM,),
        "instance_codes": (SEM_BLADE, SEM_LEAF_WHOLE, SEM_YOUNG_LEAF),
        "instance_class": 2,
        # Regions whose leaves the source never separated: a predicted
        # instance there is not scored (``ml.instances.match``).
        "instance_ignore_codes": (SEM_CROWN,),
        "output_slug": "plant_organ",
    },
}


def task_map(name: str) -> TaskMap:
    t = TASKS[name]
    return TaskMap(sem_to_index=dict(t["sem_to_index"]), num_classes=len(t["classes"]),
                   sem_to_allowed={k: tuple(v) for k, v in t.get("sem_to_allowed", {}).items()},
                   instance_codes=tuple(t.get("instance_codes", ())))
