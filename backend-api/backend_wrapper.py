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
    # Always run on port 8008 without reload
    logger.info("Starting server on http://127.0.0.1:8008")
    uvicorn.run(app, host="127.0.0.1", port=8008, reload=False, log_level="info")