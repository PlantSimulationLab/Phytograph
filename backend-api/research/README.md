# Research harnesses

Exploratory studies that validate backend behaviour. **Not shipped** — nothing here is
bundled by PyInstaller; these are run by hand from a dev machine. Generated artifacts go
to `out/` (gitignored).

## `leaf_triangulation_separation.py`

Answers: *can a label-free scan statistic predict how cleanly the Helios triangulation can
separate intra-leaf from inter-leaf triangles, and suggest a good `Lmax`?*

### The idea

The Helios triangulation keeps a candidate triangle only if its longest edge ≤ `Lmax`.
Valid triangles connect adjacent points **on one leaf** (short edges ≈ surface point
spacing); erroneous triangles **bridge leaves** (long edges ≈ inter-leaf gaps). When those
two scales separate, almost any `Lmax` in the gap works; when leaves are close relative to
scan resolution, they overlap and no `Lmax` separates them.

We can't see leaf identity in real scans, but we *can* in synthetic ones: each
PlantArchitecture organ is a distinct Helios compound object, so we stamp a unique
`organ_id` on every primitive and sample it onto each hit (`column_format=["organ_id"]`).
That gives ground-truth per-triangle valid/erroneous labels, against which we score
label-free statistics.

Granularity is **per leaflet**, not per compound leaf: a trifoliate leaf (e.g. bean) is
built as three separate leaflet objects, so each leaflet gets its own `organ_id` and a
triangle bridging two leaflets of the same leaf is correctly counted erroneous — the case
that matters most, since leaflets sit closer together than separate leaves. (See the
`label_organs()` docstring for the Helios source backing this.)

`build_labeled_plant(model, age, seed=...)` accepts an optional `seed` for reproducible
builds (the generation is otherwise stochastic).

### Pipeline (per run)

1. Build + label a plant (`build_labeled_plant`).
2. Synthetic-scan it with per-hit organ labels (`scan_plant`).
3. Triangulate the returned points through the **shipping** path
   (`main._do_helios_computation`) with `Lmax = ∞` so all candidate triangles survive
   (`triangulate_candidates`). Vertices map back to organs by nearest hit.
4. Label triangles valid/erroneous; record each one's longest edge.
5. Ground truth: AUC of "longest edge predicts inter-organ" and the label-optimal `Lmax*`.
6. Label-free statistics on the pooled (unlabelled) longest edges:
   - **Otsu** on log-edges → suggested `Lmax`; confidence = separability η.
   - **Two-Gaussian mixture** (1-D EM) → crossover `Lmax`; confidence = 1 − Bhattacharyya overlap.
   - **NN-spacing** baseline → `Lmax = k · median nearest-neighbour spacing`.

### Run

From `backend-api/` with the venv active:

```bash
python research/leaf_triangulation_separation.py            # default sweep
python research/leaf_triangulation_separation.py --quick    # fast subset
python research/leaf_triangulation_separation.py \
    --models cherrytomato,bean,almond --resolutions 200,400,800 --scanners 1,3
python research/leaf_triangulation_separation.py --no-plots  # CSV only
```

Species/ages/scanners/resolutions are all configurable; any bundled model is valid
(`getAvailablePlantModels()`), validated up front so a typo fails fast. The default set
(`cherrytomato`, `tomato`, `bean`, `cowpea`, `almond`) spans hard → easy separation
regimes on purpose.

### Outputs (`out/`)

- `results.csv` — one row per run: ground-truth separability (`gt_auc`, `lmax_optimal`,
  recall/contamination at `Lmax*`) plus each statistic's suggested `Lmax`, confidence,
  and the recall/contamination it actually achieves.
- `hist_<model>_age<a>_sc<n>_res<r>.png` — longest-edge histogram, valid vs erroneous,
  with `Lmax*` / Otsu / GMM thresholds overlaid. Inspect these to *see* whether the two
  scales separate in a given regime.
- `summary_confidence_vs_truth.png` — scatter of each label-free confidence vs the
  ground-truth AUC. **This is the key validation:** a good confidence should rise with
  true separability. The console also prints `Pearson(confidence, GT AUC)` for each.

### Interpreting

- High-resolution / well-spaced canopies (e.g. `almond`) → high `gt_auc`, low contamination
  at `Lmax*`, clearly bimodal histogram.
- Low-resolution / densely-packed broadleaves (e.g. `cherrytomato`) → degraded `gt_auc`,
  unavoidable contamination, overlapping histogram — exactly the case a shipped confidence
  value must flag.
- "Decide empirically": whichever statistic's confidence best tracks `gt_auc` *and* whose
  suggested `Lmax` lands nearest `lmax_optimal` is the one to wire into the product later.

A fast end-to-end check of the machinery (not the science) lives at
`backend-api/tests/test_leaf_separation_harness.py` (`pytest tests/test_leaf_separation_harness.py`).

### Findings (sweep: 5 models × res {200,400,800} × noise {0, 0.5, 1.5 cm}, age 35, 1 scanner; 45 runs)

**Recommendation: ship Otsu separability (η), not the Gaussian mixture.** "Decide
empirically" came out decisively for Otsu on every axis that matters:

| criterion | Otsu | GMM | NN baseline |
|---|---|---|---|
| confidence vs GT separability — Spearman ρ (vs AUC / vs optimal contamination) | **0.64 / −0.66** | 0.33 / −0.35 | n/a |
| suggested `Lmax` vs `Lmax*` — median error factor | **×1.49** (slightly permissive) | ×1.65 | ×1.84 |
| extra contamination vs best achievable — 90th pct | **+8.7%** | +18.7% | −0.3%* |
| max confidence on *hard* runs (GT AUC<0.90, n=12) | **0.70** | 0.76 | n/a |

Why Otsu wins:
- **Monotonic.** Otsu's confidence ranks regimes correctly (Spearman 0.64); GMM's is
  *bistable* — it collapses to ~0.18 or jumps to ~0.8 with little in between (Spearman
  0.33, vs a similar Pearson 0.66 — the gap is the tell). See `summary_confidence_vs_truth.png`.
- **Tracks noise cleanly.** Mean confidence vs range noise {0, 0.5, 1.5 cm}: Otsu
  0.81 → 0.67 → 0.59 (monotone down, matching GT AUC 0.96 → 0.94 → 0.86). GMM:
  0.68 → **0.79** → 0.36 (rises then crashes — wrong).
- **Doesn't bluff.** On the 12 hardest runs Otsu's confidence never exceeds 0.70; GMM
  reports up to 0.76, and its suggested `Lmax` occasionally blows up (10–11 cm) — a
  dangerous over-confident failure for a value users would trust.

Caveats: (\*) the NN baseline's low contamination is misleading — it picks a tight `Lmax`
that also drops real leaf surface (poor recall), so it's not a free win. Even Otsu is only
a *moderate* predictor (ρ≈0.65), and it runs ~1.5× permissive — fine for leaf triangulation
(mild over-shoot keeps real surface at the cost of a little contamination, and the method
is meant to be insensitive within a band) but worth surfacing as "suggested, review."
This sweep fixes age=35 and 1 scanner; re-run with `--ages`/`--scanners` before final
sign-off if multi-view or age strongly change the picture.
