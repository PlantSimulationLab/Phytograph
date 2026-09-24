#!/bin/bash
# Build the ML training cache from the SyntheticLiDAR_Organs corpus.
# Restartable: finished items are skipped, so a re-submit after a timeout or
# failure only redoes the items that were in flight.
#SBATCH --job-name=pg-ml-preprocess
#SBATCH --account=bnbaileygrp        # group GPU nodes; CPU-only here, no --gpus
#SBATCH --partition=gpu-6000_ada-h   # not preemptible; free tier (low) queues for hours
#SBATCH --time=0-06:00:00
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=150G                   # biggest Wan plot needs ~10 GB per worker
#SBATCH --output=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/preprocess-%j.out
#SBATCH --error=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/preprocess-%j.err

set -euo pipefail
REPO=/group/bnbaileygrp/bnbailey/Phytograph
ML_ROOT=/group/bnbaileygrp/bnbailey/phytograph_ml
cd "$REPO/backend-api"
export PYTHONPATH="$REPO/backend-api"
export OMP_NUM_THREADS=1
# Each worker parses one file; more than ~12 saturates NFS reads.
venv/bin/python -u research/ml/preprocess.py --out "$ML_ROOT/cache" \
    --workers $(( SLURM_CPUS_PER_TASK < 12 ? SLURM_CPUS_PER_TASK : 12 ))
