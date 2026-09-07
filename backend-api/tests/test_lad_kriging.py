"""LAD-kriging occlusion fill (backend-api/lad_kriging.py).

Pure numpy/scipy -- no pyhelios, so these run everywhere and fast.

THE FIXTURE RULE, learned the hard way: kriging can only beat a layer mean when the
field HAS spatial structure. The repo's lad-leafcube is a deliberately HOMOGENEOUS
cube, where kriging correctly degenerates toward a variance-weighted global mean and
measures slightly worse than a layer mean. So the accuracy test below builds a
STRUCTURED field (a smooth vertical gradient plus a horizontal wave), which is what
Soma et al. (2020) assume and what real canopy looks like. Testing an interpolator on
a structureless field proves nothing -- the same blind spot as using the spherical
leaf-angle distribution to test G(theta).
"""

import numpy as np
import pytest

import lad_kriging


def _grid(n=10, edge=0.5):
    """A regular n^3 lattice, with each cell's horizontal layer index."""
    ax = np.arange(n) * edge
    gx, gy, gz = np.meshgrid(ax, ax, ax, indexing="ij")
    pos = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    # Layer = z index, matching Helios's k-major cell ordering upstream.
    layers = np.rint(pos[:, 2] / edge).astype(int)
    return pos, layers


def _structured_truth(pos):
    """A realistic canopy shape: a vertical LAD peak plus a horizontal wave."""
    return 1.5 + 2.0 * np.exp(-((pos[:, 2] - 2.0) ** 2) / 1.5) + 0.5 * np.sin(pos[:, 0] * 1.2)


class TestEmpiricalVariogram:
    def test_subtracts_the_known_measurement_variance(self):
        """The bias adjustment is the whole point: the nugget must reflect the field,
        not the noise. Same field, larger declared variance => lower gamma."""
        rng = np.random.default_rng(0)
        pos, _ = _grid(n=8, edge=0.5)
        truth = _structured_truth(pos)
        obs = truth + rng.normal(0, 0.5, len(pos))

        _, g_small = lad_kriging.empirical_variogram(
            pos, obs, np.full(len(pos), 0.01), 0.5)
        _, g_large = lad_kriging.empirical_variogram(
            pos, obs, np.full(len(pos), 0.25), 0.5)

        assert len(g_small) >= 3
        # Every lag drops by exactly the difference in declared error variance.
        assert np.allclose(g_small - g_large, 0.24, atol=1e-9)

    def test_too_few_points_yields_empty(self):
        pos = np.array([[0.0, 0.0, 0.0]])
        lags, gam = lad_kriging.empirical_variogram(
            pos, np.array([1.0]), np.array([0.1]), 0.5)
        assert len(lags) == 0 and len(gam) == 0


class TestFitVariogram:
    def test_recovers_a_known_exponential(self):
        h = np.linspace(0.5, 3.0, 8)
        gam = lad_kriging._exponential_model(h, 0.2, 2.0, 1.5)
        fit = lad_kriging.fit_variogram(h, gam)
        assert fit is not None
        nugget, sill, rng = fit
        assert nugget == pytest.approx(0.2, abs=0.05)
        assert sill == pytest.approx(2.0, abs=0.1)
        assert rng == pytest.approx(1.5, abs=0.2)

    def test_flat_variogram_is_degenerate(self):
        """No spatial variance => nothing to krige with; the caller must fall back."""
        h = np.linspace(0.5, 3.0, 8)
        assert lad_kriging.fit_variogram(h, np.zeros_like(h)) is None

    def test_too_few_lags_is_degenerate(self):
        assert lad_kriging.fit_variogram(np.array([0.5, 1.0]), np.array([0.1, 0.2])) is None


