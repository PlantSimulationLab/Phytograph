# phytograph (Python)

A headless scripting API for [Phytograph](https://plantsimulationlab.github.io/Phytograph/).
It needs only `httpx` and `numpy`. The processing itself runs in the backend that the
installed Phytograph app ships with.

```python
import phytograph as pg

with pg.Backend(progress=True) as be:
    cloud = be.open("plot.laz")
    cloud.crop([0, 0, -5], [20, 20, 40])
    cloud.export("plot-cropped.laz")
```

```bash
pip install phytograph
```

The desktop app doesn't need to be installed. On first use the package downloads the
matching processing engine (about 400 MB, verified, cached per user). Run
`python -m phytograph download` to fetch it ahead of time. If a Phytograph app of the
same version is installed, its engine is used instead. See
[Scripting with Python](https://plantsimulationlab.github.io/Phytograph/guide/scripting/) for
the user guide, and `docs/docs/developers/architecture/scripting-client.md` for how it works.

Run the tests with `npm run test:python` from the repo root. They launch a real backend.
