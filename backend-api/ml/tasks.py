"""Built-in tasks: a class schema plus how the unified corpus codes map onto it.

A task's ``classes`` become the model package's class schema, so their
``value``/``name``/``color`` are what the app writes and shows. ``wood_leaf``
is deliberately the ``wood_class`` column the geometric segmenter writes (1 =
wood, 2 = leaf, colours from ``WOOD_SCHEME_CLASSES`` in
``src/renderer/lib/classification.ts``). An ML result is then a drop-in for
LAD, export, split and remove, which all read that column.
"""

from __future__ import annotations

from .data.crops import TaskMap
from .data.readers import SEM_FRUIT, SEM_LEAF, SEM_WOOD

TASKS = {
    "wood_leaf": {
        "classes": [
            {"value": 1, "name": "Wood", "color": "#664221"},
            {"value": 2, "name": "Leaf", "color": "#4db04f"},
        ],
        # SEM code -> output index. Petioles are leaf in the synthetic organ
        # grouping, as hand labellers treat them. Fruit and ground are
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
}


def task_map(name: str) -> TaskMap:
    t = TASKS[name]
    return TaskMap(sem_to_index=dict(t["sem_to_index"]), num_classes=len(t["classes"]))