class TestFillOccluded:
    def _case(self, seed=7, occ_frac=0.30, noise=0.6, n=10, edge=0.5):
        rng = np.random.default_rng(seed)
        pos, layers = _grid(n=n, edge=edge)
        truth = _structured_truth(pos)
        obs = truth + rng.normal(0, noise, len(pos))
        var = np.full(len(pos), noise ** 2)
        occ = rng.random(len(pos)) < occ_frac
        return pos, layers, truth, obs, var, occ, edge

    def test_kriging_beats_the_layer_mean_on_a_structured_field(self):
        """The reason this module exists rather than a layer mean (Soma et al. 2020)."""
        pos, layers, truth, obs, var, occ, edge = self._case()
        fills, method = lad_kriging.fill_occluded(pos, obs, var, occ, layers, edge)
        assert method == "kriging"

        # Layer-mean reference, computed the same way the fallback would.
        donor = ~occ
        lmeans = {int(l): float(obs[donor & (layers == l)].mean())
                  for l in np.unique(layers) if (donor & (layers == l)).any()}

        tgt = np.where(occ)[0]
        err_k = np.median([abs(fills[int(i)] - truth[i]) for i in tgt if int(i) in fills])
        err_l = np.median([abs(lmeans[int(layers[i])] - truth[i])
                           for i in tgt if int(layers[i]) in lmeans])
        assert err_k < err_l, f"kriging {err_k:.3f} should beat layer mean {err_l:.3f}"
        # The measured margin is ~3x; require a clear win, not a coin flip.
        assert err_k < 0.6 * err_l

    def test_unreliable_donors_are_downweighted(self):
        """A donor's declared variance must change the estimate -- that IS the
        'weighted according to their reliability' of the method. Two identical
        layouts differing only in WHICH donor is noisy must predict differently."""
        pos, layers = _grid(n=6, edge=0.5)
        truth = _structured_truth(pos)
        occ = np.zeros(len(pos), dtype=bool)
        occ[len(pos) // 2] = True

        near = int(np.argsort(((pos - pos[len(pos) // 2]) ** 2).sum(-1))[1])
        far = int(np.argsort(((pos - pos[len(pos) // 2]) ** 2).sum(-1))[-1])

        obs = truth.copy()
        obs[near] += 3.0            # a badly-off neighbour
        v_trust_near = np.full(len(pos), 0.05)
        v_doubt_near = v_trust_near.copy()
        v_doubt_near[near] = 50.0   # ...now declared unreliable

        a, _ = lad_kriging.fill_occluded(pos, obs, v_trust_near, occ, layers, 0.5)
        b, _ = lad_kriging.fill_occluded(pos, obs, v_doubt_near, occ, layers, 0.5)
        i = len(pos) // 2
        # Doubting the off neighbour must pull the estimate back toward truth.
        assert abs(b[i] - truth[i]) < abs(a[i] - truth[i])
        assert far != near  # sanity: the layout really has distinct neighbours

    def test_well_measured_zeros_are_valid_donors(self):
        """REGRESSION: a voxel that genuinely measured ZERO leaf area is evidence
        that a region is empty, and must inform the fill.

        Excluding zero donors leaves only foliage donors, so an occluded voxel
        surrounded by well-measured empty space gets filled with the mean of nearby
        LEAVES — biasing every fill upward, the mirror image of the low bias this
        whole feature exists to remove.
        """
        pos, layers = _grid(n=6, edge=0.5)
        # Empty half (x < 1.25) genuinely measures 0; leafy half measures 4.
        truth = np.where(pos[:, 0] < 1.25, 0.0, 4.0)
        var = np.full(len(pos), 0.01)
        occ = np.zeros(len(pos), dtype=bool)
        # Occlude one voxel deep inside the EMPTY half.
        target = int(np.argmin(np.abs(pos[:, 0] - 0.5) + np.abs(pos[:, 1] - 1.0)
                               + np.abs(pos[:, 2] - 1.0)))
        occ[target] = True

        fills, _ = lad_kriging.fill_occluded(pos, truth, var, occ, layers, 0.5)
        assert target in fills
        # It sits among zeros, so it must fill near 0 — not pulled up toward the
        # leafy half by donors that exclude the zeros.
        assert fills[target] < 1.0, (
            f"filled {fills[target]:.2f} in a region measured as empty; zero-LAD "
            "donors are being ignored")

    def test_wild_extrapolations_fall_back_rather_than_inject_a_huge_lad(self):
        """Ordinary-kriging weights sum to 1 but can be large and of either sign, so
        an ill-conditioned or far-extrapolated prediction can land far outside
        anything observed. That value would flow straight into leaf area, so a
        prediction outside the donor range must be refused, not clamped silently."""
        pos, layers = _grid(n=6, edge=0.5)
        rng = np.random.default_rng(11)
        z = 2.0 + rng.normal(0, 0.01, len(pos))
        var = np.full(len(pos), 0.0001)
        occ = np.zeros(len(pos), dtype=bool)
        occ[0] = True
        fills, _ = lad_kriging.fill_occluded(pos, z, var, occ, layers, 0.5)
        # Whatever path ran, the answer stays inside the observed range.
        donors = z[~occ]
        assert donors.min() - 1e-9 <= fills[0] <= donors.max() + 1e-9

    def test_sparse_grid_still_kriges_rather_than_silently_degrading(self):
        """REGRESSION: on a terrain-following grid whole columns are dropped, so the
        surviving cells can sit several nominal voxel sides apart. Binning the
        variogram from the NOMINAL size then leaves the near lags unpopulated, the
        fit fails, and every such fill quietly becomes a layer mean with nothing to
        explain why. The lag scale must follow the donors' actual spacing.

        Calibrated so the lag SCALE alone decides the outcome: 94 donors 2.0 m
        apart against a 0.5 m nominal size gives 2 populated lags (below the 3
        fit_variogram needs) versus 10 when binned from the true spacing. Milder
        thinnings do not distinguish the two, and harsher ones fail for lack of
        donors either way — both would pass under sabotage and prove nothing.
        """
        edge, n, step = 0.5, 20, 4
        ax = np.arange(n) * edge
        gx, gy, gz = np.meshgrid(ax, ax, ax, indexing="ij")
        pos = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
        idx = np.rint(pos / edge).astype(int)
        # Thin in ALL THREE axes — thinning only in x/y leaves z-neighbours adjacent,
        # so the nearest-neighbour spacing would not actually grow.
        keep = (idx[:, 0] % step == 0) & (idx[:, 1] % step == 0) & (idx[:, 2] % step == 0)
        pos = pos[keep]
        layers = np.rint(pos[:, 2] / edge).astype(int)

        rng = np.random.default_rng(5)
        truth = _structured_truth(pos)
        obs = truth + rng.normal(0, 0.3, len(pos))
        var = np.full(len(pos), 0.09)
        occ = rng.random(len(pos)) < 0.25

        # Passed the NOMINAL voxel size, far below the real 2.0 m donor spacing.
        fills, method = lad_kriging.fill_occluded(pos, obs, var, occ, layers, edge)
        assert method == "kriging", (
            "a sparse (terrain-style) grid silently degraded to the layer mean")
        assert fills

    def test_falls_back_to_layer_mean_with_too_few_donors(self):
        pos, layers = _grid(n=3, edge=0.5)
        occ = np.zeros(len(pos), dtype=bool)
        occ[:len(pos) - 5] = True          # leave fewer donors than the kriging floor
        obs = np.full(len(pos), 2.0)
        var = np.full(len(pos), 0.1)
        fills, method = lad_kriging.fill_occluded(pos, obs, var, occ, layers, 0.5)
        assert method == "layer_mean"
        assert all(v == pytest.approx(2.0) for v in fills.values())

    def test_homogeneous_field_still_fills_sanely(self):
        """The leafcube case: no structure to exploit. Whatever path is taken, the
        answer must sit at the field's level -- never NaN, never negative."""
        pos, layers, _, _, _, occ, edge = self._case(noise=0.2)
        obs = np.full(len(pos), 2.0)
        var = np.full(len(pos), 0.04)
        fills, method = lad_kriging.fill_occluded(pos, obs, var, occ, layers, edge)
        assert method in ("kriging", "layer_mean")
        assert fills
        for v in fills.values():
            assert np.isfinite(v) and v >= 0.0
            assert v == pytest.approx(2.0, abs=0.2)

    def test_no_donors_fills_nothing(self):
        """Everything occluded => invent nothing."""
        pos, layers = _grid(n=4, edge=0.5)
        occ = np.ones(len(pos), dtype=bool)
        fills, method = lad_kriging.fill_occluded(
            pos, np.full(len(pos), 2.0), np.full(len(pos), 0.1), occ, layers, 0.5)
        assert fills == {} and method == "none"

    def test_no_occluded_voxels_is_a_noop(self):
        pos, layers = _grid(n=4, edge=0.5)
        occ = np.zeros(len(pos), dtype=bool)
        fills, method = lad_kriging.fill_occluded(
            pos, np.full(len(pos), 2.0), np.full(len(pos), 0.1), occ, layers, 0.5)
        assert fills == {} and method == "none"

    def test_never_returns_a_negative_density(self):
        """Kriging is an extrapolator at the edges; LAD is a density and cannot be < 0."""
        rng = np.random.default_rng(3)
        pos, layers = _grid(n=8, edge=0.5)
        # A steep gradient that would extrapolate below zero at one corner.
        obs = np.clip(4.0 - 2.0 * pos[:, 0], 0.01, None) + rng.normal(0, 0.1, len(pos))
        var = np.full(len(pos), 0.01)
        occ = pos[:, 0] > (pos[:, 0].max() - 1e-9)
        fills, _ = lad_kriging.fill_occluded(pos, obs, var, occ, layers, 0.5)
        assert fills
        assert all(v >= 0.0 for v in fills.values())

    def test_donor_cap_is_respected(self, monkeypatch):
        """The O(n^3) guard must actually bound the solve, and still produce a fill."""
        monkeypatch.setattr(lad_kriging, "MAX_DONORS", 50)
        pos, layers, _, obs, var, occ, edge = self._case(n=8)
        fills, method = lad_kriging.fill_occluded(pos, obs, var, occ, layers, edge)
        assert method == "kriging" and fills
