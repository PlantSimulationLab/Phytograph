#!/bin/bash
# Train one benchmark run:  sbatch research/ml/jobs/train.sbatch configs/wl_B_joint.yaml
# Resumable: ml.train continues from <out>/<name>/last.pt, so re-submitting
# the same config after a timeout picks up where it stopped.
#SBATCH --job-name=pg-ml-train
#SBATCH --account=bnbaileygrp
#SBATCH --partition=gpu-6000_ada-h   # RTX 6000 Ada 48 GB; the V100 in bgpu is too old for torch cu13
#SBATCH --gpus=6000_ada:1
#SBATCH --time=1-00:00:00
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=16           # crop building is CPU-side (scipy kNN); 14 loader workers
#SBATCH --mem=96G
#SBATCH --output=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/train-%x-%j.out
#SBATCH --error=/group/bnbaileygrp/bnbailey/phytograph_ml/logs/train-%x-%j.err

set -euo pipefail
CONFIG=${1:?usage: sbatch train.sbatch <config.yaml> [ml.train args...]}
shift
REPO=/group/bnbaileygrp/bnbailey/Phytograph
cd "$REPO/backend-api"
case "$CONFIG" in /*) ;; *) CONFIG="$REPO/backend-api/research/ml/$CONFIG" ;; esac
export PYTHONPATH="$REPO/backend-api"
# Loader workers are single-threaded each; the main process drives the GPU.
export OMP_NUM_THREADS=1
export TORCH_HOME=/group/bnbaileygrp/bnbailey/phytograph_ml/torch_home
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
venv/bin/python -u -m ml.train "$CONFIG" "$@"
