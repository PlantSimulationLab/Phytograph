"""Training data: corpus readers, the on-disk voxel cache, and crop sampling.

Every source is read into one labelled form, :class:`readers.Cloud`, using a
unified semantic code (:data:`readers.SEM`). The labels of a particular task
(wood/leaf today; fruit, organs later) are derived from it at training time,
through that task's class map, so the cache is built once for every task.
"""
