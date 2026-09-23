#!/bin/bash
# Score methods on the held-out splits:
#   sbatch research/ml/jobs/bench.sbatch --sota --gbdt real --gbdt joint --out .../baselines.json
#   sbatch --gpus=6000_ada:1 research/ml/jobs/bench.sbatch --package NAME=path --out ...
# Arguments are passed straight to research/ml/bench.py (--cache is filled in).
#SBATCH --job-name=pg-ml-bench
#SBATCH --account=bnbaileygrp
#SBATCH --partition=gpu-6000_ada-h   # group nodes; add --gpus for --package runs
#SBATCH --time=1-00:00:00
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=200G                   # the Wan larch plot is 51 M cached points
#SBATCH --output=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/bench-%j.out
#SBATCH --error=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/bench-%j.err

set -euo pipefail
REPO=/group/bnbaileygrp/bnbailey/Phytograph
cd "$REPO/backend-api"
# main.py (for --sota) resolves caches from XDG_*, which on this cluster point
# at a full /home; the env script moves them onto /group.
source /group/bnbaileygrp/bnbailey/.local/bin/phytograph-env.sh
export PYTHONPATH="$REPO/backend-api"
export OMP_NUM_THREADS=$SLURM_CPUS_PER_TASK
venv/bin/python -u research/ml/bench.py --cache /group/bnbaileygrp/bnbailey/phytograph_ml/cache "$@"
