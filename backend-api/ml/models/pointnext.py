"""PointNeXt-style semantic segmentation (Qian et al., NeurIPS 2022).

The architecture follows the paper: a stem MLP, four set-abstraction stages
that each downsample and double the width, InvResMLP blocks inside each stage
(a local max-pooled aggregation followed by an inverted-bottleneck MLP with a
residual), and a feature-propagation decoder with skip connections. What
differs is where the neighbourhoods come from (see ``ml/hierarchy.py``): they
are precomputed indices, so every op here is a gather, a linear layer, a
batch norm or a max. That runs on CUDA, MPS and CPU with no custom kernel.

The paper's variants, in (width, blocks per stage):

- S = (32, (0, 0, 0, 0))
- B = (32, (1, 2, 1, 1))
- L = (32, (2, 4, 2, 2))

Positions enter the network in metric units, relative to each group's centre
and divided by that level's radius. They are never rescaled per crop: a twig's
diameter is itself the signal, so a 1 cm branch must look different from a
10 cm one.
"""

from __future__ import annotations

import torch
from torch import nn

VARIANTS = {
    "S": {"width": 32, "blocks": (0, 0, 0, 0)},
    "B": {"width": 32, "blocks": (1, 2, 1, 1)},
    "L": {"width": 32, "blocks": (2, 4, 2, 2)},
}


def _mlp(dims: list[int], last_act: bool = True) -> nn.Sequential:
    """Point-wise MLP over (points, channels), with BN and ReLU after each layer
    except, optionally, the last."""
    layers: list[nn.Module] = []
    for j in range(len(dims) - 1):
        layers.append(nn.Linear(dims[j], dims[j + 1], bias=False))
        layers.append(nn.BatchNorm1d(dims[j + 1]))
        if j < len(dims) - 2 or last_act:
            layers.append(nn.ReLU(inplace=True))
    return nn.Sequential(*layers)


def _grouped(x: torch.Tensor, idx: torch.Tensor) -> torch.Tensor:
    """Gather rows of ``x`` (n, c) at ``idx`` (m, k), giving (m, k, c)."""
    return x[idx.reshape(-1)].reshape(idx.shape[0], idx.shape[1], x.shape[1])


class GroupedPool(nn.Module):
    """Pool a neighbourhood: MLP over [neighbour feature, relative position],
    then max over the group. Used both to downsample (set abstraction) and to
    aggregate within one level (the first half of InvResMLP)."""

    def __init__(self, c_in: int, c_out: int, layers: int):
        super().__init__()
        self.mlp = _mlp([c_in + 3] + [c_out] * layers)

    def forward(self, feat, pos_src, pos_dst, idx, radius: float):
        m, k = idx.shape
        rel = (_grouped(pos_src, idx) - pos_dst[:, None, :]) / radius
        g = torch.cat([_grouped(feat, idx), rel], dim=-1).reshape(m * k, -1)
        return self.mlp(g).reshape(m, k, -1).max(dim=1).values


class InvResMLP(nn.Module):
    """Local aggregation, then an inverted-bottleneck MLP, with a residual."""

    def __init__(self, c: int, expansion: int = 4):
        super().__init__()
        self.agg = GroupedPool(c, c, layers=1)
        self.pw = _mlp([c, c * expansion, c], last_act=False)
        self.act = nn.ReLU(inplace=True)

    def forward(self, feat, pos, idx, radius: float):
        y = self.pw(self.agg(feat, pos, pos, idx, radius))
        return self.act(feat + y)


class PointNeXtSeg(nn.Module):
    def __init__(
        self,
        in_channels: int,
        num_classes: int,
        radii: list[float],
        variant: str = "S",
        width: int | None = None,
        blocks: tuple[int, ...] | None = None,
        dropout: float = 0.5,
    ):
        super().__init__()
        cfg = VARIANTS[variant]
        width = width or cfg["width"]
        blocks = tuple(blocks or cfg["blocks"])
        self.levels = len(blocks) + 1
        if len(radii) != self.levels:
            raise ValueError(f"need {self.levels} radii, got {len(radii)}")
        self.radii = [float(r) for r in radii]
        widths = [width * (2 ** i) for i in range(self.levels)]
        self.widths = widths

        # The input features always include the point's metric offset from the
        # crop centre (3 channels) ahead of any extra channels.
        self.stem = _mlp([in_channels, widths[0]])
        self.down = nn.ModuleList()
        self.stages = nn.ModuleList()
        for i in range(1, self.levels):
            self.down.append(GroupedPool(widths[i - 1], widths[i], layers=2))
            self.stages.append(nn.ModuleList(InvResMLP(widths[i]) for _ in range(blocks[i - 1])))
        self.up = nn.ModuleList()
        for i in range(self.levels - 1, 0, -1):
            self.up.append(_mlp([widths[i] + widths[i - 1], widths[i - 1], widths[i - 1]]))
        self.head = nn.Sequential(
            _mlp([widths[0], widths[0]]),
            nn.Dropout(dropout),
            nn.Linear(widths[0], num_classes),
        )

    def forward(self, batch: dict) -> torch.Tensor:
        """``batch`` is a collated hierarchy (see ``ml.hierarchy.collate``)
        whose arrays are torch tensors on the model's device, plus ``feat``:
        (n0, in_channels). Returns (n0, num_classes) logits."""
        pos, local, down = batch["pos"], batch["local"], batch["down"]
        x = self.stem(batch["feat"])
        skips = [x]
        for i in range(1, self.levels):
            x = self.down[i - 1](x, pos[i - 1], pos[i], down[i], self.radii[i])
            for block in self.stages[i - 1]:
                x = block(x, pos[i], local[i], self.radii[i])
            skips.append(x)
        for j, i in enumerate(range(self.levels - 1, 0, -1)):
            idx, w = batch["up_idx"][i], batch["up_w"][i]
            interp = (_grouped(x, idx) * w[..., None]).sum(dim=1)
            x = self.up[j](torch.cat([interp, skips[i - 1]], dim=-1))
        return self.head(x)
