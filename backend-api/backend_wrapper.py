#!/usr/bin/env python3
"""
Wrapper script to ensure backend starts properly
Handles matplotlib font cache building before starting uvicorn
"""

import sys
import os
import logging
import tempfile

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# CRITICAL: Disable matplotlib font manager to avoid 30+ second startup delay
# Use platform-agnostic temp directory (works on Windows, macOS, Linux)
mpl_config_dir = os.path.join(tempfile.gettempdir(), 'matplotlib')
os.makedirs(mpl_config_dir, exist_ok=True)
os.environ['MPLCONFIGDIR'] = mpl_config_dir
os.environ['MPLBACKEND'] = 'Agg'

# Set matplotlib to use minimal configuration
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
matplotlib.rcParams['font.family'] = 'DejaVu Sans'  # Use a single font
matplotlib.rcParams['font.sans-serif'] = ['DejaVu Sans']

# Disable font manager completely
import matplotlib.font_manager as fm
fm._rebuild = lambda: None  # Disable font cache rebuilding

logger.info("Matplotlib initialized with minimal config")

# Now import and run the main app
logger.info("Starting Phytograph backend server...")
from main import app
import uvicorn

if __name__ == "__main__":
    # Port is chosen by whoever spawned us (the Electron supervisor in
    # src/main/backend.ts, or scripts/dev.mjs) and passed via
    # PHYTOGRAPH_BACKEND_PORT so multiple app instances / dev sessions never
    # collide on a fixed port. Falls back to 8008 when launched standalone.
    port = int(os.environ.get("PHYTOGRAPH_BACKEND_PORT", "8008"))
    logger.info(f"Starting server on http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False, log_level="info")