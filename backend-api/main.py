from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from pydantic import BaseModel
import pandas as pd
import numpy as np
import io
import json
from typing import Optional, List, Dict, Any
from scipy.optimize import curve_fit, minimize
import re
import math
import os
import sys
import subprocess
from pathlib import Path
from pytexit import py2tex

# ==================== PyHelios source submodule ====================
#
# PyHelios is vendored as a git submodule at <repo>/pyhelios (with its nested
# helios-core C++ submodule) so we can co-develop it. The native library
# (libhelios) is compiled from source by scripts/build-pyhelios.mjs and lives at
# pyhelios/pyhelios_build/build/lib/. There is no pip wheel fallback.
#
# This block runs at import time, before any endpoint lazily imports pyhelios:
#   1. put the submodule on sys.path so `import pyhelios` resolves to the source;
#   2. auto-rebuild the native library if it's missing or stale (a C++/header
#      file under helios-core/ or native/ is newer than the compiled lib).
# In packaged (PyInstaller) builds the submodule and build script aren't present;
# pyhelios is bundled via collect-all instead, so we skip the whole block.
_PYHELIOS_SRC = Path(__file__).resolve().parent.parent / "pyhelios"

if (_PYHELIOS_SRC / "pyhelios" / "__init__.py").exists():
    if str(_PYHELIOS_SRC) not in sys.path:
        sys.path.insert(0, str(_PYHELIOS_SRC))

    if sys.platform == "darwin":
        _lib_name = "libhelios.dylib"
    elif sys.platform == "win32":
        _lib_name = "libhelios.dll"
    else:
        _lib_name = "libhelios.so"
    _lib_path = _PYHELIOS_SRC / "pyhelios_build" / "build" / "lib" / _lib_name

    _needs_build = False
    if not _lib_path.exists():
        print(f"[pyhelios] native library not found at {_lib_path}", flush=True)
        _needs_build = True
    else:
        _lib_mtime = _lib_path.stat().st_mtime
        _newest_source = 0.0
        for _src_dir in (_PYHELIOS_SRC / "helios-core", _PYHELIOS_SRC / "native"):
            if _src_dir.exists():
                for _pattern in ("*.cpp", "*.hpp", "*.h"):
                    for _f in _src_dir.rglob(_pattern):
                        _newest_source = max(_newest_source, _f.stat().st_mtime)
        if _newest_source > _lib_mtime:
            print("[pyhelios] native library is stale (C++ sources are newer); rebuilding", flush=True)
            _needs_build = True

    if _needs_build:
        _build_script = _PYHELIOS_SRC.parent / "scripts" / "build-pyhelios.mjs"
        if _build_script.exists():
            print("[pyhelios] building from source (this may take a few minutes)...", flush=True)
            _result = subprocess.run(["node", str(_build_script)], cwd=str(_build_script.parent.parent), timeout=1800)
            if _result.returncode == 0 and _lib_path.exists():
                print("[pyhelios] build complete", flush=True)
            else:
                print("[pyhelios] WARNING: build failed; PyHelios features may be unavailable", flush=True)
        else:
            print(f"[pyhelios] WARNING: build script not found at {_build_script}", flush=True)

    # Eagerly load libhelios NOW, at module import, before any endpoint imports
    # open3d. libhelios links the Homebrew OpenMP runtime; open3d (and torch /
    # sklearn) ship their own libomp.dylib, and on macOS whichever loads first
    # wins the two-level-namespace binding. If open3d loads first, libhelios
    # binds to open3d's libomp and dies on a missing symbol
    # (e.g. ___kmpc_dispatch_deinit). Importing pyhelios here makes libhelios +
    # its correct libomp bind first, so subsequent open3d use is harmless.
    # Best-effort: a failure here is non-fatal (the lazy per-endpoint imports
    # still surface a clear error), so packaged builds / odd setups don't break.
    try:
        import pyhelios as _pyhelios_preload  # noqa: F401
        print("[pyhelios] native library loaded at startup", flush=True)
    except Exception as _e:  # noqa: BLE001
        print(f"[pyhelios] WARNING: startup load failed ({_e}); "
              "will retry lazily per request", flush=True)

# Unicode subscript to ASCII conversion for phytorch compatibility
SUBSCRIPT_TO_ASCII = {
    '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
    '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
}

def unicode_to_ascii(s: str) -> str:
    """Convert unicode subscripts to ASCII numbers for phytorch compatibility."""
    result = s
    for subscript, ascii_char in SUBSCRIPT_TO_ASCII.items():
        result = result.replace(subscript, ascii_char)
    return result

# Vendored libraries live under backend-api/vendor/. Put it on sys.path so
# `from treeiso.treeiso_core import ...` resolves in dev and in the PyInstaller
# bundle (where vendor/ travels with main.py via build-backend.mjs).
_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

# Backend version - bump this when making backend changes that require restart
BACKEND_VERSION = "0.6.1"

app = FastAPI(title="Phytograph API", version="0.1.0")

# Configure CORS for Tauri
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "http://localhost:1427",
        "http://localhost:3000",
        "http://localhost:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"message": "Phytograph API is running", "version": BACKEND_VERSION}


@app.get("/health")
def health_check():
    """Health check endpoint for backend status"""
    return {"status": "healthy", "service": "Phytograph Backend", "version": BACKEND_VERSION}


@app.get("/version")
def get_version():
    """Version endpoint for Tauri app to check backend compatibility"""
    return {"version": BACKEND_VERSION}


# Model mapping
def get_model(category: str, model_type: str):
    """Get the appropriate phytorch model based on category and type"""
    from phytorch.models.stomatal import MED2011, BWB1987, BBL1995
    from phytorch.models.hydraulics import Sigmoidal, SJB2018
    from phytorch.models.generic import Linear, RectangularHyperbola, NonrectangularHyperbola

    models = {
        "stomatal": {
            "med2011": MED2011,
            "bwb1987": BWB1987,
            "bbl1995": BBL1995,
        },
        "hydraulics": {
            "sigmoidal": Sigmoidal,
            "sjb2018": SJB2018,
        },
        "generic": {
            "linear": Linear,
            "rectangular_hyperbola": RectangularHyperbola,
            "nonrectangular_hyperbola": NonrectangularHyperbola,
        }
    }

    if category not in models:
        raise ValueError(f"Unknown category: {category}")
    if model_type not in models[category]:
        raise ValueError(f"Unknown model type: {model_type}")

    return models[category][model_type]()


@app.post("/api/fit")
async def fit_model(
    file: UploadFile = File(...),
    model_category: str = Form(...),
    model_type: str = Form(...),
    method: Optional[str] = Form("auto"),
    max_iterations: Optional[int] = Form(1000)
):
    """
    Fit a phytorch model to uploaded data.
    """
    try:
        # Read the uploaded file
        contents = await file.read()

        # Parse CSV
        if file.filename.endswith('.csv') or file.filename.endswith('.txt'):
            df = pd.read_csv(io.StringIO(contents.decode('utf-8')))
        elif file.filename.endswith('.xlsx'):
            df = pd.read_excel(io.BytesIO(contents))
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format")

        # Convert to dict of numpy arrays
        data = {col: df[col].values for col in df.columns}

        # Get the model
        model = get_model(model_category, model_type)

        # Fit options
        options = {
            "method": method if method else "auto",
            "max_iterations": max_iterations,
            "verbose": False
        }

        # Import and run fit
        from phytorch import fit
        result = fit(model, data, options)

        # Format response
        response = {
            "success": True,
            "parameters": {k: float(v) if isinstance(v, (np.floating, float)) else v
                         for k, v in result.parameters.items()},
            "r_squared": float(result.r_squared) if hasattr(result, 'r_squared') else None,
            "loss": float(result.loss) if hasattr(result, 'loss') else None,
            "converged": bool(result.converged) if hasattr(result, 'converged') else True,
        }

        return response

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/models")
def list_models():
    """List available models and their required data fields"""
    return {
        "photosynthesis": {
            "fvcb": {
                "name": "FvCB",
                "required_data": ["A", "Ci", "Qin", "Tleaf"],
                "optional_data": ["CurveID"]
            }
        },
        "stomatal": {
            "med2011": {
                "name": "Medlyn 2011",
                "required_data": ["A", "VPD", "gs"],
                "optional_data": ["Ca", "Gamma"]
            },
            "bwb1987": {
                "name": "Ball-Woodrow-Berry",
                "required_data": ["A", "hs", "gs"],
                "optional_data": ["Ca"]
            },
            "bbl1995": {
                "name": "Ball-Berry-Leuning",
                "required_data": ["A", "VPD", "gs"],
                "optional_data": ["Ca", "Gamma", "D0"]
            }
        },
        "hydraulics": {
            "sigmoidal": {
                "name": "Vulnerability Curve",
                "required_data": ["psi", "K"]
            },
            "sjb2018": {
                "name": "P-V Curve",
                "required_data": ["w", "psi"]
            }
        },
        "generic": {
            "linear": {
                "name": "Linear",
                "required_data": ["x", "y"]
            },
            "rectangular_hyperbola": {
                "name": "Rectangular Hyperbola",
                "required_data": ["x", "y"]
            },
            "nonrectangular_hyperbola": {
                "name": "Non-rectangular Hyperbola",
                "required_data": ["x", "y"]
            }
        }
    }


# ==================== CUSTOM FIT ENDPOINT ====================

class ParameterDef(BaseModel):
    name: str
    symbol: str
    default: float
    boundsLow: float
    boundsHigh: float
    fixed: bool = False  # If True, use fixedValue instead of fitting
    fixedValue: Optional[float] = None  # Value to use when fixed


class ConstantDef(BaseModel):
    name: str
    symbol: str
    value: float


class InputDef(BaseModel):
    name: str
    symbol: str


class OutputDef(BaseModel):
    name: str
    symbol: str


class FitRequest(BaseModel):
    model_type: str  # 'builtin' or 'user'
    model_id: Optional[str] = None  # For built-in models
    equation: Optional[str] = None  # For user models
    equation_type: str = 'explicit'  # 'explicit' or 'implicit'
    parameters: List[ParameterDef]
    constants: Optional[List[ConstantDef]] = None
    inputs: List[InputDef]
    outputs: List[OutputDef]
    column_mappings: Dict[str, str]  # variable_key -> column_name
    data: Dict[str, List[float]]  # column_name -> values
    max_iterations: int = 1000


def sanitize_equation(equation: str) -> str:
    """Clean up equation for Python evaluation"""
    # Replace common mathematical notation with Python equivalents
    eq = equation

    # Handle Unicode symbols - map to ASCII parameter names
    # This will be handled by replacing symbols with their parameter names

    # Replace common math functions
    eq = re.sub(r'\bsqrt\b', 'np.sqrt', eq)
    eq = re.sub(r'\bexp\b', 'np.exp', eq)
    eq = re.sub(r'\blog\b', 'np.log', eq)
    eq = re.sub(r'\blog10\b', 'np.log10', eq)
    eq = re.sub(r'\bsin\b', 'np.sin', eq)
    eq = re.sub(r'\bcos\b', 'np.cos', eq)
    eq = re.sub(r'\btan\b', 'np.tan', eq)
    eq = re.sub(r'\babs\b', 'np.abs', eq)
    eq = re.sub(r'\bmin\b', 'np.minimum', eq)
    eq = re.sub(r'\bmax\b', 'np.maximum', eq)

    # Handle √ symbol - √X becomes np.sqrt(X) where X is a word or parenthesized expression
    # First handle √(expr) -> np.sqrt(expr)
    eq = re.sub(r'√\(([^)]+)\)', r'np.sqrt(\1)', eq)
    # Then handle √word -> np.sqrt(word)
    eq = re.sub(r'√(\w+)', r'np.sqrt(\1)', eq)

    # Handle × and ÷
    eq = eq.replace('×', '*')
    eq = eq.replace('÷', '/')

    # Handle ** for exponentiation (already Python compatible)
    # Handle ^ for exponentiation
    eq = eq.replace('^', '**')

    return eq


def create_model_function(equation: str, param_names: List[str], input_symbols: List[str],
                         constants: Dict[str, float], symbol_to_name: Dict[str, str]) -> callable:
    """Create a callable function from an equation string"""

    # Sanitize the equation
    eq = sanitize_equation(equation)

    # Replace symbols with parameter/input names that are valid Python identifiers
    # First replace constants
    for symbol, value in constants.items():
        eq = re.sub(rf'\b{re.escape(symbol)}\b', str(value), eq)

    # Replace symbols with their variable names
    for symbol, name in symbol_to_name.items():
        eq = re.sub(rf'\b{re.escape(symbol)}\b', name, eq)

    # Build the function
    def model_func(x_data: Dict[str, np.ndarray], *params):
        # Create local namespace with numpy functions
        local_ns = {
            'np': np,
            'sqrt': np.sqrt,
            'exp': np.exp,
            'log': np.log,
            'log10': np.log10,
            'sin': np.sin,
            'cos': np.cos,
            'tan': np.tan,
            'abs': np.abs,
            'min': np.minimum,
            'max': np.maximum,
            'pi': np.pi,
            'e': np.e,
        }

        # Add input data
        for inp_symbol, inp_data in x_data.items():
            local_ns[inp_symbol] = inp_data

        # Add parameters
        for name, value in zip(param_names, params):
            local_ns[name] = value

        # Add constants
        for symbol, value in constants.items():
            local_ns[symbol] = value

        try:
            result = eval(eq, {"__builtins__": {}, "np": np}, local_ns)
            return np.array(result, dtype=float)
        except Exception as e:
            raise ValueError(f"Error evaluating equation '{eq}': {str(e)}")

    return model_func


@app.post("/api/fit/custom")
async def fit_custom_model(request: FitRequest):
    """
    Fit a custom or built-in model to data.
    """
    try:
        # Extract data arrays
        data = {k: np.array(v) for k, v in request.data.items()}

        # Get input data based on column mappings
        input_data = {}
        for inp in request.inputs:
            key = f"input_{inp.symbol}"
            col_name = request.column_mappings.get(key)
            if not col_name or col_name not in data:
                raise HTTPException(status_code=400, detail=f"Missing data for input '{inp.name}'")
            input_data[inp.symbol] = data[col_name]

        # Get output data (y values)
        y_data = None
        output_symbol = None
        for out in request.outputs:
            key = f"output_{out.symbol}"
            col_name = request.column_mappings.get(key)
            if col_name and col_name in data:
                y_data = data[col_name]
                output_symbol = out.symbol
                break

        if y_data is None:
            raise HTTPException(status_code=400, detail="Missing output data column")

        # Build constants dict
        constants = {}
        if request.constants:
            for const in request.constants:
                constants[const.symbol] = const.value

        # Build symbol to name mapping
        symbol_to_name = {}
        for inp in request.inputs:
            symbol_to_name[inp.symbol] = inp.symbol  # Keep symbol as is for eval
        for param in request.parameters:
            symbol_to_name[param.symbol] = param.name

        # Get equation - handle built-in models
        equation = request.equation
        if request.model_type == 'builtin' and request.model_id:
            # For built-in models, we use the phytorch models directly if available
            # Otherwise fall back to equation fitting
            try:
                model = get_model_builtin(request.model_id)
                if model:
                    # Use phytorch fitting for built-in models
                    from phytorch import fit as phytorch_fit

                    # Map data to expected format
                    fit_data = {}
                    for inp in request.inputs:
                        key = f"input_{inp.symbol}"
                        col_name = request.column_mappings.get(key)
                        if col_name and col_name in data:
                            fit_data[inp.name] = data[col_name]

                    for out in request.outputs:
                        key = f"output_{out.symbol}"
                        col_name = request.column_mappings.get(key)
                        if col_name and col_name in data:
                            fit_data[out.name] = data[col_name]

                    # Build initial guess and bounds from request parameters
                    # Convert unicode subscripts to ASCII (gs₀ -> gs0) for phytorch compatibility
                    initial_guess = {}
                    bounds = {}
                    for param in request.parameters:
                        ascii_symbol = unicode_to_ascii(param.symbol)
                        # Handle fixed parameters by setting bounds to (value, value)
                        if param.fixed:
                            fixed_value = param.fixedValue if param.fixedValue is not None else param.default
                            initial_guess[ascii_symbol] = fixed_value
                            bounds[ascii_symbol] = (fixed_value, fixed_value)
                        else:
                            initial_guess[ascii_symbol] = param.default
                            low = param.boundsLow if np.isfinite(param.boundsLow) else None
                            high = param.boundsHigh if np.isfinite(param.boundsHigh) else None
                            if low is not None or high is not None:
                                bounds[ascii_symbol] = (low, high)

                    result = phytorch_fit(model, fit_data, {
                        "method": "auto",
                        "max_iterations": request.max_iterations,
                        "initial_guess": initial_guess,
                        "bounds": bounds if bounds else None,
                        "verbose": False
                    })

                    # Get n_points and y_data from the first output column
                    n_points = 0
                    y_data_measured = None
                    for out in request.outputs:
                        key = f"output_{out.symbol}"
                        col_name = request.column_mappings.get(key)
                        if col_name and col_name in data:
                            y_data_measured = np.array(data[col_name])
                            n_points = len(y_data_measured)
                            break

                    # Calculate fitted values using model.forward(data, parameters)
                    fitted_values = None
                    residuals = None

                    if hasattr(model, 'forward') and y_data_measured is not None:
                        try:
                            # Phytorch forward() requires both data and parameters
                            y_fitted_tensor = model.forward(fit_data, result.parameters)
                            # Convert tensor to numpy/list
                            if hasattr(y_fitted_tensor, 'detach'):
                                fitted_values = y_fitted_tensor.detach().numpy().flatten().tolist()
                            elif hasattr(y_fitted_tensor, 'tolist'):
                                fitted_values = y_fitted_tensor.tolist()
                            else:
                                fitted_values = list(y_fitted_tensor)
                            residuals = (y_data_measured - np.array(fitted_values)).tolist()
                        except Exception:
                            pass  # fitted_values will remain None if forward fails

                    return {
                        "success": True,
                        "parameters": {k: float(v) if isinstance(v, (np.floating, float)) else v
                                     for k, v in result.parameters.items()},
                        "r_squared": float(result.r_squared) if hasattr(result, 'r_squared') else None,
                        "rmse": float(np.sqrt(result.loss)) if hasattr(result, 'loss') else None,
                        "n_points": n_points,
                        "converged": bool(result.converged) if hasattr(result, 'converged') else True,
                        "fitted_values": fitted_values,
                        "residuals": residuals,
                    }
            except Exception as e:
                # Fall back to equation-based fitting
                print(f"Falling back to equation fitting: {e}")
                pass

        if not equation:
            raise HTTPException(status_code=400, detail="No equation provided")

        # Create model function
        param_names = [p.name for p in request.parameters]
        input_symbols = [inp.symbol for inp in request.inputs]
        model_func = create_model_function(equation, param_names, input_symbols, constants, symbol_to_name)

        # Separate fixed and free parameters
        all_params = request.parameters
        free_params = [p for p in all_params if not p.fixed]
        fixed_params = [p for p in all_params if p.fixed]

        # Build mapping of parameter index to fixed value
        fixed_values = {}
        for i, p in enumerate(all_params):
            if p.fixed:
                fixed_values[i] = p.fixedValue if p.fixedValue is not None else p.default

        # Initial parameter values and bounds (only for free parameters)
        p0 = [p.default for p in free_params]
        bounds_low = [p.boundsLow if np.isfinite(p.boundsLow) else -1e10 for p in free_params]
        bounds_high = [p.boundsHigh if np.isfinite(p.boundsHigh) else 1e10 for p in free_params]

        # Wrapper for curve_fit that injects fixed parameter values
        def fit_wrapper(*args):
            # args[0] is dummy x, rest are free params only
            free_param_values = args[1:]

            # Build full parameter list with fixed values injected
            full_params = []
            free_idx = 0
            for i in range(len(all_params)):
                if i in fixed_values:
                    full_params.append(fixed_values[i])
                else:
                    full_params.append(free_param_values[free_idx])
                    free_idx += 1

            return model_func(input_data, *full_params)

        # Use dummy x array for curve_fit interface
        x_dummy = np.arange(len(y_data))

        try:
            # Check if there are any free parameters to fit
            if len(free_params) == 0:
                # All parameters are fixed, just evaluate the model
                full_params = [fixed_values[i] for i in range(len(all_params))]
                y_fitted = model_func(input_data, *full_params)
                popt_free = []
                pcov = np.array([])
            else:
                # Try curve_fit with free parameters
                popt_free, pcov = curve_fit(
                    fit_wrapper,
                    x_dummy,
                    y_data,
                    p0=p0,
                    bounds=(bounds_low, bounds_high),
                    maxfev=request.max_iterations * 10
                )

                # Build full parameter values for fitted calculation
                full_popt = []
                free_idx = 0
                for i in range(len(all_params)):
                    if i in fixed_values:
                        full_popt.append(fixed_values[i])
                    else:
                        full_popt.append(popt_free[free_idx])
                        free_idx += 1

                # Calculate fitted values and statistics
                y_fitted = model_func(input_data, *full_popt)

            # R-squared
            ss_res = np.sum((y_data - y_fitted) ** 2)
            ss_tot = np.sum((y_data - np.mean(y_data)) ** 2)
            r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

            # RMSE
            rmse = np.sqrt(np.mean((y_data - y_fitted) ** 2))

            # Standard errors from covariance matrix (only for free params)
            try:
                std_errors_free = np.sqrt(np.diag(pcov)) if pcov.size > 0 else []
            except:
                std_errors_free = [None] * len(popt_free)

            # Build result - include both fixed and fitted parameters
            param_results = {}
            free_idx = 0
            for i, p in enumerate(all_params):
                if p.fixed:
                    param_results[p.name] = {
                        "value": float(fixed_values[i]),
                        "std_error": None,  # No error for fixed params
                        "symbol": p.symbol,
                        "fixed": True,
                    }
                else:
                    std_err = std_errors_free[free_idx] if free_idx < len(std_errors_free) else None
                    param_results[p.name] = {
                        "value": float(popt_free[free_idx]),
                        "std_error": float(std_err) if std_err is not None and np.isfinite(std_err) else None,
                        "symbol": p.symbol,
                        "fixed": False,
                    }
                    free_idx += 1

            return {
                "success": True,
                "parameters": param_results,
                "r_squared": float(r_squared),
                "rmse": float(rmse),
                "n_points": int(len(y_data)),
                "converged": True,
                "fitted_values": y_fitted.tolist(),
                "residuals": (y_data - y_fitted).tolist(),
            }

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Fitting failed: {str(e)}")

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def get_model_builtin(model_id: str):
    """Get a built-in phytorch model instance"""
    try:
        from phytorch.models.stomatal import MED2011, BWB1987, BBL1995
        from phytorch.models.hydraulics import Sigmoidal, SJB2018
        from phytorch.models.generic import Linear, RectangularHyperbola, NonrectangularHyperbola

        models = {
            "med2011": MED2011,
            "bwb1987": BWB1987,
            "bbl1995": BBL1995,
            "sigmoidal": Sigmoidal,
            "vulnerability": Sigmoidal,
            "sjb2018": SJB2018,
            "pvcurve": SJB2018,
            "linear": Linear,
            "rectangular_hyperbola": RectangularHyperbola,
            "nonrectangular_hyperbola": NonrectangularHyperbola,
        }

        if model_id in models:
            return models[model_id]()
        return None
    except ImportError:
        return None


# ==================== LATEX CONVERSION ====================

class LatexRequest(BaseModel):
    equation: str
    output_symbol: Optional[str] = "y"
    equation_type: str = "explicit"  # 'explicit' or 'implicit'


def convert_symbol_to_latex(symbol: str) -> str:
    """
    Convert a symbol name to LaTeX, handling Greek letters and subscripts.
    """
    # Convert the symbol through pytexit to handle Greek letters and subscripts
    try:
        latex_result = py2tex(symbol, print_latex=False, print_formula=False)
        return latex_result.strip('$')
    except:
        return symbol


def python_to_latex(equation: str, output_symbol: str = "y", equation_type: str = "explicit") -> str:
    """
    Convert a Python/numpy equation string to LaTeX using pytexit.
    Preserves the original term order.
    """
    try:
        # Clean up the equation
        eq = equation.strip()

        # Only process the first line (before any 'where:' documentation)
        if '\n' in eq:
            eq = eq.split('\n')[0].strip()

        # Replace numpy prefixes
        eq = eq.replace('np.', '')

        # Convert using pytexit - preserves order
        latex_result = py2tex(eq, print_latex=False, print_formula=False)

        # py2tex returns $$...$$ wrapped, strip that
        latex_expr = latex_result.strip('$')

        # Post-process to handle lambda workarounds (since 'lambda' is a Python keyword)
        # Replace 'lam' with '\lambda' for wavelength notation
        import re
        latex_expr = re.sub(r'\blam\b', r'\\lambda', latex_expr)
        latex_expr = re.sub(r'\blambd\b', r'\\lambda', latex_expr)

        # Convert output symbol (handles Greek letters like psi -> \psi)
        latex_output = convert_symbol_to_latex(output_symbol)

        # Build full equation with output symbol
        if equation_type == "implicit":
            latex_full = f"0 = {latex_expr}"
        else:
            latex_full = f"{latex_output} = {latex_expr}"

        return latex_full

    except Exception as e:
        # Fallback: return a simple text-based representation
        print(f"LaTeX conversion error: {e}")
        prefix = "0" if equation_type == "implicit" else output_symbol
        return f"{prefix} = \\text{{{equation}}}"


@app.post("/api/latex")
async def convert_to_latex(request: LatexRequest):
    """
    Convert a Python equation to LaTeX format.
    """
    try:
        latex = python_to_latex(
            request.equation,
            request.output_symbol,
            request.equation_type
        )
        return {"success": True, "latex": latex}
    except Exception as e:
        return {"success": False, "latex": f"{request.output_symbol} = \\text{{{request.equation}}}", "error": str(e)}


@app.get("/api/latex")
async def convert_to_latex_get(equation: str, output_symbol: str = "y", equation_type: str = "explicit"):
    """
    Convert a Python equation to LaTeX format (GET version for easy testing).
    """
    try:
        latex = python_to_latex(equation, output_symbol, equation_type)
        return {"success": True, "latex": latex}
    except Exception as e:
        return {"success": False, "latex": f"{output_symbol} = \\text{{{equation}}}", "error": str(e)}


# ==================== EXCEL EXPORT ====================

class ExportParameter(BaseModel):
    name: str
    symbol: str
    value: float
    std_error: Optional[float] = None
    fixed: bool = False
    units: Optional[str] = None
    description: Optional[str] = None

class ExportRequest(BaseModel):
    model_name: str
    model_type: Optional[str] = None
    equation: Optional[str] = None
    parameters: Dict[str, Any]
    r_squared: Optional[float] = None
    rmse: Optional[float] = None
    n_points: Optional[int] = None
    fitted_values: Optional[List[float]] = None
    residuals: Optional[List[float]] = None
    input_data: Optional[Dict[str, List[float]]] = None
    y_measured: Optional[List[float]] = None
    y_column_name: Optional[str] = None
    file_name: Optional[str] = None
    max_iterations: Optional[int] = None
    model_tags: Optional[List[str]] = None


@app.post("/api/export")
async def export_fit_results(request: ExportRequest):
    """
    Export fit results to an Excel file with Parameters, Data, and Metadata sheets.
    """
    try:
        from openpyxl import Workbook
        from openpyxl.utils.dataframe import dataframe_to_rows

        wb = Workbook()

        # ==================== PARAMETERS SHEET ====================
        ws_params = wb.active
        ws_params.title = "Parameters"
        ws_params.append(["Parameter", "Value", "Std Error", "Status", "Symbol", "Units", "Description"])

        for param_name, param_data in request.parameters.items():
            if isinstance(param_data, dict):
                value = param_data.get("value", 0)
                std_error = param_data.get("std_error")
                fixed = param_data.get("fixed", False)
                symbol = param_data.get("symbol", param_name)
                units = param_data.get("units", "")
                description = param_data.get("description", "")
            else:
                value = param_data
                std_error = None
                fixed = False
                symbol = param_name
                units = ""
                description = ""

            status = "Fixed" if fixed else "Fitted"
            ws_params.append([param_name, value, std_error, status, symbol, units, description])

        # ==================== DATA SHEET ====================
        ws_data = wb.create_sheet("Data")

        # Build data columns
        data_columns = []
        data_values = []

        # Add input variables
        if request.input_data:
            for col_name, values in request.input_data.items():
                data_columns.append(col_name)
                data_values.append(values)

        # Add measured y values (use provided column name or default)
        if request.y_measured:
            y_col_name = request.y_column_name or "Y"
            data_columns.append(f"{y_col_name}_measured")
            data_values.append(request.y_measured)

        # Add modeled/fitted values
        if request.fitted_values:
            y_col_name = request.y_column_name or "Y"
            data_columns.append(f"{y_col_name}_modeled")
            data_values.append(request.fitted_values)

        # Add residuals
        if request.residuals:
            data_columns.append("Residual")
            data_values.append(request.residuals)

        # Write header
        ws_data.append(data_columns)

        # Write data rows
        if data_values:
            n_rows = len(data_values[0]) if data_values else 0
            for i in range(n_rows):
                row = [vals[i] if i < len(vals) else None for vals in data_values]
                ws_data.append(row)

        # ==================== METADATA SHEET ====================
        ws_meta = wb.create_sheet("Metadata")

        # Header
        ws_meta.append(["Phytograph Model Fit Results"])
        ws_meta.append([])

        # Data source section
        ws_meta.append(["DATA SOURCE"])
        ws_meta.append(["Model Name", request.model_name])
        ws_meta.append(["Model Type", request.model_type or "Custom"])
        ws_meta.append(["Source File", request.file_name or "Not specified"])
        ws_meta.append(["Fit DateTime", datetime.now().isoformat()])
        if request.model_tags:
            ws_meta.append(["Tags", ", ".join(request.model_tags)])
        ws_meta.append([])

        # Equation section
        if request.equation:
            ws_meta.append(["EQUATION"])
            ws_meta.append(["Equation", request.equation])
            ws_meta.append([])

        # Fit options section
        ws_meta.append(["FIT OPTIONS"])
        ws_meta.append(["Max Iterations", request.max_iterations or "Default"])
        ws_meta.append([])

        # Error metrics section
        ws_meta.append(["ERROR METRICS"])
        ws_meta.append(["R²", request.r_squared])
        ws_meta.append(["RMSE", request.rmse])
        ws_meta.append(["N Points", request.n_points])

        # Save to bytes
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)

        # Generate filename
        safe_model_name = re.sub(r'[^\w\-]', '_', request.model_name)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{safe_model_name}_FitResults_{timestamp}.xlsx"

        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


# ==================== PROSPECT-D SPECTRAL MODEL ====================

class ProspectFitRequest(BaseModel):
    """Request model for PROSPECT-D spectral fitting"""
    wavelengths: List[float]  # Wavelength values (nm)
    reflectance: List[float]  # Reflectance values (0-1)
    # Fitting options
    vis_weight: float = 6.0  # Weight for visible band
    n_starts: int = 6  # Number of multi-start attempts
    loss: str = "soft_l1"  # Loss function: linear, soft_l1, huber, cauchy, arctan
    f_scale: float = 0.08  # Scale for robust loss
    do_calib: bool = True  # Include affine calibration (a, b)
    stage1: bool = True  # Two-stage fitting (VIS first)
    # Gaussian window parameters
    green_center: float = 550.0
    rededge_center: float = 705.0
    violet_center: float = 410.0
    window_sigma: float = 20.0
    feature_boost: float = 2.0
    violet_boost: float = 2.0
    vis_min: float = 380.0
    vis_max: float = 750.0


def build_prosail_forward():
    """Build the PROSPECT-D forward model using prosail library"""
    try:
        import prosail
    except ImportError:
        raise RuntimeError("prosail library not installed. Run: pip install prosail")

    def call_forward(N, Cab, Car, Cbrown, Cw, Cm, Ant):
        """Call prosail PROSPECT-D forward model"""
        # prosail.run_prospect uses lowercase parameter names
        f = getattr(prosail, "run_prospect", None)
        if callable(f):
            # Primary call with correct lowercase parameters for prosail library
            return f(n=N, cab=Cab, car=Car, cbrown=Cbrown, cw=Cw, cm=Cm, ant=Ant, prospect_version="D")

        # Fallback: try alternative function names
        for fname in ["prospect_D", "prospect_d"]:
            f = getattr(prosail, fname, None)
            if callable(f):
                try:
                    return f(n=N, cab=Cab, car=Car, cbrown=Cbrown, cw=Cw, cm=Cm, ant=Ant)
                except TypeError:
                    return f(N=N, Cab=Cab, Car=Car, Cbrown=Cbrown, Cw=Cw, Cm=Cm, Ant=Ant)

        raise RuntimeError("No PROSPECT-D forward function found in prosail installation.")

    def normalize_output(out):
        """Normalize prosail output to (wavelength, reflectance) arrays"""
        wl = None
        R = None

        if isinstance(out, dict):
            for k in ["R", "refl", "reflectance"]:
                if k in out:
                    R = np.asarray(out[k], dtype=float)
                    break
            for k in ["wl", "wavelengths", "lambda", "lam"]:
                if k in out:
                    wl = np.asarray(out[k], dtype=float)
                    break
        elif hasattr(out, "__len__") and not isinstance(out, (bytes, str)):
            out_list = list(out)
            if len(out_list) == 1 and hasattr(out_list[0], "__len__"):
                R = np.asarray(out_list[0], dtype=float)
            else:
                # Try to identify wavelength array (monotonic, in nm range)
                for item in out_list:
                    arr = np.asarray(item, dtype=float)
                    if arr.ndim == 1 and arr.size > 10 and np.all(np.diff(arr) > 0) and 300 <= arr.min() <= 3000:
                        wl = arr
                        break
                # Take first non-wavelength array as reflectance
                for item in out_list:
                    arr = np.asarray(item, dtype=float)
                    if arr.ndim == 1 and arr.size > 10 and not (wl is not None and np.array_equal(arr, wl)):
                        R = arr
                        break
                if R is None and len(out_list) >= 1:
                    R = np.asarray(out_list[0], dtype=float)
        else:
            R = np.asarray(out, dtype=float)

        if R is None:
            raise RuntimeError("Could not identify reflectance array from prosail output.")
        if wl is None:
            wl = np.arange(400.0, 2501.0, 1.0)

        return wl, R

    def forward_reflectance(params):
        """Run forward model and return (wavelength, reflectance)"""
        N, Cab, Car, Cbrown, Cw, Cm, Ant = params[:7].tolist()
        out = call_forward(N, Cab, Car, Cbrown, Cw, Cm, Ant)
        return normalize_output(out)

    return forward_reflectance


def resample_spectrum(meas_wl: np.ndarray, meas_R: np.ndarray, model_wl: np.ndarray):
    """Resample measured spectrum to model wavelengths"""
    wl_min = max(np.min(meas_wl), np.min(model_wl))
    wl_max = min(np.max(meas_wl), np.max(model_wl))
    mask = (model_wl >= wl_min) & (model_wl <= wl_max)
    wl_common = model_wl[mask]
    R_interp = np.interp(wl_common, meas_wl, meas_R)
    return wl_common, R_interp


def fit_prospect_d(
    wavelengths: np.ndarray,
    reflectance: np.ndarray,
    vis_weight: float = 6.0,
    loss: str = "soft_l1",
    f_scale: float = 0.08,
    n_starts: int = 6,
    stage1: bool = True,
    do_calib: bool = True,
    green_center: float = 550.0,
    rededge_center: float = 705.0,
    window_sigma: float = 20.0,
    feature_boost: float = 2.0,
    vis_min: float = 380.0,
    vis_max: float = 750.0,
    violet_center: float = 410.0,
    violet_boost: float = 2.0,
    rng_seed: int = 42
) -> Dict[str, Any]:
    """
    Fit PROSPECT-D model to spectral reflectance data.

    Returns dict with:
        - success: bool
        - parameters: dict of fitted parameter values
        - rmse: float
        - r_squared: float
        - fitted_spectrum: list of fitted reflectance values
        - wavelengths: list of wavelengths for fitted spectrum
    """
    from scipy.optimize import least_squares

    forward = build_prosail_forward()

    # Parameter setup: 7 biophysical + optional 2 calibration
    names = ["N", "Cab", "Car", "Cbrown", "Cw", "Cm", "Ant"]
    lb = np.array([1.0, 0.0, 0.0, 0.0, 0.000, 0.000, 0.0], dtype=float)
    ub = np.array([3.0, 90.0, 30.0, 1.0, 0.040, 0.020, 5.0], dtype=float)
    p0 = np.array([1.6, 45.0, 8.0, 0.05, 0.015, 0.005, 0.6], dtype=float)

    if do_calib:
        names += ["a_scale", "b_offset"]
        lb = np.concatenate([lb, np.array([0.9, -0.03])])
        ub = np.concatenate([ub, np.array([1.1, 0.03])])
        p0 = np.concatenate([p0, np.array([1.0, 0.0])])

    # Prior means and sigmas for regularization
    mu = np.array([1.6, 45.0, 8.0, 0.05, 0.015, 0.005, 0.6], dtype=float)
    sigma = np.array([0.5, 30.0, 8.0, 0.2, 0.02, 0.01, 1.5], dtype=float)
    if do_calib:
        mu = np.concatenate([mu, np.array([1.0, 0.0])])
        sigma = np.concatenate([sigma, np.array([0.05, 0.02])])

    # Generate multi-start seeds
    rng = np.random.default_rng(rng_seed)
    seeds = [p0]
    for _ in range(max(0, n_starts - 1)):
        r = rng.uniform(0.85, 1.15, size=len(p0))
        seeds.append(np.clip(p0 * r, lb, ub))

    # Spectral weighting function
    def spectral_weights(wl):
        w = np.ones_like(wl, dtype=float)
        vis = (wl >= vis_min) & (wl <= vis_max)
        w[vis] *= vis_weight
        g = np.exp(-0.5 * ((wl - green_center) / window_sigma) ** 2)
        r = np.exp(-0.5 * ((wl - rededge_center) / window_sigma) ** 2)
        v = np.exp(-0.5 * ((wl - violet_center) / window_sigma) ** 2)
        w += feature_boost * (g + r) + violet_boost * v
        return w

    # Full-spectrum objective
    def objective_full(meas_wl, meas_R):
        def f(p):
            wl_model, R_model = forward(p[:7])
            wl_c, R_meas = resample_spectrum(meas_wl, meas_R, wl_model)
            R_fit = np.interp(wl_c, wl_model, R_model)
            if do_calib:
                R_fit = p[7] * R_fit + p[8]
            res_spec = spectral_weights(wl_c) * (R_fit - R_meas)
            res_prior = (p - mu) / sigma
            return np.concatenate([res_spec, 0.1 * res_prior])
        return f

    # VIS-only objective (stage 1)
    def objective_vis(meas_wl, meas_R):
        tight = sigma.copy()
        tight[4] = min(tight[4], 1e-6)  # Cw
        tight[5] = min(tight[5], 1e-6)  # Cm
        def f(p):
            wl_model, R_model = forward(p[:7])
            wl_c, R_meas = resample_spectrum(meas_wl, meas_R, wl_model)
            R_fit = np.interp(wl_c, wl_model, R_model)
            if do_calib:
                R_fit = p[7] * R_fit + p[8]
            res_spec = spectral_weights(wl_c) * (R_fit - R_meas)
            res_prior = (p - mu) / tight
            return np.concatenate([res_spec, 0.1 * res_prior])
        return f

    # Run optimization
    best = None
    meas_wl = np.array(wavelengths)
    meas_R = np.array(reflectance)

    if stage1:
        # Two-stage: VIS first, then full
        mask = (meas_wl >= 400) & (meas_wl <= 750)
        wl_vis = meas_wl[mask]
        R_vis = meas_R[mask]
        for s in seeds:
            try:
                res1 = least_squares(
                    objective_vis(wl_vis, R_vis), s, bounds=(lb, ub),
                    method="trf", x_scale="jac", loss=loss, f_scale=f_scale, max_nfev=4000
                )
                res2 = least_squares(
                    objective_full(meas_wl, meas_R), res1.x, bounds=(lb, ub),
                    method="trf", x_scale="jac", loss=loss, f_scale=f_scale, max_nfev=6000
                )
                if best is None or res2.cost < best.cost:
                    best = res2
            except Exception as e:
                print(f"Stage1 optimization failed: {e}")
                continue
    else:
        for s in seeds:
            try:
                res = least_squares(
                    objective_full(meas_wl, meas_R), s, bounds=(lb, ub),
                    method="trf", x_scale="jac", loss=loss, f_scale=f_scale, max_nfev=6000
                )
                if best is None or res.cost < best.cost:
                    best = res
            except Exception as e:
                print(f"Single-stage optimization failed: {e}")
                continue

    if best is None:
        return {
            "success": False,
            "converged": False,
            "error": "Optimization failed for all starting points",
            "parameters": {},
            "rmse": None,
            "r_squared": None,
            "n_points": len(meas_R),
        }

    # Calculate fitted spectrum
    wl_model, R_model = forward(best.x[:7])
    wl_c, R_meas = resample_spectrum(meas_wl, meas_R, wl_model)
    R_fit = np.interp(wl_c, wl_model, R_model)
    if do_calib:
        R_fit = best.x[7] * R_fit + best.x[8]

    # Calculate metrics
    residuals = R_fit - R_meas
    rmse = float(np.sqrt(np.mean(residuals ** 2)))
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((R_meas - np.mean(R_meas)) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

    # Build parameter dict
    params = {}
    param_info = {
        "N": {"units": "-", "description": "Leaf structure parameter (number of compact layers)"},
        "Cab": {"units": "μg/cm²", "description": "Chlorophyll a+b content"},
        "Car": {"units": "μg/cm²", "description": "Carotenoid content"},
        "Cbrown": {"units": "-", "description": "Brown pigment content"},
        "Cw": {"units": "cm", "description": "Equivalent water thickness"},
        "Cm": {"units": "g/cm²", "description": "Dry matter content"},
        "Ant": {"units": "μmol/cm²", "description": "Anthocyanin content"},
        "a_scale": {"units": "-", "description": "Calibration scale factor"},
        "b_offset": {"units": "-", "description": "Calibration offset"},
    }

    for i, name in enumerate(names):
        info = param_info.get(name, {"units": "", "description": ""})
        params[name] = {
            "value": float(best.x[i]),
            "symbol": name,
            "units": info["units"],
            "description": info["description"],
            "fixed": False,
        }

    # For PROSPECT inversion, always report as converged if we got results
    # The quality is indicated by RMSE and R², not convergence status

    return {
        "success": True,
        "parameters": params,
        "rmse": rmse,
        "r_squared": float(r_squared),
        "n_points": len(R_meas),
        "converged": True,
        "fitted_spectrum": R_fit.tolist(),
        "measured_spectrum": R_meas.tolist(),
        "wavelengths": wl_c.tolist(),
        "residuals": residuals.tolist(),
        "message": best.message if hasattr(best, 'message') else "",
    }


@app.post("/api/fit/prospect")
async def fit_prospect_model(request: ProspectFitRequest):
    """
    Fit PROSPECT-D radiative transfer model to spectral reflectance data.

    Input:
        - wavelengths: array of wavelength values (nm)
        - reflectance: array of reflectance values (0-1 range)
        - Various fitting options (vis_weight, n_starts, etc.)

    Output:
        - Fitted biophysical parameters (N, Cab, Car, Cbrown, Cw, Cm, Ant)
        - Optional calibration parameters (a_scale, b_offset)
        - Fitted spectrum and fit statistics
    """
    try:
        result = fit_prospect_d(
            wavelengths=np.array(request.wavelengths),
            reflectance=np.array(request.reflectance),
            vis_weight=request.vis_weight,
            loss=request.loss,
            f_scale=request.f_scale,
            n_starts=request.n_starts,
            stage1=request.stage1,
            do_calib=request.do_calib,
            green_center=request.green_center,
            rededge_center=request.rededge_center,
            window_sigma=request.window_sigma,
            feature_boost=request.feature_boost,
            vis_min=request.vis_min,
            vis_max=request.vis_max,
            violet_center=request.violet_center,
            violet_boost=request.violet_boost,
        )
        return result
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"PROSPECT fitting failed: {str(e)}")


# ==================== POINT CLOUD TRIANGULATION ====================

class PointSource(BaseModel):
    """Tell a downstream endpoint to read points from a file on disk instead
    of an inline `points` array.

    Octree-backed clouds keep no positions in the renderer (the geometry lives
    only in the on-disk Potree octree, streamed to the GPU), so skeleton /
    triangulate / c2m / icp / export read from the original source file here
    — exactly as the M3 crop path does. The backend has no octree reader; the
    source file is always the point of truth.

    Resolved by `_read_points_from_source` (defined later, alongside the other
    point-cloud loaders it reuses).
    """
    source_path: str
    ascii_format: Optional[str] = None
    # Stride-downsample cap. None = full resolution. Stride (not reservoir)
    # preserves spatial uniformity, which skeleton/triangulation depend on.
    max_points: Optional[int] = None
    # [tx, ty, tz] ADDED to every point — matches the renderer's getDisplayData
    # (`positions[i*3] + tx`) and the in-RAM `_region_mask` translation path.
    translation: Optional[List[float]] = None
    want_colors: bool = False
    # When set, points come from a live cloud session's in-RAM array (the
    # Family-1 source of truth) with its per-point deletions already applied —
    # NOT from `source_path` on disk. This is how downstream ops honor unbaked
    # deletions without a rebuild. `source_path` stays populated for provenance
    # but is not re-read when `session_id` is present. The compute consumers of
    # this path want positions only, so the session-source branch returns
    # positions and leaves colours/intensity as None (the session DOES hold them;
    # they're simply not surfaced here).
    session_id: Optional[str] = None


class TriangulationRequest(BaseModel):
    """Request model for point cloud triangulation"""
    # Inline points for flat clouds; octree clouds send `source` instead.
    points: Optional[List[List[float]]] = None
    # Read points from a file on disk (octree-backed clouds). The renderer sets
    # `source.max_points` from the global "triangulate max points" setting to
    # bound open3d's memory on huge clouds.
    source: Optional[PointSource] = None
    method: str = "ball_pivoting"  # "ball_pivoting", "poisson", "alpha_shape", "delaunay"
    # Ball pivoting parameters
    radii: Optional[List[float]] = None  # Ball radii for ball pivoting (auto if None)
    # Poisson parameters
    depth: int = 8  # Octree depth for Poisson reconstruction
    # Alpha shape parameters
    alpha: Optional[float] = None  # Alpha value (auto if None)
    # General parameters
    estimate_normals: bool = True  # Estimate point normals if not provided
    normal_radius: float = 0.1  # Radius for normal estimation
    normal_max_nn: int = 30  # Max neighbors for normal estimation


class TriangulationResponse(BaseModel):
    """Response model for triangulation results"""
    success: bool
    vertices: List[List[float]]  # [[x, y, z], ...]
    triangles: List[List[int]]  # [[i, j, k], ...] vertex indices
    normals: Optional[List[List[float]]] = None  # Vertex normals
    surface_area: Optional[float] = None
    num_triangles: int
    num_vertices: int
    method_used: str
    error: Optional[str] = None
    # Number of input points actually triangulated. For octree clouds this can
    # be less than the cloud's full count when the `source.max_points` cap
    # downsampled — the renderer compares it to warn the user.
    points_used: Optional[int] = None


@app.post("/api/triangulate", response_model=TriangulationResponse)
async def triangulate_point_cloud(request: TriangulationRequest):
    """
    Triangulate a point cloud to create a mesh surface.

    Useful for reconstructing leaf surfaces from LiDAR point cloud data.

    Methods:
        - ball_pivoting: Ball Pivoting Algorithm - good for clean, uniformly sampled point clouds
        - poisson: Poisson Surface Reconstruction - creates watertight meshes, good for noisy data
        - alpha_shape: Alpha Shape - creates mesh based on alpha radius, good for concave shapes
        - delaunay: 2D Delaunay triangulation projected to 3D - fast, for roughly planar surfaces
    """
    try:
        import open3d as o3d

        if request.source is not None:
            points, _, _ = _read_points_from_source(request.source)
        else:
            points = np.array(request.points or [], dtype=np.float64)
        points_used = int(len(points))

        if len(points) < 3:
            return TriangulationResponse(
                success=False,
                vertices=[],
                triangles=[],
                num_triangles=0,
                num_vertices=0,
                method_used=request.method,
                points_used=points_used,
                error="Need at least 3 points for triangulation"
            )

        # Create Open3D point cloud
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)

        # Estimate normals if needed
        if request.estimate_normals:
            pcd.estimate_normals(
                search_param=o3d.geometry.KDTreeSearchParamHybrid(
                    radius=request.normal_radius,
                    max_nn=request.normal_max_nn
                )
            )
            # Orient normals consistently
            pcd.orient_normals_consistent_tangent_plane(k=15)

        mesh = None
        method_used = request.method

        if request.method == "ball_pivoting":
            # Ball Pivoting Algorithm
            if not pcd.has_normals():
                pcd.estimate_normals()
                pcd.orient_normals_consistent_tangent_plane(k=15)

            # Auto-compute radii if not provided
            if request.radii is None:
                distances = pcd.compute_nearest_neighbor_distance()
                avg_dist = np.mean(distances)
                radii = o3d.utility.DoubleVector([avg_dist, avg_dist * 2, avg_dist * 4])
            else:
                radii = o3d.utility.DoubleVector(request.radii)

            mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pcd, radii)

        elif request.method == "poisson":
            # Poisson Surface Reconstruction
            if not pcd.has_normals():
                pcd.estimate_normals()
                pcd.orient_normals_consistent_tangent_plane(k=15)

            mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
                pcd, depth=request.depth
            )

            # Remove low-density vertices (artifacts)
            densities = np.asarray(densities)
            density_threshold = np.quantile(densities, 0.1)
            vertices_to_remove = densities < density_threshold
            mesh.remove_vertices_by_mask(vertices_to_remove)

        elif request.method == "alpha_shape":
            # Alpha Shape.
            #
            # Open3D's alpha shape builds a Delaunay tetrahedralization (Qhull)
            # and keeps the faces of tetrahedra whose circumradius <= alpha. On
            # the near-planar surfaces typical of LiDAR'd leaves, Qhull produces
            # many exactly-coplanar (zero-volume) tetrahedra. Open3D skips each
            # one — logging "[CreateFromPointCloudAlphaShape] invalid tetra in
            # TetraMesh" — which both spams the console and drops faces that
            # should have bridged the surface, leaving a sparse, holey mesh.
            #
            # Two cleanups before handing the cloud to Open3D:
            #  1. Drop exact duplicate points (overlapping-scan coincidences),
            #     which are a separate source of degenerate tetrahedra.
            #  2. Add sub-micron jitter (scaled to the cloud's extent, well below
            #     any real measurement precision) to break exact coplanarity so
            #     Qhull yields non-degenerate tetrahedra. In practice this turns
            #     a handful of triangles into full surface coverage.
            pcd = pcd.remove_duplicated_points()
            jpts = np.asarray(pcd.points)
            if len(jpts) >= 4:
                extent = float(np.linalg.norm(jpts.max(axis=0) - jpts.min(axis=0)))
                if extent > 0:
                    rng = np.random.default_rng(0)  # deterministic across runs
                    jpts = jpts + rng.normal(0.0, extent * 1e-6, jpts.shape)
                    pcd.points = o3d.utility.Vector3dVector(jpts)

            if request.alpha is None:
                # Auto-compute alpha from point spacing
                distances = pcd.compute_nearest_neighbor_distance()
                alpha = np.mean(distances) * 2
            else:
                alpha = request.alpha

            # Suppress Open3D's per-tetra warnings; any genuinely degenerate
            # tetrahedra that survive jittering are correctly skipped, not an
            # error worth surfacing.
            with o3d.utility.VerbosityContextManager(o3d.utility.VerbosityLevel.Error):
                mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, alpha)

        elif request.method == "delaunay":
            # 2D Delaunay triangulation (project to XY plane, then lift back)
            from scipy.spatial import Delaunay

            # Project to 2D (XY plane)
            points_2d = points[:, :2]

            try:
                tri = Delaunay(points_2d)
                triangles = tri.simplices

                # Create mesh from triangulation
                mesh = o3d.geometry.TriangleMesh()
                mesh.vertices = o3d.utility.Vector3dVector(points)
                mesh.triangles = o3d.utility.Vector3iVector(triangles)
                mesh.compute_vertex_normals()
            except Exception as e:
                return TriangulationResponse(
                    success=False,
                    vertices=[],
                    triangles=[],
                    num_triangles=0,
                    num_vertices=0,
                    method_used=method_used,
                    error=f"Delaunay triangulation failed: {str(e)}"
                )
        else:
            return TriangulationResponse(
                success=False,
                vertices=[],
                triangles=[],
                num_triangles=0,
                num_vertices=0,
                method_used=method_used,
                error=f"Unknown method: {request.method}. Use 'ball_pivoting', 'poisson', 'alpha_shape', or 'delaunay'"
            )

        if mesh is None or len(mesh.triangles) == 0:
            return TriangulationResponse(
                success=False,
                vertices=np.asarray(pcd.points).tolist() if pcd.has_points() else [],
                triangles=[],
                num_triangles=0,
                num_vertices=len(points),
                method_used=method_used,
                error="Triangulation produced no triangles. Try adjusting parameters or using a different method."
            )

        # Clean up mesh
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_non_manifold_edges()

        # Compute normals if not present
        if not mesh.has_vertex_normals():
            mesh.compute_vertex_normals()

        # Calculate surface area
        surface_area = mesh.get_surface_area()

        # Extract results
        vertices = np.asarray(mesh.vertices).tolist()
        triangles = np.asarray(mesh.triangles).tolist()
        normals = np.asarray(mesh.vertex_normals).tolist() if mesh.has_vertex_normals() else None

        return TriangulationResponse(
            success=True,
            vertices=vertices,
            triangles=triangles,
            normals=normals,
            surface_area=float(surface_area),
            num_triangles=len(triangles),
            num_vertices=len(vertices),
            method_used=method_used,
            points_used=points_used
        )

    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="Open3D not installed. Run: pip install open3d"
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Triangulation failed: {str(e)}")


# ==================== GROUND SEGMENTATION ====================

class GroundSegmentationRequest(BaseModel):
    """Request model for ground/non-ground segmentation via CSF.

    Provide either inline `points` (flat clouds) or a `source` descriptor
    (octree-backed clouds — the backend re-reads the file). Unlike skeleton /
    triangulate, segmentation must NOT downsample: the returned `labels` align
    1:1 with the resolved point order so the renderer can attach them as a
    per-point scalar. Callers leave `source.max_points` as None.
    """
    points: Optional[List[List[float]]] = None
    source: Optional[PointSource] = None
    # CSF parameters (defaults tuned for close-range plant scans on flat-ish
    # ground, not airborne LiDAR — see segment_ground()).
    cloth_resolution: float = 0.05
    rigidness: int = 3
    class_threshold: float = 0.02
    iterations: int = 500
    slope_smooth: bool = False


class GroundSegmentationResponse(BaseModel):
    """Per-point ground/plant labels aligned to the resolved point order."""
    success: bool
    labels: List[int] = []          # 1=ground, 2=plant
    num_ground: int = 0
    num_plant: int = 0
    num_points: int = 0
    error: Optional[str] = None


def _resolve_segmentation_points(request: GroundSegmentationRequest) -> np.ndarray:
    """Resolve a GroundSegmentationRequest to an Nx3 float64 array, reading from
    the source file (full resolution) when `source` is set."""
    if request.source is not None:
        # Force full resolution: labels must align 1:1 with the cloud's points.
        src = request.source.model_copy(update={"max_points": None})
        points, _, _ = _read_points_from_source(src)
        return points
    if request.points is not None:
        return np.array(request.points, dtype=np.float64)
    raise HTTPException(status_code=400, detail="Provide either `points` or `source`.")


@app.post("/api/segment/ground", response_model=GroundSegmentationResponse)
async def segment_ground_points(request: GroundSegmentationRequest):
    """Classify a point cloud into ground (1) and plant (2) points using the
    Cloth Simulation Filter. Returns per-point labels aligned to input order;
    persisting the result onto an octree-backed cloud is done by
    `/api/cloud/session/{session_id}/segment_ground`."""
    try:
        points = _resolve_segmentation_points(request)

        if len(points) < 10:
            return GroundSegmentationResponse(
                success=False,
                num_points=len(points),
                error="Need at least 10 points for ground segmentation",
            )

        try:
            labels = segment_ground(
                points,
                cloth_resolution=request.cloth_resolution,
                rigidness=request.rigidness,
                class_threshold=request.class_threshold,
                iterations=request.iterations,
                slope_smooth=request.slope_smooth,
            )
        except ImportError:
            return GroundSegmentationResponse(
                success=False,
                num_points=len(points),
                error="CSF (cloth-simulation-filter) not installed. Run: pip install cloth-simulation-filter",
            )

        num_ground = int(np.count_nonzero(labels == GROUND_CLASS_GROUND))
        return GroundSegmentationResponse(
            success=True,
            labels=labels.tolist(),
            num_ground=num_ground,
            num_plant=len(labels) - num_ground,
            num_points=len(labels),
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Ground segmentation failed: {str(e)}")


# ==================== TREE INSTANCE SEGMENTATION (TreeIso) ====================
# `tree_instance` is the per-point scalar field this writes: 0 = unassigned,
# 1..N = tree ids. Categorical coloring + legend live in the renderer's
# classification.ts. TreeIso isolates above-ground tree structure, so callers
# should remove ground first (see `ground_warning`). Mirrors the ground-segment
# endpoints above (inline `points` or `source`; full-resolution; per-point labels).
TREE_INSTANCE_SLUG = "tree_instance"
TREE_INSTANCE_LABEL = "Tree instance"

# TreeIso is CPU-only and O(n log n)+ with heavy constants; beyond a few million
# points it crawls. Cap so the endpoints fail fast with an actionable message
# instead of appearing to hang (the dense TLS benchmark plots are ~30M points).
# Override via env for power users with patience / a big machine.
try:
    _TREEISO_MAX_POINTS = int(os.environ.get("PHYTOGRAPH_TREEISO_MAX_POINTS", "5000000"))
except (ValueError, TypeError):
    _TREEISO_MAX_POINTS = 5_000_000


class TreeSegmentationRequest(BaseModel):
    """Request model for individual-tree segmentation via TreeIso.

    Like ground segmentation, provide inline `points` or a `source` descriptor;
    the result must NOT be downsampled so per-point `labels` align 1:1. Optional
    `seed_points` ([[x,y,z], ...]) anchor trees for human-in-the-loop seeding —
    each seed yields exactly one tree id. The remaining fields are TreeIso
    parameters (defaults match Xi & Hopkinson 2022)."""
    points: Optional[List[List[float]]] = None
    source: Optional[PointSource] = None
    seed_points: Optional[List[List[float]]] = None
    reg_strength1: float = 1.0
    min_nn1: int = 5
    decimate_res1: float = 0.05
    reg_strength2: float = 15.0
    min_nn2: int = 20
    decimate_res2: float = 0.1
    max_gap: float = 2.0
    rel_height_length_ratio: float = 0.5
    vertical_weight: float = 0.5
    min_nn3: int = 20
    score_candidate_thresh: float = 0.7
    init_stem_rel_length_thresh: float = 1.5
    max_outlier_gap: float = 3.0


class TreeSegmentationResponse(BaseModel):
    """Per-point tree instance ids aligned to the resolved point order."""
    success: bool
    labels: List[int] = []          # 0 = unassigned, 1..N = tree ids
    num_trees: int = 0
    num_points: int = 0
    ground_warning: bool = False
    error: Optional[str] = None


def _treeiso_params(request: "TreeSegmentationRequest"):
    """Build a vendored TreeIsoParams from the request's tuning fields."""
    from treeiso.treeiso_core import TreeIsoParams

    return TreeIsoParams(
        reg_strength1=request.reg_strength1,
        min_nn1=request.min_nn1,
        decimate_res1=request.decimate_res1,
        reg_strength2=request.reg_strength2,
        min_nn2=request.min_nn2,
        decimate_res2=request.decimate_res2,
        max_gap=request.max_gap,
        rel_height_length_ratio=request.rel_height_length_ratio,
        vertical_weight=request.vertical_weight,
        min_nn3=request.min_nn3,
        score_candidate_thresh=request.score_candidate_thresh,
        init_stem_rel_length_thresh=request.init_stem_rel_length_thresh,
        max_outlier_gap=request.max_outlier_gap,
    )


def _looks_like_ground_present(points: np.ndarray) -> bool:
    """Cheap advisory heuristic: is there a broad, flat, dense layer at the bottom?

    TreeIso expects ground-removed input. We flag (never block) when the lowest
    vertical slab holds a large share of points spread across the full XY extent
    — the signature of an un-removed ground surface."""
    if len(points) < 100:
        return False
    z = points[:, 2]
    z0, z1 = float(np.min(z)), float(np.max(z))
    span = z1 - z0
    if span <= 1e-6:
        return False
    slab = points[z <= z0 + 0.05 * span]
    if len(slab) < 50:
        return False
    frac = len(slab) / len(points)
    xy_extent = np.ptp(points[:, :2], axis=0)
    slab_extent = np.ptp(slab[:, :2], axis=0)
    wide = bool(np.all(slab_extent > 0.6 * np.maximum(xy_extent, 1e-6)))
    return bool(frac > 0.12 and wide)


def segment_trees(
    points: np.ndarray,
    params=None,
    seeds: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Assign each point a tree id (0 = unassigned, 1..N) via TreeIso.

    With `seeds`, every TreeIso segment is reassigned to the id of its nearest
    seed (each seed -> exactly one tree); otherwise TreeIso's own 1..N labels
    are returned, aligned 1:1 to the input order."""
    from treeiso.treeiso_core import segment_trees as _ti_segment

    labels = _ti_segment(points, params)
    if seeds is None or len(seeds) == 0:
        return labels.astype(np.int64)

    # Reconcile TreeIso's segments with user trunk seeds so each seed yields one
    # tree. Greedily give every seed its nearest still-unclaimed segment (so no
    # seed is dropped when there are at least as many segments as seeds), then
    # assign any leftover segments to their nearest seed.
    seeds = np.asarray(seeds, dtype=np.float64)[:, :3]
    seg_ids = np.unique(labels)
    centroids = np.array([points[labels == s, :3].mean(axis=0) for s in seg_ids])
    cost = np.linalg.norm(centroids[:, None, :] - seeds[None, :, :], axis=2)  # (segs, seeds)

    seg_to_seed: dict[int, int] = {}
    unclaimed = set(range(len(seg_ids)))
    # Seeds whose closest segment is nearest get first pick of that segment.
    for j in np.argsort(cost.min(axis=0)):
        if not unclaimed:
            break
        cand = min(unclaimed, key=lambda i, jj=int(j): cost[i, jj])
        seg_to_seed[int(seg_ids[cand])] = int(j) + 1
        unclaimed.discard(cand)
    for i in unclaimed:
        seg_to_seed[int(seg_ids[i])] = int(np.argmin(cost[i])) + 1

    return np.array([seg_to_seed[int(s)] for s in labels], dtype=np.int64)


@app.post("/api/segment/trees", response_model=TreeSegmentationResponse)
async def segment_trees_points(request: TreeSegmentationRequest):
    """Segment a multi-tree cloud into per-point tree instance ids via TreeIso.

    Mirrors `/api/segment/ground`: inline `points` or a `source` descriptor in,
    per-point integer labels out (0 = unassigned, 1..N = trees), full resolution
    so labels align 1:1. Persisting onto an octree-backed cloud is done by
    `/api/cloud/session/{session_id}/segment_trees`.

    Labels-only by design: this interactive path returns predicted instance ids
    and nothing else. If the source carries ground-truth fields (e.g. a
    benchmark PLY's `instance`/`semantic`), they are NOT echoed back here — only
    `/apply` carries source scalars through into the octree, and the eval
    harness (`scripts/eval_tree_segmentation.py`) reads GT straight from the
    file. There is no GT consumer on this endpoint."""
    try:
        points = _resolve_segmentation_points(
            GroundSegmentationRequest(points=request.points, source=request.source)
        )

        if len(points) < 10:
            return TreeSegmentationResponse(
                success=False, num_points=len(points),
                error="Need at least 10 points to segment trees",
            )

        # Drop non-finite points before TreeIso (cKDTree chokes on NaN/inf).
        finite = np.isfinite(points).all(axis=1)
        if not finite.all():
            points = points[finite]
            if len(points) < 10:
                return TreeSegmentationResponse(
                    success=False, num_points=len(points),
                    error="Fewer than 10 finite points after dropping NaN/inf coordinates.",
                )

        if len(points) > _TREEISO_MAX_POINTS:
            return TreeSegmentationResponse(
                success=False, num_points=len(points),
                error=(f"{len(points):,} points exceeds the {_TREEISO_MAX_POINTS:,}-point "
                       "limit for tree segmentation. Downsample or crop first."),
            )

        ground_warning = _looks_like_ground_present(points)
        seeds = (
            np.asarray(request.seed_points, dtype=np.float64)
            if request.seed_points else None
        )
        try:
            labels = segment_trees(points, _treeiso_params(request), seeds)
        except ImportError as e:
            return TreeSegmentationResponse(
                success=False, num_points=len(points),
                error=f"TreeIso dependencies not installed ({e}). "
                      "Run: pip install -r backend-api/requirements.txt",
            )

        labels = np.asarray(labels)
        num_trees = int(len(np.unique(labels[labels > 0]))) if len(labels) else 0
        return TreeSegmentationResponse(
            success=True,
            labels=[int(x) for x in labels],
            num_trees=num_trees,
            num_points=len(points),
            ground_warning=ground_warning,
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return TreeSegmentationResponse(
            success=False, num_points=0, error=str(e),
        )


# ==================== HELIOS TRIANGULATION ====================

class HeliosScanEntry(BaseModel):
    """A single scan with point data (or file path) and scanner position.

    Provide either `file_path` (preferred for large scans) or `points`.
    When `file_path` is given, the backend reads the file directly via pyhelios,
    avoiding large JSON transfers.
    """
    file_path: Optional[str] = None     # Path to scan file on disk (preferred)
    ascii_format: Optional[str] = None  # Column format e.g. "x y z timestamp" (auto-detected if omitted)
    points: Optional[List[List[float]]] = None  # [[x, y, z], ...] fallback when no file_path
    colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] (0-1 range)
    origin: List[float]                 # [x, y, z] scanner position
    # Per-scan acquisition geometry, carried from the scan's own ScanParameters.
    # Helios triangulates each scan in its scanner-angular (theta, phi) grid, so
    # these describe how that scan was actually sampled. When omitted, the
    # backend falls back to the request-level theta/phi and a count-based
    # estimate of the grid resolution (see _do_helios_computation).
    n_theta: Optional[int] = None       # Zenith samples (Ntheta)
    n_phi: Optional[int] = None         # Azimuth samples (Nphi)
    theta_min: Optional[float] = None   # Zenith angle min (degrees)
    theta_max: Optional[float] = None   # Zenith angle max (degrees)
    phi_min: Optional[float] = None     # Azimuth angle min (degrees)
    phi_max: Optional[float] = None     # Azimuth angle max (degrees)
    # Return type for leaf-area-density. "single" needs only x y z; "multi"
    # (full-waveform) needs per-pulse timestamp/target_index/target_count
    # columns so Helios can group beams and gap-fill misses. Ignored by
    # triangulation; consumed by _do_lad_computation.
    return_type: str = "single"         # "single" | "multi"
    beam_exit_diameter: Optional[float] = None   # meters (multi-return only)
    beam_divergence: Optional[float] = None      # milliradians (multi-return only)
    # LAD point-data source (consumed by _do_lad_computation, ignored by
    # triangulation). A session-backed cloud passes `session_id`: the LAD path
    # feeds its surviving in-RAM points — including the per-pulse multi-return
    # columns when present — via _session_to_lad_arrays, honoring unbaked
    # deletions and never re-reading the source. A synthetic (flat, in-RAM)
    # cloud has no file or session, so it passes `points` plus, for
    # multi-return, the aligned per-pulse columns in `scalar_columns` (a dict of
    # column-name -> per-point values, e.g. timestamp/target_index/target_count).
    session_id: Optional[str] = None
    scalar_columns: Optional[Dict[str, List[float]]] = None

class HeliosGrid(BaseModel):
    """An explicit triangulation grid, derived from a voxel box in the UI.

    Helios's XML loader requires a <grid> block; it bounds the triangulation
    region. center/size are in world coordinates (the voxel box's transform);
    nx/ny/nz are its per-axis cell subdivisions."""
    center: List[float]  # [x, y, z]
    size: List[float]    # [x, y, z] full extents
    nx: int = 1
    ny: int = 1
    nz: int = 1

class HeliosTriangulationRequest(BaseModel):
    """Request model for Helios triangulation"""
    scans: List[HeliosScanEntry]
    lmax: float = 0.5
    max_aspect_ratio: float = 4.0
    # Request-level angular fallbacks, used only for scans that don't carry
    # their own theta/phi (see HeliosScanEntry). Kept for backward compatibility.
    theta_min: float = 30.0   # Zenith angle min (degrees)
    theta_max: float = 130.0  # Zenith angle max (degrees)
    phi_min: float = 0.0      # Azimuth angle min (degrees)
    phi_max: float = 360.0    # Azimuth angle max (degrees)
    # Explicit grid from a user-created voxel box. When absent the backend
    # auto-creates a single-cell grid encompassing all scan points and flags
    # grid_warning on the response.
    grid: Optional[HeliosGrid] = None

class HeliosTriangulationResponse(BaseModel):
    """Response model for Helios triangulation"""
    success: bool
    vertices: List[List[float]] = []
    triangles: List[List[int]] = []
    colors: Optional[List[List[float]]] = None
    normals: Optional[List[List[float]]] = None
    surface_area: Optional[float] = None
    num_triangles: int = 0
    num_vertices: int = 0
    method_used: str = "helios"
    error: Optional[str] = None
    # Source scan index (0-based, into request.scans) for each triangle, aligned
    # 1:1 with `triangles`. Helios triangulates each scan independently, so every
    # triangle belongs to exactly one scan; this lets the UI color triangles by
    # their originating scan.
    triangle_scan_ids: List[int] = []
    # True when no explicit grid was supplied and the backend triangulated all
    # points within their auto-computed bounding box (assumes ground/trunk were
    # already segmented or cropped). Carries a human-readable companion message.
    grid_warning: bool = False
    grid_message: Optional[str] = None


# ==================== LEAF AREA DENSITY (LAD) ====================
# Per-voxel leaf area density (m^2/m^3) via the PyHelios LiDAR plugin. LAD is
# NOT the sum of triangle areas: the triangulation only supplies the per-cell
# G-function (the leaf-projection coefficient for Beer's law); Helios then
# traces beam paths through the voxel grid and inverts Beer's law per voxel to
# recover LAD. Unlike triangulation, the voxel grid is REQUIRED — it is the
# basis of the calculation.

class LADComputeRequest(BaseModel):
    """Request model for leaf area density computation.

    Reuses HeliosScanEntry for scans (each carrying its scanner origin, angular
    geometry, and return_type). The grid is REQUIRED (its nx/ny/nz are the LAD
    voxel divisions) — there is no meaningful "auto single-cell" LAD.
    """
    scans: List[HeliosScanEntry]
    grid: HeliosGrid                       # REQUIRED — the LAD voxel grid
    lmax: float = 0.1                      # max triangle edge length (G-function)
    max_aspect_ratio: float = 4.0         # max triangle aspect ratio
    min_voxel_hits: Optional[int] = None  # min ray hits for a voxel to be solved
    # Request-level angular fallbacks (degrees), used only for scans that don't
    # carry their own theta/phi (mirrors HeliosTriangulationRequest).
    theta_min: float = 30.0
    theta_max: float = 130.0
    phi_min: float = 0.0
    phi_max: float = 360.0

class LADCell(BaseModel):
    """A single voxel result."""
    index: int
    center: List[float]   # [x, y, z]
    size: List[float]     # [x, y, z]
    leaf_area: float      # m^2 within the voxel
    lad: float            # m^2/m^3 (leaf_area / voxel volume)
    gtheta: float         # G(theta) leaf-projection coefficient
    hit_count: int        # points falling inside the voxel (numpy-binned)

class LADComputeResponse(BaseModel):
    """Response model for leaf area density computation."""
    success: bool
    cells: List[LADCell] = []
    nx: int = 1
    ny: int = 1
    nz: int = 1
    grid_center: List[float] = []
    grid_size: List[float] = []
    bounds: List[List[float]] = []   # [[lo_x,lo_y,lo_z], [hi_x,hi_y,hi_z]]
    is_multi_return: bool = False
    return_mode: str = "single"      # "single" | "multi"
    total_leaf_area: float = 0.0
    method_used: str = "helios"
    warnings: List[str] = []
    error: Optional[str] = None


def _detect_ascii_format(file_path: str) -> str:
    """Auto-detect the ASCII column format of a scan file."""
    with open(file_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            cols = len(line.split())
            if cols <= 3:
                return "x y z"
            elif cols == 4:
                return "x y z timestamp"
            elif cols == 5:
                return "x y z timestamp intensity"
            elif cols >= 6:
                return "x y z timestamp intensity color"
            break
    return "x y z"


def _count_file_lines(file_path: str) -> int:
    """Fast line count for a text file."""
    count = 0
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            count += chunk.count(b'\n')
    return count


def _xyz_column_indices(ascii_format: Optional[str]) -> tuple:
    """Return the (x, y, z) column indices for a Helios ASCII_format string.

    Helios scan files don't always lead with x y z — e.g. the lidar plugin's
    sphere fixture uses 'row column x y z r g b reflectance', putting the
    coordinates in columns 2-4. Tokenize the format to find them; fall back to
    columns 0-2 when no format is given (the common bare-XYZ case).
    """
    if ascii_format:
        tokens = _tokenize_ascii_format(ascii_format)
        try:
            return tokens.index('x'), tokens.index('y'), tokens.index('z')
        except ValueError:
            pass
    return 0, 1, 2


def _file_xyz_bounds(file_path: str, ascii_format: Optional[str] = None):
    """Stream an ASCII point file once and return (n_points, min_xyz, max_xyz).

    Used to build the auto-grid bounding box when no explicit grid is supplied.
    The x/y/z columns are located via the scan's ASCII_format (see
    _xyz_column_indices), so formats that don't lead with the coordinates are
    handled correctly. Non-numeric / comment lines are skipped. Returns
    (count, None, None) if no coordinates were found.
    """
    import math
    xi, yi, zi = _xyz_column_indices(ascii_format)
    need = max(xi, yi, zi) + 1
    n = 0
    lo = [math.inf, math.inf, math.inf]
    hi = [-math.inf, -math.inf, -math.inf]
    with open(file_path) as f:
        for line in f:
            line = line.strip()
            if not line or line[0] in '#/':
                continue
            cols = line.split()
            if len(cols) < need:
                continue
            try:
                x, y, z = float(cols[xi]), float(cols[yi]), float(cols[zi])
            except ValueError:
                continue
            if x < lo[0]: lo[0] = x
            if y < lo[1]: lo[1] = y
            if z < lo[2]: lo[2] = z
            if x > hi[0]: hi[0] = x
            if y > hi[1]: hi[1] = y
            if z > hi[2]: hi[2] = z
            n += 1
    if n == 0:
        return 0, None, None
    return n, lo, hi


def _generate_helios_xml(tmpdir: str, scans_info: list, grid_center: list,
                         grid_size: list, grid_nx: int = 1, grid_ny: int = 1,
                         grid_nz: int = 1, xml_name: str = "helios_config.xml") -> str:
    """Generate a pyhelios XML config file for scan triangulation.

    Each entry in ``scans_info`` carries its own per-scan acquisition geometry
    (``n_theta``/``n_phi`` and ``theta_min``/``theta_max``/``phi_min``/
    ``phi_max``), since Helios triangulates each scan in its own scanner-angular
    grid. ``grid_nx``/``grid_ny``/``grid_nz`` set the grid cell subdivisions
    (1×1×1 single cell by default). ``xml_name`` lets callers write one config
    per scan into the same temp dir without clobbering.
    """
    import os

    xml_lines = ['<?xml version="1.0"?>', '<helios>', '']

    for scan in scans_info:
        xml_lines.append('<scan>')
        xml_lines.append(f'    <filename>{scan["filepath"]}</filename>')
        xml_lines.append(f'    <ASCII_format>{scan["ascii_format"]}</ASCII_format>')
        xml_lines.append(f'    <origin>{scan["origin"][0]} {scan["origin"][1]} {scan["origin"][2]}</origin>')
        xml_lines.append(f'    <size>{scan["n_theta"]} {scan["n_phi"]}</size>')
        xml_lines.append(f'    <thetaMin>{scan["theta_min"]}</thetaMin>')
        xml_lines.append(f'    <thetaMax>{scan["theta_max"]}</thetaMax>')
        xml_lines.append(f'    <phiMin>{scan["phi_min"]}</phiMin>')
        xml_lines.append(f'    <phiMax>{scan["phi_max"]}</phiMax>')
        xml_lines.append('</scan>')
        xml_lines.append('')

    # Grid section is required for triangulation to work
    xml_lines.append('<grid>')
    xml_lines.append(f'    <center>{grid_center[0]} {grid_center[1]} {grid_center[2]}</center>')
    xml_lines.append(f'    <size>{grid_size[0]} {grid_size[1]} {grid_size[2]}</size>')
    xml_lines.append(f'    <Nx>{grid_nx}</Nx>')
    xml_lines.append(f'    <Ny>{grid_ny}</Ny>')
    xml_lines.append(f'    <Nz>{grid_nz}</Nz>')
    xml_lines.append('</grid>')
    xml_lines.append('')
    xml_lines.append('</helios>')

    xml_path = os.path.join(tmpdir, xml_name)
    with open(xml_path, "w") as f:
        f.write('\n'.join(xml_lines))

    return xml_path


def _do_helios_computation(request: HeliosTriangulationRequest) -> dict:
    """Run Helios triangulation synchronously. Returns a result dict.

    Supports two modes:
    - **File-path mode** (preferred): scans provide `file_path` pointing to scan
      files on disk. PyHelios reads them directly — no JSON point transfer overhead.
    - **Points mode** (fallback): scans provide `points` arrays sent over JSON.
      Works for small point clouds but too slow for large scans (680K+ points).

    Output vertices are deduplicated and indexed to minimize response size.
    """
    import math
    import tempfile
    import shutil
    import os
    import numpy as np

    tmpdir = None
    try:
        from pyhelios import LiDARCloud

        tmpdir = tempfile.mkdtemp(prefix="phytograph_helios_")

        scans_info = []
        use_file_paths = any(s.file_path for s in request.scans)

        # Per-scan angular geometry comes from the scan's own ScanParameters when
        # present; the request-level values are only a fallback for scans that
        # don't carry their own. Likewise the grid resolution (n_theta/n_phi) is
        # used as sent and only estimated from point count when absent.
        def _angles(scan_entry):
            return (
                scan_entry.theta_min if scan_entry.theta_min is not None else request.theta_min,
                scan_entry.theta_max if scan_entry.theta_max is not None else request.theta_max,
                scan_entry.phi_min if scan_entry.phi_min is not None else request.phi_min,
                scan_entry.phi_max if scan_entry.phi_max is not None else request.phi_max,
            )

        def _resolution(scan_entry, n_points, theta_span, phi_span):
            """Per-scan Ntheta/Nphi, preferring the values the scan carries."""
            if scan_entry.n_theta and scan_entry.n_phi:
                return int(scan_entry.n_theta), int(scan_entry.n_phi)
            # Fallback: back out a plausible grid from the point count and aspect.
            aspect = theta_span / max(phi_span, 1e-10)
            n_phi = max(int(math.sqrt(n_points / max(aspect, 0.01))), 10)
            n_theta = max(int(n_points / n_phi), 10)
            return n_theta, n_phi

        # Bounding box over all scan points, accumulated as scans are processed,
        # so the auto-grid (when no explicit grid is supplied) tightly encloses
        # every point regardless of which mode produced them.
        bb_lo = np.array([np.inf, np.inf, np.inf])
        bb_hi = np.array([-np.inf, -np.inf, -np.inf])

        if use_file_paths:
            # File-path mode: pyhelios reads scan files directly from disk
            for idx, scan_entry in enumerate(request.scans):
                origin = scan_entry.origin
                if len(origin) != 3:
                    raise ValueError(f"Origin must have 3 elements, got {len(origin)}")

                fp = scan_entry.file_path
                if not fp or not os.path.isfile(fp):
                    raise ValueError(f"Scan file not found: {fp}")

                # Auto-detect ASCII format if not specified
                fmt = scan_entry.ascii_format or _detect_ascii_format(fp)

                theta_min, theta_max, phi_min, phi_max = _angles(scan_entry)

                # One pass per file gives both the point count (resolution
                # fallback) and the bounds (auto-grid). Cheap relative to the
                # triangulation itself.
                n_points, lo, hi = _file_xyz_bounds(fp, fmt)
                if lo is not None:
                    bb_lo = np.minimum(bb_lo, lo)
                    bb_hi = np.maximum(bb_hi, hi)
                n_theta, n_phi = _resolution(
                    scan_entry, n_points, theta_max - theta_min, phi_max - phi_min)

                scans_info.append({
                    "filepath": fp,
                    "ascii_format": fmt,
                    "origin": origin,
                    "n_theta": n_theta,
                    "n_phi": n_phi,
                    "theta_min": theta_min,
                    "theta_max": theta_max,
                    "phi_min": phi_min,
                    "phi_max": phi_max,
                })
        else:
            # Points mode (fallback): write points to temp files
            for idx, scan_entry in enumerate(request.scans):
                origin = scan_entry.origin
                if len(origin) != 3:
                    raise ValueError(f"Origin must have 3 elements, got {len(origin)}")

                points = scan_entry.points
                if not points:
                    raise ValueError("Scan entry has no points and no file_path")

                pts_arr_scan = np.asarray(points, dtype=float)
                bb_lo = np.minimum(bb_lo, pts_arr_scan[:, :3].min(axis=0))
                bb_hi = np.maximum(bb_hi, pts_arr_scan[:, :3].max(axis=0))

                pts_path = os.path.join(tmpdir, f"scan_{idx}.txt")
                # Bulk-serialize x y z (np.savetxt) rather than a per-point
                # Python write loop. Points-mode is the small-cloud fallback;
                # large scans use file_path, which pyhelios reads directly.
                np.savetxt(pts_path, pts_arr_scan[:, :3], fmt="%.6g", delimiter=" ")

                theta_min, theta_max, phi_min, phi_max = _angles(scan_entry)
                n_theta, n_phi = _resolution(
                    scan_entry, len(points), theta_max - theta_min, phi_max - phi_min)

                scans_info.append({
                    "filepath": pts_path,
                    "ascii_format": "x y z",
                    "origin": origin,
                    "n_theta": n_theta,
                    "n_phi": n_phi,
                    "theta_min": theta_min,
                    "theta_max": theta_max,
                    "phi_min": phi_min,
                    "phi_max": phi_max,
                })

        # Resolve the grid. An explicit grid (from a voxel box in the UI) is used
        # verbatim. Otherwise auto-create a single cell tightly enclosing all
        # points and flag the response so the UI can warn that every point is
        # being triangulated (assumes ground/trunk already segmented/cropped).
        grid_warning = False
        grid_message = None
        if request.grid is not None:
            grid_center = list(request.grid.center)
            grid_size = list(request.grid.size)
            grid_nx, grid_ny, grid_nz = request.grid.nx, request.grid.ny, request.grid.nz
        else:
            if not np.all(np.isfinite(bb_lo)) or not np.all(np.isfinite(bb_hi)):
                raise ValueError("Could not determine point bounds for auto-grid")
            grid_center = ((bb_lo + bb_hi) / 2).tolist()
            grid_size = (np.maximum(bb_hi - bb_lo, 0.01) * 1.1).tolist()
            grid_nx = grid_ny = grid_nz = 1
            grid_warning = True
            grid_message = (
                "No grid box was specified — triangulating all points within "
                "their bounding box. This assumes ground and trunk have already "
                "been segmented or cropped."
            )

        # Triangulate each scan independently and tag every output triangle with
        # its source scan index. Helios already triangulates per scan internally
        # (it groups hit points by scanID before the Delaunay pass), so running
        # one LiDARCloud per scan yields the same triangles as a single merged
        # cloud — it just makes the provenance explicit, which a merged run
        # discards at the Context boundary. Triangle vertices are pulled in ONE
        # bulk FFI call per scan (getTriangleVerticesAll) instead of a per-UUID
        # Context loop, then deduplicated globally in numpy so shared geometry
        # between scans still collapses.
        scan_vert_blocks = []   # list of (T_s*9,) float32 flat-vertex arrays
        scan_id_blocks = []     # list of (T_s,) per-triangle source scan index

        for scan_idx, scan_info in enumerate(scans_info):
            xml_path = _generate_helios_xml(
                tmpdir, [scan_info], grid_center, grid_size,
                grid_nx, grid_ny, grid_nz,
                xml_name=f"helios_config_{scan_idx}.xml",
            )

            cloud = LiDARCloud()
            cloud.disableMessages()
            cloud.loadXML(xml_path)
            cloud.triangulateHitPoints(request.lmax, request.max_aspect_ratio)
            tri_count = cloud.getTriangleCount()
            if tri_count == 0:
                continue

            flat, _ = cloud.getTriangleVerticesAll()
            scan_vert_blocks.append(flat)
            scan_id_blocks.append(np.full(tri_count, scan_idx, dtype=np.int64))

        if not scan_vert_blocks:
            return {
                "success": True,
                "vertices": [],
                "triangles": [],
                "num_triangles": 0,
                "num_vertices": 0,
                "method_used": "helios",
                "error": "No triangles generated. Try increasing Lmax or adjusting max_aspect_ratio.",
                "grid_warning": grid_warning,
                "grid_message": grid_message,
            }

        # Dedup vertices in numpy. Round to 5 dp first to match the old hash-dedup
        # (100 µm), so shared edges/vertices collapse to one index. np.unique
        # returns the inverse map, which becomes the (T,3) triangle index list.
        all_verts = np.concatenate(scan_vert_blocks).reshape(-1, 3)
        triangle_scan_ids = np.concatenate(scan_id_blocks).tolist()
        rounded = np.round(all_verts, 5)
        unique_arr, inverse = np.unique(rounded, axis=0, return_inverse=True)
        # ravel() guards against numpy versions that return inverse as (N,1).
        triangles_arr = inverse.ravel().reshape(-1, 3)

        unique_vertices = unique_arr.tolist()
        triangles_list = triangles_arr.tolist()

        # Surface area from deduplicated data.
        v0 = unique_arr[triangles_arr[:, 0]]
        v1 = unique_arr[triangles_arr[:, 1]]
        v2 = unique_arr[triangles_arr[:, 2]]
        total_area = float(0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1).sum())

        return {
            "success": True,
            "vertices": unique_vertices,
            "triangles": triangles_list,
            "surface_area": total_area,
            "num_triangles": len(triangles_list),
            "num_vertices": len(unique_vertices),
            "method_used": "helios",
            "triangle_scan_ids": triangle_scan_ids,
            "grid_warning": grid_warning,
            "grid_message": grid_message,
        }

    except ImportError as e:
        return {
            "success": False,
            "vertices": [],
            "triangles": [],
            "num_triangles": 0,
            "num_vertices": 0,
            "method_used": "helios",
            "error": f"PyHelios not installed: {str(e)}"
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "vertices": [],
            "triangles": [],
            "num_triangles": 0,
            "num_vertices": 0,
            "method_used": "helios",
            "error": f"Helios triangulation failed: {str(e)}"
        }
    finally:
        if tmpdir and os.path.isdir(tmpdir):
            shutil.rmtree(tmpdir, ignore_errors=True)


@app.post("/api/triangulate/helios")
async def helios_triangulate(request: HeliosTriangulationRequest):
    """Triangulate point cloud data using PyHelios spherical Delaunay triangulation.

    Uses StreamingResponse with periodic keepalive whitespace to prevent
    WebKit's ~60s stall timeout on long-running computations.
    JSON parsers ignore leading whitespace, so " {...}" parses identically to "{...}".
    """
    import asyncio

    def compute_and_serialize():
        """Run computation + JSON serialization together in one thread."""
        result = _do_helios_computation(request)
        return json.dumps(result)

    async def stream_result():
        loop = asyncio.get_event_loop()
        future = loop.run_in_executor(None, compute_and_serialize)

        # Send keepalive whitespace every 5s while computation + serialization runs.
        # This prevents WebKit from killing the connection due to stall timeout.
        while not future.done():
            yield " "
            await asyncio.sleep(5)

        yield await future

    return StreamingResponse(stream_result(), media_type="application/json")


# Tokens the Helios ASCII loader stores into a hit's data map (the `else` branch
# of loadASCIIFile). Multi-return LAD needs these three present so Helios can
# group beams by pulse and gap-fill misses; without them isMultiReturnData() and
# gapfillMisses() cannot work.
_LAD_MULTI_RETURN_COLUMNS = ("timestamp", "target_index", "target_count")


def _directions_from_origin(xyz: "np.ndarray", origin) -> "np.ndarray":
    """Reconstruct per-hit ray directions as Helios's loadASCIIFile does when a
    scan has no zenith/azimuth columns: cart2sphere(xyz - origin).

    Returns (N,3) float32 [radius, elevation, azimuth] matching helios
    cart2sphere (global.cpp): radius = ||d||, elevation = asin(dz/radius),
    azimuth = atan2_2pi(dx, dy) which equals np.arctan2(dx, dy) (x first, y
    second; signed, no 2*pi wrap). Verified against getHitRaydir to ~1e-7.
    """
    import numpy as np

    d = np.asarray(xyz, dtype=np.float64) - np.asarray(origin, dtype=np.float64)
    r = np.linalg.norm(d, axis=1)
    rs = np.where(r > 0, r, 1.0)
    elevation = np.arcsin(np.clip(d[:, 2] / rs, -1.0, 1.0))
    azimuth = np.arctan2(d[:, 0], d[:, 1])
    return np.column_stack([r, elevation, azimuth]).astype(np.float32)


def _cull_to_grid(xyz: "np.ndarray", origin, grid_center, grid_size,
                  expand: float = 0.05) -> "np.ndarray":
    """Boolean keep-mask for points whose beam (origin -> point) can pass through
    the grid's (expanded) AABB.

    LAD needs through-grid MISS rays for Beer's law, so cull by "segment
    origin->point intersects the grid AABB", NOT "point is inside the grid": a
    far miss whose beam grazes the small grid still contributes transmittance and
    must be kept. Slab test over t in [0, 1]; axis-parallel beams (d==0) are kept
    only if the origin already lies within that axis's slab. `expand` adds a
    small margin so beams grazing the grid face (finite footprint) aren't dropped.
    """
    import numpy as np

    o = np.asarray(origin, dtype=np.float64)
    half = np.asarray(grid_size, dtype=np.float64) / 2.0 + expand
    lo = np.asarray(grid_center, dtype=np.float64) - half
    hi = np.asarray(grid_center, dtype=np.float64) + half

    d = np.asarray(xyz, dtype=np.float64) - o  # segment vector (length = range)
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (lo - o) / d
        t2 = (hi - o) / d
    tmin = np.nanmax(np.minimum(t1, t2), axis=1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=1)

    # Axis-parallel beams: d==0 on an axis -> only inside that slab if the origin
    # is within [lo, hi] on it. Otherwise the beam can never enter the box.
    par = d == 0.0
    origin_in = (o >= lo) & (o <= hi)
    bad_par = np.any(par & ~origin_in, axis=1)

    keep = (tmax >= np.maximum(tmin, 0.0)) & (tmin <= 1.0) & ~bad_par
    return keep


# Flags a LAD array-builder reports back about the resolved scan data, so
# `_do_lad_computation` can decide whether to gapfill (timestamp present, no
# misses yet), whether the cloud already carries miss points (skip gapfill), and
# whether to warn that the inversion will be inaccurate (no misses, no timestamp).
def _lad_flags(has_timestamp: bool, is_multi: bool, has_misses: bool) -> dict:
    return {"has_timestamp": has_timestamp, "multi": is_multi, "has_misses": has_misses}


def _lad_labels_vals(column_getter, n: int):
    """Assemble the (labels, vals, flags) a LAD builder feeds Helios.

    `column_getter(slug)` returns the aligned (N,) float array for a slug or None.
    Always include `timestamp` when present (gapfillMisses() needs only it);
    include target_index/target_count too when ALL three exist (full multi-return
    path).

    `is_miss` is forwarded to Helios as a per-hit data value (0.0 = return,
    1.0 = miss) whenever the cloud carries the column AT ALL — not only when a
    miss is currently flagged. This is the canonical convention the C++
    `calculateLeafArea` fail-fast check reads to refuse a cloud with no sky/miss
    rays, so every return must arrive explicitly tagged 0.0 rather than relying on
    the label's absence. A cloud with no `is_miss` column (e.g. plain XYZ) does
    NOT get a synthesised one — those recover misses via gapfillMisses(), which
    sets the same flag C++-side. Returns labels (list[str]), vals ((N,k)|None),
    flags (see `_lad_flags`).
    """
    import numpy as np

    ts = column_getter('timestamp')
    has_timestamp = ts is not None
    is_multi = has_timestamp and all(
        column_getter(c) is not None for c in ('target_index', 'target_count'))
    miss = column_getter(_MISS_SLUG)
    has_miss_column = miss is not None
    has_misses = has_miss_column and bool(np.any(np.asarray(miss) != 0))

    labels: List[str] = []
    cols: list = []
    if is_multi:
        for c in _LAD_MULTI_RETURN_COLUMNS:
            labels.append(c)
            cols.append(np.asarray(column_getter(c), dtype=np.float64))
    elif has_timestamp:
        labels.append('timestamp')
        cols.append(np.asarray(ts, dtype=np.float64))
    # Forward is_miss for every hit whenever the column exists, so returns carry
    # an explicit 0.0 and the C++ check can count misses by flag, not geometry.
    if has_miss_column:
        labels.append(_MISS_SLUG)
        cols.append(np.asarray(miss, dtype=np.float64))
    # Forward the structured-grid indices when present so the C++ grid-based
    # direction recovery (for unplaceable misses) has the raster to interpolate
    # over. Carried only when the source provided them (E57 row/column index).
    for grid_slug in ('row_index', 'column_index'):
        gcol = column_getter(grid_slug)
        if gcol is not None:
            labels.append(grid_slug)
            cols.append(np.asarray(gcol, dtype=np.float64))

    vals = np.column_stack(cols).astype(np.float64) if cols else None
    return labels, vals, _lad_flags(has_timestamp, is_multi, has_misses)


def _session_to_lad_arrays(sess: "CloudSession", origin):
    """Surviving session points as in-RAM arrays for the LAD path — no disk, no
    source-file read.

    Returns (xyz float64 (N,3), dirs float32 (N,3), labels list[str],
    vals float64 (N,k)|None, flags). Honors ~sess.deleted. `flags` (see
    `_lad_flags`) tells the caller whether to gapfill / warn.
    """
    import numpy as np

    keep = ~sess.deleted
    xyz = np.ascontiguousarray(sess.positions[keep], dtype=np.float64)
    dirs = _directions_from_origin(xyz, origin)

    def _get(slug):
        return sess.extras[slug][keep] if slug in sess.extras else None

    labels, vals, flags = _lad_labels_vals(_get, xyz.shape[0])
    return xyz, dirs, labels, vals, flags


def _inline_to_lad_arrays(points: list, scalar_columns: Optional[dict], origin):
    """Inline synthetic points (+ aligned scalar_columns) as LAD arrays. Same
    contract as _session_to_lad_arrays.
    """
    import numpy as np

    xyz = np.asarray(points, dtype=np.float64)
    if xyz.ndim != 2 or xyz.shape[1] < 3:
        raise ValueError("LAD points must be an (N, >=3) array")
    xyz = np.ascontiguousarray(xyz[:, :3])
    n = xyz.shape[0]
    dirs = _directions_from_origin(xyz, origin)

    def _get(slug):
        if scalar_columns and slug in scalar_columns and len(scalar_columns[slug]) == n:
            return np.asarray(scalar_columns[slug])
        return None

    labels, vals, flags = _lad_labels_vals(_get, n)
    return xyz, dirs, labels, vals, flags


def _file_to_lad_arrays(file_path: str, ascii_format: Optional[str], origin):
    """Legacy fallback: read an ASCII scan file once into LAD arrays (used only
    when a scan has neither a live session nor inline points — e.g. a stale
    session id that fell back to the source file). Locates x/y/z plus any
    timestamp/target/miss columns via the format string; never re-read after this.
    """
    import numpy as np

    fmt = ascii_format or _detect_ascii_format(file_path)
    tokens = fmt.split()
    xi, yi, zi = _xyz_column_indices(fmt)
    # Locate every per-pulse / miss column the format declares.
    wanted = list(_LAD_MULTI_RETURN_COLUMNS) + [_MISS_SLUG]
    col_idx = {c: tokens.index(c) for c in wanted if c in tokens}

    rows = []
    extra_rows: dict = {c: [] for c in col_idx}
    need = max([xi, yi, zi] + list(col_idx.values())) + 1
    with open(file_path) as f:
        for line in f:
            line = line.strip()
            if not line or line[0] in "#/":
                continue
            cols = line.split()
            if len(cols) < need:
                continue
            try:
                vals_xyz = (float(cols[xi]), float(cols[yi]), float(cols[zi]))
                parsed = {c: float(cols[col_idx[c]]) for c in col_idx}
            except (ValueError, IndexError):
                continue
            rows.append(vals_xyz)
            for c in col_idx:
                extra_rows[c].append(parsed[c])

    xyz = np.asarray(rows, dtype=np.float64) if rows else np.empty((0, 3), np.float64)
    dirs = _directions_from_origin(xyz, origin)

    def _get(slug):
        return np.asarray(extra_rows[slug], dtype=np.float64) if slug in col_idx else None

    labels, vals, flags = _lad_labels_vals(_get, xyz.shape[0])
    return xyz, dirs, labels, vals, flags


def _do_lad_computation(request: "LADComputeRequest") -> dict:
    """Compute per-voxel leaf area density via PyHelios. Returns a result dict.

    LAD is NOT a sum of triangle areas. The triangulation supplies the per-cell
    G-function (the leaf-projection coefficient for Beer's law); Helios then
    traces beam paths through the voxel grid and inverts Beer's law per voxel to
    recover leaf area density. Unlike triangulation, the grid is required.

    Point data is fed to Helios straight from the in-RAM session arrays via the
    bulk addHitPointsWithData FFI — no ASCII file, no disk round-trip — for both
    single- and multi-return (the data map carries timestamp/target_index/
    target_count so isMultiReturnData()/gapfillMisses() work). Points are first
    culled to the grid's beam frustum, then ray directions are reconstructed as
    cart2sphere(xyz - origin) to match the old loadASCIIFile path. All scans
    share ONE LiDARcloud and ONE grid, since beam tracing and Beer's-law
    inversion are per-voxel over the whole grid.
    """
    import math
    import os
    import numpy as np

    warnings: List[str] = []
    try:
        from pyhelios import LiDARCloud, Context

        if request.grid is None:
            raise ValueError("A voxel grid is required for leaf area density.")

        # Per-scan angular geometry / resolution: prefer the scan's own values,
        # fall back to request-level (mirrors _do_helios_computation).
        def _angles(scan_entry):
            return (
                scan_entry.theta_min if scan_entry.theta_min is not None else request.theta_min,
                scan_entry.theta_max if scan_entry.theta_max is not None else request.theta_max,
                scan_entry.phi_min if scan_entry.phi_min is not None else request.phi_min,
                scan_entry.phi_max if scan_entry.phi_max is not None else request.phi_max,
            )

        def _resolution(scan_entry, n_points, theta_span, phi_span):
            if scan_entry.n_theta and scan_entry.n_phi:
                return int(scan_entry.n_theta), int(scan_entry.n_phi)
            aspect = theta_span / max(phi_span, 1e-10)
            n_phi = max(int(math.sqrt(n_points / max(aspect, 0.01))), 10)
            n_theta = max(int(n_points / n_phi), 10)
            return n_theta, n_phi

        grid_center = list(request.grid.center)
        grid_size = list(request.grid.size)
        grid_nx, grid_ny, grid_nz = request.grid.nx, request.grid.ny, request.grid.nz

        # Each scan resolves to in-RAM arrays (xyz + ray directions + an optional
        # multi-return data map). Multi-return is detected AUTHORITATIVELY from
        # whether the resolved data actually carries the three per-pulse columns —
        # never from the `return_type` label alone. Source priority:
        #   1. session_id  -> surviving in-RAM points (+ multi-return columns when
        #      the session holds them), honoring unbaked deletions, never
        #      re-reading the source file.
        #   2. points (+ scalar_columns) -> a flat in-RAM cloud (e.g. a synthetic
        #      full-waveform scan).
        #   3. file_path -> read the ASCII file from disk once (legacy fallback).
        # Points are then culled to the grid's beam frustum before ingest.
        scans_arrays = []
        scan_xyz_for_counts = []
        for scan_entry in request.scans:
            origin = scan_entry.origin
            if len(origin) != 3:
                raise ValueError(f"Origin must have 3 elements, got {len(origin)}")

            theta_min, theta_max, phi_min, phi_max = _angles(scan_entry)

            # Resolve the live session if one was requested. A session is an
            # in-memory object that does NOT survive a backend restart, so the
            # renderer's session id can be stale (e.g. after a dev reload or a
            # respawn). When that happens, fall back to the source file the
            # renderer also sent — losing only unbaked deletions, which we warn
            # about — instead of failing the whole computation.
            sess = None
            if scan_entry.session_id:
                with _cloud_session_lock:
                    sess = _cloud_sessions.get(scan_entry.session_id)
                if sess is None and scan_entry.file_path:
                    warnings.append(
                        "The edited point-cloud session was no longer available "
                        "(the backend likely restarted), so LAD used the source "
                        "file on disk. Any unbaked deletions were not applied — "
                        "re-apply them and recompute if needed."
                    )
                elif sess is None:
                    raise ValueError(
                        f"Cloud session not found: {scan_entry.session_id}. The "
                        "backend may have restarted since import. Re-import the "
                        "scan and try again."
                    )

            if sess is not None:
                with _cloud_session_lock:
                    xyz, dirs, labels, vals, scan_flags = _session_to_lad_arrays(sess, origin)
            elif scan_entry.points:
                xyz, dirs, labels, vals, scan_flags = _inline_to_lad_arrays(
                    scan_entry.points, scan_entry.scalar_columns, origin)
            elif scan_entry.file_path:
                if not os.path.isfile(scan_entry.file_path):
                    raise ValueError(f"Scan file not found: {scan_entry.file_path}")
                xyz, dirs, labels, vals, scan_flags = _file_to_lad_arrays(
                    scan_entry.file_path, scan_entry.ascii_format, origin)
            else:
                raise ValueError("Scan entry has no points, file_path, or session_id")
            scan_multi = scan_flags["multi"]

            # Cull to the grid's beam frustum: keep only beams (origin -> point)
            # whose segment can pass through the grid AABB. This preserves
            # through-grid miss rays (Beer's law) while dropping far-field points
            # whose beams never touch the grid — the biggest win for a localized
            # grid in a large scene.
            n_before = xyz.shape[0]
            keep = _cull_to_grid(xyz, origin, grid_center, grid_size)
            if not keep.all():
                xyz = xyz[keep]
                dirs = dirs[keep]
                if vals is not None:
                    vals = vals[keep]
            n_after = xyz.shape[0]
            if n_after < n_before:
                print(f"[lad] grid cull: kept {n_after}/{n_before} points "
                      f"({100.0 * n_after / max(n_before, 1):.1f}%)", flush=True)

            # A scan flagged multi-return whose resolved data lacks the per-pulse
            # columns can't run the full-waveform algorithm (gapfillMisses() would
            # hard-error). Surface that rather than silently mislabeling it.
            if (scan_entry.return_type or "single") == "multi" and not scan_multi:
                warnings.append(
                    "Scan marked multi-return but its point data lacks the per-pulse "
                    "timestamp/target_index/target_count columns; computed as "
                    "single-return. Re-import or re-scan preserving those columns "
                    "for full-waveform LAD."
                )

            # Miss accounting drives LAD accuracy. A scan is in good shape if it
            # already carries miss points (E57 / structured PLY) OR it has a
            # timestamp column we can gapfill from. With neither, the inversion
            # can't see the gaps and is likely inaccurate — warn loudly.
            scan_label = (getattr(scan_entry, 'label', None)
                          or os.path.basename(scan_entry.file_path or '')
                          or 'this scan')
            if not scan_flags["has_misses"] and not scan_flags["has_timestamp"]:
                warnings.append(
                    f"Scan '{scan_label}' has no sky/miss points and no timestamp "
                    "column, so LAD cannot account for beams that hit the sky and is "
                    "likely to be inaccurate. Re-import a scan that carries miss "
                    "points (E57 / structured PLY) or a timestamp column so misses "
                    "can be recovered by gapfilling."
                )

            # Ntheta/Nphi describe the scanner's angular raster, not the surviving
            # points — so estimate from the PRE-cull count when the scan doesn't
            # carry explicit values. The LAD inversion is very sensitive to this
            # resolution (it sets the beam raster the Beer's-law path lengths are
            # traced over), so culling must not shrink it.
            n_theta, n_phi = _resolution(
                scan_entry, n_before, theta_max - theta_min, phi_max - phi_min)

            scans_arrays.append({
                "origin": origin,
                "xyz": xyz,
                "dirs": dirs,
                "labels": labels,
                "vals": vals,
                "n_theta": n_theta,
                "n_phi": n_phi,
                "theta_min": theta_min,
                "theta_max": theta_max,
                "phi_min": phi_min,
                "phi_max": phi_max,
                "multi": scan_multi,
                "has_timestamp": scan_flags["has_timestamp"],
                "has_misses": scan_flags["has_misses"],
            })
            scan_xyz_for_counts.append(xyz)

        is_multi = any(s["multi"] for s in scans_arrays)
        return_mode = "multi" if is_multi else "single"
        # Gapfill recovers miss points from timestamp gaps. Run it when ANY scan
        # carries a timestamp but does NOT already have miss points — this widens
        # the old multi-return-only trigger to single-return timestamped scans.
        # Skip entirely when misses are already present (E57/structured PLY), so
        # we don't synthesise duplicates on top of real misses.
        any_has_misses = any(s["has_misses"] for s in scans_arrays)
        can_gapfill = any(s["has_timestamp"] for s in scans_arrays)
        do_gapfill = can_gapfill and not any_has_misses

        # Build the cloud entirely in RAM: one scan + bulk hit ingest per scan,
        # then the grid — no XML, no ASCII file. addScan takes radians; our
        # angles are degrees. Beam divergence is supplied in milliradians.
        cloud = LiDARCloud()
        cloud.disableMessages()
        for entry, scan_entry in zip(scans_arrays, request.scans):
            sid = cloud.addScan(
                origin=entry["origin"],
                Ntheta=entry["n_theta"],
                theta_range=(math.radians(entry["theta_min"]), math.radians(entry["theta_max"])),
                Nphi=entry["n_phi"],
                phi_range=(math.radians(entry["phi_min"]), math.radians(entry["phi_max"])),
                exit_diameter=(scan_entry.beam_exit_diameter or 0.0),
                beam_divergence=((scan_entry.beam_divergence or 0.0) / 1000.0),
            )
            if entry["xyz"].shape[0] > 0:
                cloud.addHitPointsWithData(
                    sid, entry["xyz"], entry["dirs"],
                    entry["labels"], entry["vals"])
        cloud.addGrid(center=grid_center, size=grid_size,
                      ndiv=[grid_nx, grid_ny, grid_nz])

        cloud.triangulateHitPoints(request.lmax, request.max_aspect_ratio)
        if cloud.getTriangleCount() == 0:
            return {
                "success": False,
                "cells": [],
                "method_used": "helios",
                "error": "No triangles generated — cannot compute the G-function. "
                         "Try increasing Lmax or adjusting max_aspect_ratio.",
                "warnings": warnings,
            }

        recovered_misses = 0
        if do_gapfill:
            # Recover sky/miss points from timestamp gaps so they're accounted for
            # in the Beer's-law transmission probability. gapfillMisses() needs
            # only a per-hit timestamp (target_index/target_count optional), so
            # this works for single-return timestamped scans too — not just
            # full-waveform data. Synthesised misses are tagged in-cloud with
            # gapfillMisses_code == 1.0; count them to report back to the user.
            cloud.gapfillMisses()
            try:
                codes = cloud.getHitDataAll("gapfillMisses_code")
                recovered_misses = int(sum(1 for c in codes if c and c == c and c >= 1.0))
            except Exception:
                recovered_misses = 0
            if recovered_misses > 0:
                warnings.append(
                    f"Recovered {recovered_misses} sky/miss point(s) via gapfilling "
                    "(no miss points were present, but a timestamp column was)."
                )

        with Context() as ctx:
            cloud.calculateLeafArea(ctx, request.min_voxel_hits)

        # Per-cell hit counts: Helios exposes no getter, so bin the points into
        # the grid AABBs ourselves. Reads each scan file once (positions only).
        n_cells = cloud.getGridCellCount()
        cell_centers = [cloud.getCellCenter(i) for i in range(n_cells)]
        cell_sizes = [cloud.getCellSize(i) for i in range(n_cells)]
        hit_counts = _count_points_per_cell(scan_xyz_for_counts, cell_centers, cell_sizes)

        cells = []
        total_leaf_area = 0.0
        for i in range(n_cells):
            c = cell_centers[i]
            s = cell_sizes[i]
            la = float(cloud.getCellLeafArea(i))
            lad = float(cloud.getCellLeafAreaDensity(i))
            gt = float(cloud.getCellGtheta(i))
            # Helios returns NaN for unsolved cells; surface them as 0 so the UI
            # can treat them as empty rather than choking on NaN in JSON.
            if la != la:
                la = 0.0
            if lad != lad:
                lad = 0.0
            if gt != gt:
                gt = 0.0
            total_leaf_area += la
            cells.append({
                "index": i,
                "center": [c.x, c.y, c.z],
                "size": [s.x, s.y, s.z],
                "leaf_area": la,
                "lad": lad,
                "gtheta": gt,
                "hit_count": int(hit_counts[i]),
            })

        bb_lo = [grid_center[k] - grid_size[k] / 2 for k in range(3)]
        bb_hi = [grid_center[k] + grid_size[k] / 2 for k in range(3)]

        return {
            "success": True,
            "cells": cells,
            "nx": grid_nx,
            "ny": grid_ny,
            "nz": grid_nz,
            "grid_center": grid_center,
            "grid_size": grid_size,
            "bounds": [bb_lo, bb_hi],
            "is_multi_return": is_multi,
            "return_mode": return_mode,
            "total_leaf_area": total_leaf_area,
            "gapfilled_misses": recovered_misses,
            "had_miss_points": any_has_misses,
            "method_used": "helios",
            "warnings": warnings,
        }

    except ImportError as e:
        return {
            "success": False,
            "cells": [],
            "method_used": "helios",
            "error": f"PyHelios not installed: {str(e)}",
            "warnings": warnings,
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "cells": [],
            "method_used": "helios",
            "error": f"Leaf area density computation failed: {str(e)}",
            "warnings": warnings,
        }


def _count_points_per_cell(scan_xyz_list: list, cell_centers: list, cell_sizes: list):
    """Count how many scan points fall inside each voxel (axis-aligned cells).

    Bins the in-RAM (N,3) position arrays (one per scan) by the grid's regular
    structure inferred from the cell centers/sizes. Used only to populate the
    per-voxel `hit_count` for the UI — not part of the LAD math.
    """
    import numpy as np

    n_cells = len(cell_centers)
    counts = np.zeros(n_cells, dtype=np.int64)
    if n_cells == 0:
        return counts

    centers = np.array([[c.x, c.y, c.z] for c in cell_centers], dtype=np.float64)
    sizes = np.array([[s.x, s.y, s.z] for s in cell_sizes], dtype=np.float64)

    # Grid lower corner and per-axis cell counts/steps from the cell layout.
    grid_lo = (centers - sizes / 2).min(axis=0)
    grid_hi = (centers + sizes / 2).max(axis=0)
    step = sizes[0]  # cells are uniform within a Helios grid
    safe_step = np.where(step > 0, step, 1)
    nper = np.maximum(np.round((grid_hi - grid_lo) / safe_step).astype(int), 1)

    # Map each cell's (i,j,k) to its index, matching however Helios ordered them.
    cell_ijk = np.clip(
        np.floor((centers - grid_lo) / safe_step).astype(int), 0, nper - 1)
    ijk_to_index = {
        (cell_ijk[idx, 0], cell_ijk[idx, 1], cell_ijk[idx, 2]): idx
        for idx in range(n_cells)
    }
    # Flat (i,j,k) -> cell index lookup table, vectorized over all points.
    lut = np.full((nper[0], nper[1], nper[2]), -1, dtype=np.int64)
    for (i, j, k), idx in ijk_to_index.items():
        lut[i, j, k] = idx

    for xyz in scan_xyz_list:
        xyz = np.asarray(xyz, dtype=np.float64)
        if xyz.size == 0:
            continue
        ijk = np.floor((xyz - grid_lo) / safe_step).astype(int)
        inside = np.all((ijk >= 0) & (ijk < nper), axis=1)
        ijk = ijk[inside]
        if ijk.size == 0:
            continue
        cell_idx = lut[ijk[:, 0], ijk[:, 1], ijk[:, 2]]
        cell_idx = cell_idx[cell_idx >= 0]
        np.add.at(counts, cell_idx, 1)

    return counts


@app.post("/api/lad/compute")
async def lad_compute(request: LADComputeRequest):
    """Compute per-voxel leaf area density via PyHelios.

    Like /api/triangulate/helios, uses a StreamingResponse with periodic
    keepalive whitespace to survive WebKit's ~60s stall timeout on long runs.
    """
    import asyncio

    def compute_and_serialize():
        result = _do_lad_computation(request)
        return json.dumps(result)

    async def stream_result():
        loop = asyncio.get_event_loop()
        future = loop.run_in_executor(None, compute_and_serialize)
        while not future.done():
            yield " "
            await asyncio.sleep(5)
        yield await future

    return StreamingResponse(stream_result(), media_type="application/json")


# ==================== SYNTHETIC LIDAR SCANNING ====================
# True ray-traced synthetic scanning via the PyHelios `lidar` plugin. The scene
# geometry (plant + imported meshes, already world-space transformed by the
# renderer) is loaded into a Helios Context; each placed scanner becomes an
# addScan() with its ScanParameters; syntheticScan() ray-traces the scene and the
# resulting hit points are returned as a point cloud — respecting occlusion,
# scanner position, field of view, and resolution (unlike random surface sampling).

class LidarScanMesh(BaseModel):
    """A single mesh to load into the scannable scene (world-space coordinates)."""
    vertices: List[List[float]]  # [[x, y, z], ...]
    triangles: List[List[int]]   # [[i, j, k], ...] vertex indices
    colors: Optional[List[List[float]]] = None  # per-vertex [[r, g, b], ...] (0-1)


class LidarScanScanner(BaseModel):
    """A single scanner position + acquisition geometry (mirrors ScanParameters)."""
    id: str                      # renderer scan id — results are returned keyed by this
    origin: List[float]          # [x, y, z] scanner position
    n_theta: int                 # zenith samples (Ntheta)
    n_phi: int                   # azimuth samples (Nphi)
    theta_min_deg: float         # zenith angle range (degrees, 0-180)
    theta_max_deg: float
    phi_min_deg: float           # azimuth angle range (degrees, 0-360)
    phi_max_deg: float
    return_type: str = "single"  # "single" (discrete) or "multi" (full-waveform)
    exit_diameter_m: float = 0.0
    beam_divergence_mrad: float = 0.0


class LidarScanRequest(BaseModel):
    """Request model for a synthetic LiDAR scan."""
    meshes: List[LidarScanMesh]
    scanners: List[LidarScanScanner]
    # Extra per-hit scalar fields to record. The standard set (intensity, distance,
    # timestamp, target_index, target_count) is always attempted; anything here is
    # additionally treated as a column-format label, so syntheticScan samples that
    # named primitive data from the struck primitive onto each hit.
    extra_fields: List[str] = []
    # Full-waveform tuning (used only when a scanner has return_type == "multi").
    rays_per_pulse: int = 100
    pulse_distance_threshold: float = 0.02


class LidarScanResult(BaseModel):
    """Per-scanner scan result."""
    scanner_id: str
    points: List[List[float]] = []                # [[x, y, z], ...] hit points
    colors: Optional[List[List[float]]] = None    # [[r, g, b], ...] per-point (0-1)
    # Per-point scalar fields (name -> values aligned 1:1 with points). Includes
    # "intensity" plus distance/timestamp/target_index/target_count and any
    # requested extra_fields that the engine actually recorded.
    scalars: Dict[str, List[float]] = {}
    num_points: int = 0


class LidarScanResponse(BaseModel):
    """Response model for synthetic LiDAR scan results — one entry per scanner."""
    success: bool
    results: List[LidarScanResult] = []
    error: Optional[str] = None


# Standard per-hit scalar keys syntheticScan records (see helios-core lidar
# LiDAR.cpp). "intensity" is the beam/normal dot product (can be negative) scaled
# by reflectivity; we abs() it when surfacing so it reads as a 0..1-ish magnitude.
_LIDAR_STANDARD_HIT_FIELDS = ["intensity", "distance", "timestamp", "target_index", "target_count"]


@app.post("/api/lidar/scan", response_model=LidarScanResponse)
async def lidar_scan(request: LidarScanRequest):
    """
    Perform a true ray-traced synthetic LiDAR scan of the supplied geometry.

    The renderer sends:

    * ``meshes`` — plant / imported-mesh geometry (already world-space transformed)
    * ``scanners`` — one entry per visible scanner marker, each carrying its
      renderer ``id`` plus its ``ScanParameters`` (origin, angular field of view in
      degrees, resolution, return type, beam optics)

    All meshes load into one Helios ``Context``; every scanner becomes a
    ``LiDARCloud.addScan`` (added in request order, so the Helios scanID equals the
    scanner's request index); ``syntheticScan`` ray-traces the scene once. Hits are
    then partitioned back to their originating scanner via ``getHitScanID`` and
    returned **per scanner** — so the renderer can attach each scanner's points to
    its own scan, with intensity + scalar fields for color-by/filter.
    """
    try:
        if not request.meshes:
            return LidarScanResponse(success=False, error="No geometry to scan")
        if not request.scanners:
            return LidarScanResponse(success=False, error="No scanners defined")

        # Total triangle count guards against accidentally feeding a huge mesh.
        total_tris = sum(len(m.triangles) for m in request.meshes)
        if total_tris < 1:
            return LidarScanResponse(success=False, error="Geometry has no triangles")

        from pyhelios import LiDARCloud, Context

        want_waveform = any(s.return_type == "multi" for s in request.scanners)
        extra_fields = [f for f in request.extra_fields if f]
        # column_format drives which custom primitive data the scan samples onto
        # hits; only the extra fields need it (the standard keys are always recorded).
        column_format = extra_fields if extra_fields else None

        with Context() as ctx:
            # Load every mesh into the scannable scene.
            for mesh in request.meshes:
                verts = np.asarray(mesh.vertices, dtype=np.float32)
                tris = np.asarray(mesh.triangles, dtype=np.int32)
                if verts.ndim != 2 or verts.shape[1] != 3 or len(verts) < 3:
                    continue
                if tris.ndim != 2 or tris.shape[1] != 3 or len(tris) < 1:
                    continue
                colors = None
                if mesh.colors and len(mesh.colors) == len(verts):
                    colors = np.asarray(mesh.colors, dtype=np.float32)
                ctx.addTrianglesFromArrays(verts, tris, colors=colors)

            with LiDARCloud() as lidar:
                lidar.disableMessages()

                # Add scans in request order so Helios scanID == request index.
                for s in request.scanners:
                    lidar.addScan(
                        origin=[float(s.origin[0]), float(s.origin[1]), float(s.origin[2])],
                        Ntheta=int(s.n_theta),
                        theta_range=(math.radians(s.theta_min_deg), math.radians(s.theta_max_deg)),
                        Nphi=int(s.n_phi),
                        phi_range=(math.radians(s.phi_min_deg), math.radians(s.phi_max_deg)),
                        exit_diameter=float(s.exit_diameter_m),
                        beam_divergence=float(s.beam_divergence_mrad) * 1e-3,
                        column_format=column_format,
                    )

                # One ray pass for all scanners (one BVH build). append=False clears
                # once, then every scan contributes; hits carry their scanID.
                if want_waveform:
                    lidar.syntheticScan(
                        ctx,
                        rays_per_pulse=int(request.rays_per_pulse),
                        pulse_distance_threshold=float(request.pulse_distance_threshold),
                        record_misses=False,
                        append=False,
                    )
                else:
                    # Discrete-return: never records misses, so only real hits return.
                    lidar.syntheticScan(ctx)

                # Prepare per-scanner accumulators keyed by Helios scanID (= index).
                fields_to_read = _LIDAR_STANDARD_HIT_FIELDS + extra_fields
                results = [
                    {
                        "scanner_id": s.id,
                        "points": [],
                        "colors": [],
                        "scalars": {f: [] for f in fields_to_read},
                    }
                    for s in request.scanners
                ]

                n = lidar.getHitCount()
                for i in range(n):
                    sid = lidar.getHitScanID(i)
                    if sid < 0 or sid >= len(results):
                        continue
                    bucket = results[sid]
                    xyz = lidar.getHitXYZ(i)
                    bucket["points"].append([float(xyz.x), float(xyz.y), float(xyz.z)])
                    c = lidar.getHitColor(i)
                    bucket["colors"].append([float(c.r), float(c.g), float(c.b)])
                    for f in fields_to_read:
                        if lidar.doesHitDataExist(i, f):
                            v = float(lidar.getHitData(i, f))
                            # intensity is a signed dot product; surface its magnitude.
                            bucket["scalars"][f].append(abs(v) if f == "intensity" else v)
                        else:
                            bucket["scalars"][f].append(float("nan"))

        out: List[LidarScanResult] = []
        for r in results:
            npts = len(r["points"])
            # Drop scalar fields that never resolved (all-NaN) so the renderer
            # doesn't offer a dead color-by option.
            scalars = {
                k: v for k, v in r["scalars"].items()
                if any(val == val for val in v)  # any non-NaN
            }
            out.append(LidarScanResult(
                scanner_id=r["scanner_id"],
                points=r["points"],
                colors=r["colors"] if npts else None,
                scalars=scalars,
                num_points=npts,
            ))

        return LidarScanResponse(success=True, results=out)

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Synthetic LiDAR scan failed: {str(e)}")


# ==================== TREE SKELETON EXTRACTION (BFS Graph-Based Algorithm) ====================
# Based on: Li et al. 2017 "An Automatic Tree Skeleton Extracting Method Based on Point Cloud"

class SkeletonRequest(BaseModel):
    """Request model for tree skeleton extraction using BFS graph-based algorithm"""
    # Inline points for flat clouds. Optional because octree-backed clouds send
    # `source` instead (their renderer positions buffer is empty).
    points: Optional[List[List[float]]] = None
    # Read points from a file on disk (octree-backed clouds). Mutually exclusive
    # with `points`; renderer sets max_points=20000 here so the backend does the
    # downsample the renderer used to do in JS.
    source: Optional[PointSource] = None

    # Pre-processing options
    remove_outliers: bool = True  # Statistical outlier removal
    outlier_nb_neighbors: int = 20  # Neighbors for outlier detection
    outlier_std_ratio: float = 2.0  # Std deviation threshold for outliers

    # Graph building parameters
    search_radius: float = 0.05  # Radius for KD-tree neighbor search (S-R in paper)
    max_neighbors: int = 20  # Maximum neighbors per point

    # Root detection
    root_threshold: float = 0.02  # Height threshold τ for root set selection (meters)

    # Quantization parameters
    quantization_levels: int = 60  # Number of quantization intervals (Q-S in paper)
    use_nonlinear_quantization: bool = True  # Use sqrt scaling for better branch detail

    # Filtering parameters
    threshold_filter: int = 30  # Minimum points per block (T-F in paper)
    use_proportion_filter: bool = True  # Use parent/child ratio filter (P-F)
    proportion_threshold: float = 0.1  # Min ratio of child to parent block size

    # Smoothing
    smooth_skeleton: bool = True  # Apply Laplace smoothing
    smoothing_iterations: int = 2  # Number of smoothing passes

    # Legacy parameters (for API compatibility)
    dominant_axis: str = "z"  # Not used in BFS algorithm but kept for API compatibility


class SkeletonBlock(BaseModel):
    """Information about a skeleton block (cluster of points at same BFS level)"""
    block_id: int
    center: List[float]  # [x, y, z] centroid (skeleton node)
    quantized_level: int  # BFS level after quantization
    num_points: int  # Number of points in block
    parent_block_id: Optional[int] = None  # Parent block ID
    child_block_ids: List[int] = []  # Child block IDs


class SkeletonEdge(BaseModel):
    """Edge connecting two skeleton nodes"""
    from_block: int
    to_block: int
    length: float


class SkeletonResponse(BaseModel):
    """Response model for BFS-based skeleton extraction"""
    success: bool
    # Skeleton data - ordered from root to tips
    skeleton_points: List[List[float]]  # [[x, y, z], ...] skeleton nodes
    skeleton_edges: Optional[List[List[int]]] = None  # [[from_idx, to_idx], ...] connections
    branch_orders: Optional[List[int]] = None  # Branch order (Strahler number) for each node
    # Metrics
    total_length: Optional[float] = None  # Total skeleton length
    num_nodes: int  # Number of skeleton nodes
    num_edges: int = 0  # Number of skeleton edges
    num_branches: int = 0  # Number of branch points (nodes with >2 connections)
    max_branch_order: int = 0  # Maximum branch order in the skeleton
    # Block info (optional detailed output)
    blocks: Optional[List[SkeletonBlock]] = None
    # Processing info
    points_before_filtering: Optional[int] = None
    points_after_filtering: Optional[int] = None
    num_blocks_before_filter: Optional[int] = None
    num_blocks_after_filter: Optional[int] = None
    # Legacy fields for API compatibility
    dominant_axis: str = "z"
    slice_thickness: float = 0.0
    num_slices: int = 0  # Alias for num_nodes
    diameters: Optional[List[float]] = None
    error: Optional[str] = None


# ==================== GROUND SEGMENTATION HELPER (Cloth Simulation Filter) ====================

# Ground/non-ground class labels. Matches the convention of the Helios
# `object_label` column in our validation scans (1=ground, 2=plant), so a
# segmented cloud can be compared directly against ground-truth annotations.
GROUND_CLASS_GROUND = 1
GROUND_CLASS_PLANT = 2


def segment_ground(
    points: np.ndarray,
    cloth_resolution: float = 0.05,
    rigidness: int = 3,
    class_threshold: float = 0.02,
    iterations: int = 500,
    slope_smooth: bool = False,
    time_step: float = 0.65,
) -> np.ndarray:
    """Classify each point as ground (1) or plant (2) via the Cloth Simulation
    Filter (Zhang et al. 2016).

    CSF drapes an inverted cloth over the point cloud and labels points the
    cloth settles onto as ground. Defaults here are tuned for close-range plant
    scans on roughly-flat ground (cm-scale cloth resolution, high rigidness),
    NOT the airborne-LiDAR defaults the upstream docs assume.

    Returns an int array of length len(points), aligned to input order, with
    values GROUND_CLASS_GROUND / GROUND_CLASS_PLANT.

    Raises ImportError if the `CSF` extension is unavailable — the caller turns
    that into a clean error response rather than a 500.
    """
    import CSF  # SWIG C-extension; import here so a missing dep is catchable
    import os
    import tempfile

    n = len(points)
    csf = CSF.CSF()
    csf.params.bSloopSmooth = bool(slope_smooth)
    csf.params.cloth_resolution = float(cloth_resolution)
    csf.params.rigidness = int(rigidness)
    csf.params.class_threshold = float(class_threshold)
    csf.params.time_step = float(time_step)
    # NOTE: the CSF API misspells "iterations" as "interations".
    csf.params.interations = int(iterations)

    # CSF wants a contiguous float64 Nx3 array.
    csf.setPointCloud(np.ascontiguousarray(points[:, :3], dtype=np.float64))

    ground_idx, non_ground_idx = CSF.VecInt(), CSF.VecInt()
    # do_filtering() unconditionally dumps a debug `cloth_nodes.txt` into the
    # current working directory (hardcoded in the C++ lib). Run it from a temp
    # dir so the packaged app doesn't litter the user's filesystem, then drop
    # the artifact.
    prev_cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        try:
            os.chdir(tmp)
            csf.do_filtering(ground_idx, non_ground_idx)
        finally:
            os.chdir(prev_cwd)

    labels = np.full(n, GROUND_CLASS_PLANT, dtype=np.int32)
    gi = np.fromiter(ground_idx, dtype=np.int64, count=len(ground_idx))
    if gi.size:
        labels[gi] = GROUND_CLASS_GROUND
    return labels


# ==================== BFS SKELETON HELPER FUNCTIONS (Li et al. 2017) ====================

def remove_statistical_outliers(points: np.ndarray, nb_neighbors: int = 20, std_ratio: float = 2.0) -> np.ndarray:
    """
    Remove statistical outliers using k-nearest neighbors.
    Points with mean distance > std_ratio * global std are removed.
    """
    try:
        import open3d as o3d
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(points)
        cl, ind = pcd.remove_statistical_outlier(nb_neighbors=nb_neighbors, std_ratio=std_ratio)
        return np.asarray(cl.points)
    except ImportError:
        # Fallback: manual implementation
        from scipy.spatial import KDTree
        tree = KDTree(points)
        distances, _ = tree.query(points, k=min(nb_neighbors + 1, len(points)))
        mean_distances = np.mean(distances[:, 1:], axis=1)  # Exclude self
        threshold = np.mean(mean_distances) + std_ratio * np.std(mean_distances)
        mask = mean_distances <= threshold
        return points[mask]


def build_neighbor_graph(points: np.ndarray, search_radius: float, max_neighbors: int = 20) -> dict:
    """
    Build an undirected graph connecting neighboring points using KD-tree.

    Args:
        points: Nx3 array of point coordinates
        search_radius: Maximum distance to consider points as neighbors
        max_neighbors: Maximum number of neighbors per point

    Returns:
        dict with 'neighbors' (list of neighbor indices for each point) and 'kdtree'
    """
    from scipy.spatial import KDTree

    tree = KDTree(points)
    n_points = len(points)

    # Query neighbors within radius for all points
    neighbors = []
    for i in range(n_points):
        # Find neighbors within radius
        idx = tree.query_ball_point(points[i], search_radius)
        # Remove self
        idx = [j for j in idx if j != i]
        # Limit to max_neighbors
        if len(idx) > max_neighbors:
            # Keep closest neighbors
            dists = [np.linalg.norm(points[i] - points[j]) for j in idx]
            sorted_idx = np.argsort(dists)[:max_neighbors]
            idx = [idx[k] for k in sorted_idx]
        neighbors.append(idx)

    return {'neighbors': neighbors, 'kdtree': tree}


def select_root_set(points: np.ndarray, threshold: float = 0.02) -> list:
    """
    Select root points near the lowest point in z-direction.

    Args:
        points: Nx3 array of point coordinates
        threshold: Height threshold τ (meters) above lowest point

    Returns:
        List of indices of root points
    """
    z_min = np.min(points[:, 2])
    root_indices = np.where(points[:, 2] - z_min < threshold)[0].tolist()
    return root_indices


def bfs_label_points(neighbors: list, root_indices: list, n_points: int) -> np.ndarray:
    """
    Label all points with their BFS distance from root set.

    Args:
        neighbors: List of neighbor indices for each point
        root_indices: Indices of root points (labeled as 1)
        n_points: Total number of points

    Returns:
        Array of labels (distance from root, -1 for unreachable points)
    """
    from collections import deque

    labels = np.full(n_points, -1, dtype=np.int32)

    # Initialize root points with label 1
    queue = deque()
    for idx in root_indices:
        labels[idx] = 1
        queue.append(idx)

    # BFS traversal
    while queue:
        current = queue.popleft()
        current_label = labels[current]

        for neighbor in neighbors[current]:
            if labels[neighbor] == -1:  # Not yet visited
                labels[neighbor] = current_label + 1
                queue.append(neighbor)

    return labels


def quantize_labels(labels: np.ndarray, num_levels: int = 60, use_nonlinear: bool = True) -> np.ndarray:
    """
    Quantize BFS labels into discrete intervals.

    Args:
        labels: Raw BFS labels
        num_levels: Number of quantization levels (Q-S in paper)
        use_nonlinear: If True, use sqrt scaling for better branch detail

    Returns:
        Quantized labels (0 to num_levels)
    """
    valid_mask = labels > 0
    if not np.any(valid_mask):
        return np.zeros_like(labels)

    max_label = np.max(labels[valid_mask])
    quantized = np.zeros_like(labels)

    if use_nonlinear:
        # Nonlinear mapping: Val' = floor(sqrt(Val/Valmax) * num_levels)
        # This preserves more detail in branches far from root
        quantized[valid_mask] = np.floor(
            np.sqrt(labels[valid_mask] / max_label) * num_levels
        ).astype(np.int32)
    else:
        # Linear mapping
        quantized[valid_mask] = np.floor(
            (labels[valid_mask] / max_label) * num_levels
        ).astype(np.int32)

    return quantized


def cluster_blocks(quantized_labels: np.ndarray, neighbors: list) -> tuple:
    """
    Cluster connected points with the same quantized label into blocks.
    Uses DFS to find connected components within each quantization level.

    Args:
        quantized_labels: Quantized BFS labels
        neighbors: List of neighbor indices for each point

    Returns:
        (block_assignments, block_info) where:
        - block_assignments: Array mapping each point to its block ID (-1 if not assigned)
        - block_info: List of dicts with block metadata
    """
    n_points = len(quantized_labels)
    block_assignments = np.full(n_points, -1, dtype=np.int32)
    block_info = []
    current_block_id = 0

    visited = np.zeros(n_points, dtype=bool)

    for start_idx in range(n_points):
        if visited[start_idx] or quantized_labels[start_idx] < 0:
            continue

        # DFS to find all connected points with same quantized label
        target_level = quantized_labels[start_idx]
        block_points = []
        stack = [start_idx]

        while stack:
            idx = stack.pop()
            if visited[idx]:
                continue
            if quantized_labels[idx] != target_level:
                continue

            visited[idx] = True
            block_points.append(idx)
            block_assignments[idx] = current_block_id

            # Add unvisited neighbors with same label
            for neighbor in neighbors[idx]:
                if not visited[neighbor] and quantized_labels[neighbor] == target_level:
                    stack.append(neighbor)

        if len(block_points) > 0:
            block_info.append({
                'id': current_block_id,
                'level': target_level,
                'point_indices': block_points,
                'size': len(block_points)
            })
            current_block_id += 1

    return block_assignments, block_info


def find_block_connectivity(block_assignments: np.ndarray, block_info: list,
                           neighbors: list) -> dict:
    """
    Find which blocks are connected based on edge connectivity in the graph.

    Returns:
        Dict mapping block_id -> set of connected block_ids
    """
    connectivity = {b['id']: set() for b in block_info}

    n_points = len(block_assignments)
    for i in range(n_points):
        if block_assignments[i] < 0:
            continue

        my_block = block_assignments[i]
        for neighbor in neighbors[i]:
            neighbor_block = block_assignments[neighbor]
            if neighbor_block >= 0 and neighbor_block != my_block:
                connectivity[my_block].add(neighbor_block)
                connectivity[neighbor_block].add(my_block)

    return connectivity


def filter_blocks(block_info: list, block_assignments: np.ndarray,
                  connectivity: dict, threshold_filter: int = 30,
                  use_proportion_filter: bool = True,
                  proportion_threshold: float = 0.1) -> tuple:
    """
    Filter out small blocks (noise, leaves, small twigs).

    Filters:
    1. Threshold filter: Remove blocks with fewer than threshold_filter points
    2. Proportion filter: Remove blocks whose size is too small relative to parent

    Returns:
        (filtered_block_info, filtered_assignments, filtered_connectivity)
    """
    # Sort blocks by level (lower level = closer to root = parent)
    sorted_blocks = sorted(block_info, key=lambda b: b['level'])

    # Build parent-child relationships based on connectivity and level
    for block in sorted_blocks:
        block['parent_id'] = None
        block['children'] = []

    block_by_id = {b['id']: b for b in sorted_blocks}

    for block in sorted_blocks:
        # Find parent: connected block with lower level
        min_parent_level = block['level']
        parent_id = None
        for connected_id in connectivity.get(block['id'], []):
            connected_block = block_by_id.get(connected_id)
            if connected_block and connected_block['level'] < min_parent_level:
                min_parent_level = connected_block['level']
                parent_id = connected_id

        if parent_id is not None:
            block['parent_id'] = parent_id
            block_by_id[parent_id]['children'].append(block['id'])

    # Apply filters
    keep_block_ids = set()

    for block in sorted_blocks:
        # Threshold filter
        if block['size'] < threshold_filter:
            continue

        # Proportion filter
        if use_proportion_filter and block['parent_id'] is not None:
            parent = block_by_id[block['parent_id']]
            if block['size'] / parent['size'] < proportion_threshold:
                continue

        keep_block_ids.add(block['id'])

    # Also keep ancestors of kept blocks
    for block in sorted_blocks:
        if block['id'] in keep_block_ids:
            # Walk up to root, keeping all ancestors
            current = block
            while current['parent_id'] is not None:
                keep_block_ids.add(current['parent_id'])
                current = block_by_id[current['parent_id']]

    # Filter
    filtered_blocks = [b for b in block_info if b['id'] in keep_block_ids]

    # Update assignments
    filtered_assignments = block_assignments.copy()
    for i in range(len(filtered_assignments)):
        if filtered_assignments[i] not in keep_block_ids:
            filtered_assignments[i] = -1

    # Update connectivity
    filtered_connectivity = {
        bid: {c for c in conns if c in keep_block_ids}
        for bid, conns in connectivity.items()
        if bid in keep_block_ids
    }

    return filtered_blocks, filtered_assignments, filtered_connectivity


def compute_skeleton_nodes(points: np.ndarray, block_info: list) -> dict:
    """
    Compute skeleton nodes as centroids of each block.

    Returns:
        Dict mapping block_id -> centroid [x, y, z]
    """
    skeleton_nodes = {}

    for block in block_info:
        block_points = points[block['point_indices']]
        centroid = np.mean(block_points, axis=0)
        skeleton_nodes[block['id']] = centroid.tolist()

    return skeleton_nodes


def build_skeleton_tree(block_info: list, connectivity: dict,
                        skeleton_nodes: dict) -> tuple:
    """
    Build skeleton edges based on block connectivity.
    Uses a tree structure rooted at the lowest-level block.

    Returns:
        (edges, edge_lengths) where edges are pairs of block IDs
    """
    if not block_info:
        return [], []

    # Sort by level
    sorted_blocks = sorted(block_info, key=lambda b: b['level'])
    block_by_id = {b['id']: b for b in sorted_blocks}

    edges = []
    edge_lengths = []

    # Connect each block to its parent
    for block in sorted_blocks:
        if block.get('parent_id') is not None and block['parent_id'] in skeleton_nodes:
            parent_id = block['parent_id']
            child_id = block['id']

            if child_id in skeleton_nodes:
                parent_pos = np.array(skeleton_nodes[parent_id])
                child_pos = np.array(skeleton_nodes[child_id])
                length = float(np.linalg.norm(child_pos - parent_pos))

                # Skip very short edges (likely noise)
                if length > 0.001:
                    edges.append([parent_id, child_id])
                    edge_lengths.append(length)

    return edges, edge_lengths


def laplace_smooth_skeleton(skeleton_nodes: dict, edges: list,
                            iterations: int = 2) -> dict:
    """
    Smooth skeleton using Laplace smoothing.
    Each non-bifurcation node is moved to average of itself and neighbors.

    NEW_A = (A + B + C) / 3  where B is parent, C is child
    """
    if iterations <= 0 or not edges:
        return skeleton_nodes

    # Build adjacency from edges
    adjacency = {}
    for block_id in skeleton_nodes:
        adjacency[block_id] = []

    for parent_id, child_id in edges:
        if parent_id in adjacency and child_id in adjacency:
            adjacency[parent_id].append(child_id)
            adjacency[child_id].append(parent_id)

    # Find degree of each node
    degrees = {bid: len(adj) for bid, adj in adjacency.items()}

    smoothed = {bid: np.array(pos) for bid, pos in skeleton_nodes.items()}

    for _ in range(iterations):
        new_positions = {}

        for block_id, pos in smoothed.items():
            neighbors = adjacency.get(block_id, [])
            degree = degrees.get(block_id, 0)

            # Skip bifurcation points (degree > 2) and endpoints (degree <= 1)
            if degree != 2:
                new_positions[block_id] = pos
                continue

            # Average with neighbors
            neighbor_sum = np.zeros(3)
            for neighbor_id in neighbors:
                neighbor_sum += smoothed[neighbor_id]

            new_positions[block_id] = (pos + neighbor_sum) / 3

        smoothed = new_positions

    return {bid: pos.tolist() for bid, pos in smoothed.items()}


def calculate_skeleton_length(skeleton_nodes: dict, edges: list) -> float:
    """Calculate total length of skeleton by summing edge lengths."""
    total_length = 0.0

    for parent_id, child_id in edges:
        if parent_id in skeleton_nodes and child_id in skeleton_nodes:
            p1 = np.array(skeleton_nodes[parent_id])
            p2 = np.array(skeleton_nodes[child_id])
            total_length += np.linalg.norm(p2 - p1)

    return total_length


def count_branch_points(edges: list) -> int:
    """Count nodes with more than 2 connections (branch points)."""
    if not edges:
        return 0

    degree = {}
    for parent_id, child_id in edges:
        degree[parent_id] = degree.get(parent_id, 0) + 1
        degree[child_id] = degree.get(child_id, 0) + 1

    return sum(1 for d in degree.values() if d > 2)


def calculate_skeleton_length_from_edges(skeleton_nodes: dict, edges: list) -> float:
    """
    Calculate total skeleton length by summing all edge lengths.

    Args:
        skeleton_nodes: dict mapping block_id to [x, y, z] coordinates
        edges: list of (parent_id, child_id) tuples

    Returns:
        Total length of all edges
    """
    if not edges or not skeleton_nodes:
        return 0.0

    total_length = 0.0
    for parent_id, child_id in edges:
        if parent_id in skeleton_nodes and child_id in skeleton_nodes:
            p1 = np.array(skeleton_nodes[parent_id])
            p2 = np.array(skeleton_nodes[child_id])
            total_length += np.linalg.norm(p2 - p1)

    return float(total_length)


def calculate_branch_orders(skeleton_nodes: dict, edges: list, block_info: list) -> dict:
    """
    Calculate Strahler branch order for each node in the skeleton.

    Branch order (Strahler number) classification:
    - Order 1: terminal branches (tips/leaves)
    - When two branches of same order n meet, parent gets order n+1
    - When branches of different orders meet, parent gets the higher order

    Uses iterative post-order traversal to avoid Python recursion limits.

    Args:
        skeleton_nodes: dict mapping block_id to [x, y, z] coordinates
        edges: list of [parent_id, child_id] lists
        block_info: list of block dictionaries with 'id' and 'level' keys

    Returns:
        dict mapping block_id to branch order (int)
    """
    if not skeleton_nodes or not edges:
        print(f"[Branch Order] No skeleton nodes or edges")
        return {bid: 1 for bid in skeleton_nodes}

    # Build adjacency list (undirected)
    adjacency = {bid: set() for bid in skeleton_nodes}
    for edge in edges:
        parent_id, child_id = edge[0], edge[1]
        if parent_id in adjacency and child_id in adjacency:
            adjacency[parent_id].add(child_id)
            adjacency[child_id].add(parent_id)

    # Find leaves (nodes with degree 1)
    leaves = [bid for bid, neighbors in adjacency.items() if len(neighbors) <= 1]
    print(f"[Branch Order] Found {len(leaves)} leaves out of {len(skeleton_nodes)} nodes")

    # Initialize: all leaves get order 1
    branch_orders = {bid: 1 for bid in leaves}

    # Use iterative approach: process from leaves toward root
    # Track which children have been processed for each node
    processed = set(leaves)
    to_process = list(leaves)

    while to_process:
        current = to_process.pop(0)

        for neighbor in adjacency[current]:
            if neighbor in processed:
                continue

            # Check if all children of neighbor (except current's direction) are processed
            neighbor_children = [n for n in adjacency[neighbor] if n != current and n in processed]
            unprocessed_neighbors = [n for n in adjacency[neighbor] if n not in processed]

            # Only process this neighbor if all its other neighbors are processed
            # (current is the parent direction, all others should be children)
            if len(unprocessed_neighbors) <= 1:  # Only unprocessed one is current's direction (or none)
                # Get orders of all processed neighbors (children in tree sense)
                child_orders = [branch_orders[n] for n in adjacency[neighbor] if n in processed]

                if not child_orders:
                    # No children processed yet - this shouldn't happen, but handle it
                    branch_orders[neighbor] = 1
                else:
                    # Calculate Strahler order
                    max_order = max(child_orders)
                    count_max = child_orders.count(max_order)

                    if count_max >= 2:
                        branch_orders[neighbor] = max_order + 1
                    else:
                        branch_orders[neighbor] = max_order

                processed.add(neighbor)
                to_process.append(neighbor)

    # Handle any unprocessed nodes (disconnected components)
    disconnected = 0
    for bid in skeleton_nodes:
        if bid not in branch_orders:
            branch_orders[bid] = 1
            disconnected += 1

    # Debug output
    order_counts = {}
    for order in branch_orders.values():
        order_counts[order] = order_counts.get(order, 0) + 1
    max_order = max(branch_orders.values()) if branch_orders else 0
    print(f"[Branch Order] Order distribution: {order_counts}, max: {max_order}, disconnected: {disconnected}")

    return branch_orders


def order_skeleton_points(skeleton_nodes: dict, edges: list, block_info: list) -> list:
    """
    Order skeleton points from root to tips using BFS from lowest-level node.
    Returns list of [x, y, z] coordinates in order.
    """
    if not skeleton_nodes:
        return []

    if not edges:
        # No edges, just return nodes sorted by level
        block_by_id = {b['id']: b for b in block_info}
        sorted_ids = sorted(skeleton_nodes.keys(),
                           key=lambda bid: block_by_id.get(bid, {}).get('level', 0))
        return [skeleton_nodes[bid] for bid in sorted_ids]

    # Build adjacency
    adjacency = {bid: [] for bid in skeleton_nodes}
    for parent_id, child_id in edges:
        if parent_id in adjacency and child_id in adjacency:
            adjacency[parent_id].append(child_id)
            adjacency[child_id].append(parent_id)

    # Find root (lowest level node)
    block_by_id = {b['id']: b for b in block_info}
    root_id = min(skeleton_nodes.keys(),
                  key=lambda bid: block_by_id.get(bid, {}).get('level', float('inf')))

    # BFS from root
    from collections import deque
    ordered = []
    visited = set()
    queue = deque([root_id])

    while queue:
        current = queue.popleft()
        if current in visited:
            continue
        visited.add(current)
        ordered.append(skeleton_nodes[current])

        for neighbor in adjacency.get(current, []):
            if neighbor not in visited:
                queue.append(neighbor)

    return ordered


def order_skeleton_points_with_mapping(skeleton_nodes: dict, edges: list, block_info: list) -> tuple:
    """
    Convert skeleton nodes dict to ordered list with index mapping.
    Returns tuple of (list of [x, y, z] coordinates, dict mapping block_id to array index).

    Important: We must include ALL nodes and create a complete mapping so that
    edge indices can be correctly converted to array positions.
    """
    if not skeleton_nodes:
        return [], {}

    # Sort nodes by level (lowest first = root to tips)
    block_by_id = {b['id']: b for b in block_info}
    sorted_ids = sorted(skeleton_nodes.keys(),
                       key=lambda bid: block_by_id.get(bid, {}).get('level', 0))

    # Create ordered list and mapping
    ordered = [skeleton_nodes[bid] for bid in sorted_ids]
    id_to_idx = {bid: idx for idx, bid in enumerate(sorted_ids)}

    return ordered, id_to_idx


# Legacy function for API compatibility
def fit_circle_ransac(points_2d: np.ndarray, n_iterations: int = 100,
                       threshold_ratio: float = 0.02, min_inliers_ratio: float = 0.5) -> dict:
    """
    Robust circle fitting using RANSAC.

    Args:
        points_2d: Nx2 array of 2D points
        n_iterations: Number of RANSAC iterations
        threshold_ratio: Inlier threshold as fraction of estimated radius
        min_inliers_ratio: Minimum fraction of points that must be inliers

    Returns:
        dict with center, radius, inliers, rmse, confidence
    """
    n_points = len(points_2d)
    if n_points < 3:
        return {"success": False, "error": "Need at least 3 points"}

    # Initial estimate for threshold
    centroid = np.mean(points_2d, axis=0)
    est_radius = np.median(np.linalg.norm(points_2d - centroid, axis=1))
    threshold = threshold_ratio * est_radius

    best_inliers = []
    best_center = centroid
    best_radius = est_radius

    for _ in range(n_iterations):
        # Random sample of 3 points
        idx = np.random.choice(n_points, size=min(3, n_points), replace=False)
        sample = points_2d[idx]

        # Fit circle through 3 points
        try:
            center, radius = fit_circle_through_3_points(sample)
            if center is None or radius <= 0 or radius > est_radius * 5:
                continue
        except:
            continue

        # Count inliers
        distances = np.abs(np.linalg.norm(points_2d - center, axis=1) - radius)
        inliers = np.where(distances < threshold)[0]

        if len(inliers) > len(best_inliers):
            best_inliers = inliers
            best_center = center
            best_radius = radius

    # Refine with all inliers using least squares
    if len(best_inliers) >= 3:
        inlier_points = points_2d[best_inliers]
        refined = fit_circle_least_squares(inlier_points, best_center, best_radius)
        if refined["success"]:
            best_center = refined["center"]
            best_radius = refined["radius"]

            # Recalculate inliers with refined model
            distances = np.abs(np.linalg.norm(points_2d - best_center, axis=1) - best_radius)
            best_inliers = np.where(distances < threshold)[0]

    # Calculate RMSE on inliers
    if len(best_inliers) > 0:
        inlier_distances = np.linalg.norm(points_2d[best_inliers] - best_center, axis=1)
        rmse = np.sqrt(np.mean((inlier_distances - best_radius) ** 2))
        confidence = len(best_inliers) / n_points
    else:
        rmse = None
        confidence = 0.0

    return {
        "success": len(best_inliers) >= n_points * min_inliers_ratio,
        "center": best_center,
        "radius": best_radius,
        "inliers": best_inliers,
        "rmse": rmse,
        "confidence": confidence
    }


def fit_circle_through_3_points(points: np.ndarray) -> tuple:
    """
    Fit a circle through exactly 3 points.
    Returns (center, radius) or (None, None) if collinear.
    """
    if len(points) != 3:
        return None, None

    ax, ay = points[0]
    bx, by = points[1]
    cx, cy = points[2]

    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-10:  # Collinear
        return None, None

    ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / d
    uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / d

    center = np.array([ux, uy])
    radius = np.linalg.norm(points[0] - center)

    return center, radius


def fit_circle_least_squares(points_2d: np.ndarray, center_init: np.ndarray = None,
                              radius_init: float = None) -> dict:
    """
    Fit circle using least squares (for refinement).
    """
    from scipy.optimize import least_squares

    if len(points_2d) < 3:
        return {"success": False}

    if center_init is None:
        center_init = np.mean(points_2d, axis=0)
    if radius_init is None:
        radius_init = np.median(np.linalg.norm(points_2d - center_init, axis=1))

    def residuals(params):
        cx, cy, r = params
        center = np.array([cx, cy])
        distances = np.linalg.norm(points_2d - center, axis=1)
        return distances - r

    try:
        result = least_squares(residuals, [center_init[0], center_init[1], radius_init],
                              method='lm', max_nfev=100)
        cx, cy, r = result.x
        rmse = np.sqrt(np.mean(result.fun ** 2))
        return {
            "success": True,
            "center": np.array([cx, cy]),
            "radius": abs(r),
            "rmse": rmse
        }
    except:
        return {"success": False}


def adaptive_slice_extraction(
    points: np.ndarray,
    principal_direction: np.ndarray,
    num_slices: Optional[int] = None,
    slice_thickness: Optional[float] = None,
    min_points_per_slice: int = 10,
    use_local_pca: bool = True,
    fit_circles: bool = True,
    use_ransac: bool = True,
    ransac_iterations: int = 100,
    ransac_threshold: float = 0.02
) -> tuple:
    """
    Extract skeleton using adaptive slicing along principal direction.
    Uses local PCA to orient each slice perpendicular to local stem direction.

    Returns:
        slices: List of slice information dicts
        slice_thickness: The thickness used
    """
    # Project points onto principal axis
    centroid = np.mean(points, axis=0)
    projections = np.dot(points - centroid, principal_direction)

    # Get bounds along principal axis
    h_min = np.min(projections)
    h_max = np.max(projections)
    h_range = h_max - h_min

    if h_range <= 0:
        return [], 0

    # Determine slice thickness
    if slice_thickness is not None:
        thickness = slice_thickness
    elif num_slices is not None:
        thickness = h_range / num_slices
    else:
        # Auto: aim for ~50 slices, but ensure each has enough points
        target_slices = min(50, len(points) // (min_points_per_slice * 2))
        target_slices = max(10, target_slices)
        thickness = h_range / target_slices

    # Create slices
    slices = []
    current_h = h_min + thickness / 2

    # Local direction tracking for smoothness
    local_direction = principal_direction.copy()

    while current_h < h_max:
        # Get points in this slice (along principal direction)
        mask = (projections >= current_h - thickness/2) & (projections < current_h + thickness/2)
        slice_points = points[mask]

        if len(slice_points) >= min_points_per_slice:
            # Compute local direction using local PCA
            if use_local_pca and len(slice_points) >= 10:
                try:
                    local_dir, _, _ = compute_pca_direction(slice_points)
                    # Ensure consistent direction (don't flip 180 degrees)
                    if np.dot(local_dir, local_direction) < 0:
                        local_dir = -local_dir
                    # Smooth transition: blend with previous direction
                    local_direction = 0.7 * local_dir + 0.3 * local_direction
                    local_direction = local_direction / np.linalg.norm(local_direction)
                except:
                    pass  # Keep previous direction

            # Slice center point (along the axis)
            slice_center_point = centroid + current_h * principal_direction

            # Project slice points onto plane perpendicular to local direction
            points_2d, u1, u2 = project_to_plane(slice_points, local_direction, slice_center_point)

            # Circle fitting
            diameter = None
            fit_rmse = None
            num_inliers = None
            confidence = None
            center_3d = np.mean(slice_points, axis=0)  # Default to centroid

            if fit_circles and len(points_2d) >= 4:
                if use_ransac:
                    result = fit_circle_ransac(
                        points_2d,
                        n_iterations=ransac_iterations,
                        threshold_ratio=ransac_threshold
                    )
                else:
                    result = fit_circle_least_squares(points_2d)
                    if result["success"]:
                        result["confidence"] = 1.0
                        result["inliers"] = list(range(len(points_2d)))

                if result.get("success"):
                    center_2d = result["center"]
                    diameter = result["radius"] * 2
                    fit_rmse = result.get("rmse")
                    num_inliers = len(result.get("inliers", []))
                    confidence = result.get("confidence", 0.0)

                    # Convert 2D center back to 3D
                    center_3d = slice_center_point + center_2d[0] * u1 + center_2d[1] * u2

            slices.append({
                "center": center_3d.tolist(),
                "height": float(current_h),
                "diameter": diameter,
                "num_points": len(slice_points),
                "num_inliers": num_inliers,
                "fit_rmse": fit_rmse,
                "local_direction": local_direction.tolist(),
                "confidence": confidence
            })

        current_h += thickness

    return slices, thickness


def remove_outlier_skeleton_points(slices: list, threshold_factor: float = 2.5) -> list:
    """
    Remove skeleton points that deviate significantly from the local trajectory.
    Uses distance from a smoothed trajectory as criterion.
    """
    if len(slices) < 5:
        return slices

    centers = np.array([s["center"] for s in slices])

    # Compute local deviation: distance from line through neighbors
    deviations = []
    for i in range(len(centers)):
        if i == 0:
            # First point: check distance from line to next two points
            if len(centers) >= 3:
                v = centers[2] - centers[1]
                v = v / (np.linalg.norm(v) + 1e-10)
                proj = centers[1] + np.dot(centers[i] - centers[1], v) * v
                deviations.append(np.linalg.norm(centers[i] - proj))
            else:
                deviations.append(0)
        elif i == len(centers) - 1:
            # Last point: check distance from line through previous two points
            v = centers[i-1] - centers[i-2]
            v = v / (np.linalg.norm(v) + 1e-10)
            proj = centers[i-1] + np.dot(centers[i] - centers[i-1], v) * v
            deviations.append(np.linalg.norm(centers[i] - proj))
        else:
            # Middle points: distance from line through neighbors
            v = centers[i+1] - centers[i-1]
            v = v / (np.linalg.norm(v) + 1e-10)
            proj = centers[i-1] + np.dot(centers[i] - centers[i-1], v) * v
            deviations.append(np.linalg.norm(centers[i] - proj))

    deviations = np.array(deviations)
    threshold = np.median(deviations) + threshold_factor * np.std(deviations)

    # Filter slices
    filtered_slices = [s for s, d in zip(slices, deviations) if d <= threshold]

    return filtered_slices


def smooth_skeleton_robust(skeleton_points: np.ndarray, smoothing_factor: float = 0.0) -> np.ndarray:
    """
    Smooth skeleton using spline interpolation with curvature constraints.
    """
    from scipy.interpolate import splprep, splev

    if len(skeleton_points) < 4:
        return skeleton_points

    try:
        # Calculate cumulative arc length for parameterization
        diffs = np.diff(skeleton_points, axis=0)
        segment_lengths = np.linalg.norm(diffs, axis=1)
        cumulative_length = np.concatenate([[0], np.cumsum(segment_lengths)])
        total_length = cumulative_length[-1]

        if total_length <= 0:
            return skeleton_points

        # Normalize to [0, 1]
        u = cumulative_length / total_length

        # Fit spline
        tck, _ = splprep(
            [skeleton_points[:, 0], skeleton_points[:, 1], skeleton_points[:, 2]],
            u=u,
            s=smoothing_factor * total_length,  # Scale smoothing by length
            k=min(3, len(skeleton_points) - 1)
        )

        # Evaluate at same number of points
        u_new = np.linspace(0, 1, len(skeleton_points))
        smoothed = np.array(splev(u_new, tck)).T
        return smoothed
    except Exception as e:
        print(f"Smoothing failed: {e}")
        return skeleton_points


def smooth_diameters(diameters: list, window_size: int = 5) -> list:
    """
    Smooth diameter profile using median filter.
    Returns a list of floats with NO None values (interpolates missing values).
    Returns None if all diameters are None.
    """
    from scipy.ndimage import median_filter

    if not diameters:
        return None

    # Handle None values - check if we have any valid values
    valid_mask = [d is not None for d in diameters]
    if not any(valid_mask):
        return None  # All None, can't compute diameters

    # Convert to array, using NaN for None values
    arr = np.array([d if d is not None else np.nan for d in diameters], dtype=np.float64)

    # Interpolate NaN values using linear interpolation
    nans = np.isnan(arr)
    if np.any(nans):
        x = np.arange(len(arr))
        valid_x = x[~nans]
        valid_y = arr[~nans]
        arr[nans] = np.interp(x[nans], valid_x, valid_y)

    # Apply median filter if we have enough values
    if len(arr) >= window_size:
        smoothed = median_filter(arr, size=window_size)
    else:
        smoothed = arr

    return smoothed.tolist()


def calculate_skeleton_length(skeleton_points: np.ndarray) -> float:
    """Calculate total length of skeleton by summing segment lengths."""
    if len(skeleton_points) < 2:
        return 0.0

    diff = np.diff(skeleton_points, axis=0)
    segment_lengths = np.sqrt(np.sum(diff**2, axis=1))
    return float(np.sum(segment_lengths))


@app.post("/api/skeleton/extract", response_model=SkeletonResponse)
async def extract_stem_skeleton(request: SkeletonRequest):
    """
    Extract tree skeleton from point cloud using BFS graph-based algorithm.

    Based on Li et al. 2017 "An Automatic Tree Skeleton Extracting Method
    Based on Point Cloud of Terrestrial Laser Scanner"

    Algorithm stages:
    1. Pre-processing: Statistical outlier removal
    2. Build KD-tree neighbor graph
    3. Select root points near base (lowest z-coordinate)
    4. BFS label all points with distance from root
    5. Nonlinear quantization using sqrt scaling
    6. Cluster connected points with same quantized label into blocks
    7. Filter blocks (threshold filter + proportion filter)
    8. Compute skeleton nodes from block centroids
    9. Build skeleton edges based on block connectivity
    10. Apply Laplace smoothing

    Returns skeleton points, edges, and metrics.
    """
    try:
        if request.source is not None:
            # Octree-backed cloud: read (and downsample) from the source file.
            points, _, _ = _read_points_from_source(request.source)
        else:
            points = np.array(request.points or [], dtype=np.float64)
        points_original_count = len(points)

        if len(points) < 50:
            return SkeletonResponse(
                success=False,
                skeleton_points=[],
                num_nodes=0,
                dominant_axis=request.dominant_axis,
                points_before_filtering=points_original_count,
                points_after_filtering=len(points),
                error="Need at least 50 points for BFS skeleton extraction"
            )

        # Stage 1: Pre-processing - Statistical outlier removal
        if request.remove_outliers:
            points = remove_statistical_outliers(
                points,
                nb_neighbors=request.outlier_nb_neighbors,
                std_ratio=request.outlier_std_ratio
            )

            if len(points) < 50:
                return SkeletonResponse(
                    success=False,
                    skeleton_points=[],
                    num_nodes=0,
                    dominant_axis=request.dominant_axis,
                    points_before_filtering=points_original_count,
                    points_after_filtering=len(points),
                    error="Too few points remaining after outlier removal. Try increasing std_ratio."
                )

        points_after_filtering = len(points)
        print(f"[BFS Skeleton] After outlier removal: {points_after_filtering} points")

        # Auto-calculate search_radius from point density when it's left unset
        # (the UI sends 0 for "auto"). Done backend-side so octree clouds —
        # whose renderer has no positions to sample — get a sensible radius;
        # the flat path historically computed this in JS, but the backend KD-tree
        # estimate is identical and works for both paths.
        effective_search_radius = request.search_radius
        if effective_search_radius is None or effective_search_radius < 0.001:
            from scipy.spatial import KDTree as _KDTree
            sample_n = min(500, len(points))
            # Deterministic evenly-spaced sample (no RNG) — same density estimate
            # without per-call variation.
            sample_idx = np.linspace(0, len(points) - 1, sample_n).astype(np.int64)
            tree = _KDTree(points)
            # k=2: nearest is the point itself (dist 0), second is the true NN.
            dists, _ = tree.query(points[sample_idx], k=2)
            nn = dists[:, 1]
            nn = nn[nn > 0]
            avg_nn = float(nn.mean()) if nn.size > 0 else 0.05
            effective_search_radius = avg_nn * 2.5
            print(f"[BFS Skeleton] Auto search_radius={effective_search_radius:.4f} "
                  f"(avg NN dist {avg_nn:.4f})")

        # Stage 2: Build KD-tree neighbor graph
        print(f"[BFS Skeleton] Building neighbor graph with radius={effective_search_radius}")
        graph_info = build_neighbor_graph(
            points,
            search_radius=effective_search_radius,
            max_neighbors=request.max_neighbors
        )
        neighbors = graph_info['neighbors']

        # Check connectivity
        connected_count = sum(1 for n in neighbors if len(n) > 0)
        print(f"[BFS Skeleton] Connected points: {connected_count}/{len(points)}")

        if connected_count < len(points) * 0.5:
            # Too many disconnected points - try to auto-adjust radius
            print(f"[BFS Skeleton] Warning: Many disconnected points. Consider increasing search_radius.")

        # Stage 3: Select root points (near base)
        root_indices = select_root_set(points, threshold=request.root_threshold)
        print(f"[BFS Skeleton] Selected {len(root_indices)} root points")

        if len(root_indices) == 0:
            return SkeletonResponse(
                success=False,
                skeleton_points=[],
                num_nodes=0,
                dominant_axis=request.dominant_axis,
                points_before_filtering=points_original_count,
                points_after_filtering=points_after_filtering,
                error="No root points found. Check root_threshold parameter."
            )

        # Stage 4: BFS label all points with distance from root
        print("[BFS Skeleton] Running BFS labeling...")
        labels = bfs_label_points(neighbors, root_indices, len(points))

        labeled_count = np.sum(labels >= 0)
        print(f"[BFS Skeleton] Labeled {labeled_count}/{len(points)} points")

        if labeled_count < len(points) * 0.3:
            return SkeletonResponse(
                success=False,
                skeleton_points=[],
                num_nodes=0,
                dominant_axis=request.dominant_axis,
                points_before_filtering=points_original_count,
                points_after_filtering=points_after_filtering,
                error=f"BFS only reached {labeled_count} points ({100*labeled_count/len(points):.1f}%). "
                      "Try increasing search_radius for better connectivity."
            )

        # Stage 5: Nonlinear quantization using sqrt scaling
        print(f"[BFS Skeleton] Quantizing labels into {request.quantization_levels} levels...")
        quantized = quantize_labels(
            labels,
            num_levels=request.quantization_levels,
            use_nonlinear=request.use_nonlinear_quantization
        )

        unique_levels = len(np.unique(quantized[quantized >= 0]))
        print(f"[BFS Skeleton] Active quantization levels: {unique_levels}")

        # Stage 6: Cluster connected points with same quantized label into blocks
        print("[BFS Skeleton] Clustering blocks...")
        block_assignments, block_info = cluster_blocks(quantized, neighbors)
        num_blocks_before = len(block_info)
        print(f"[BFS Skeleton] Created {num_blocks_before} blocks")

        if num_blocks_before == 0:
            return SkeletonResponse(
                success=False,
                skeleton_points=[],
                num_nodes=0,
                dominant_axis=request.dominant_axis,
                points_before_filtering=points_original_count,
                points_after_filtering=points_after_filtering,
                error="No blocks created. Check point cloud connectivity."
            )

        # Find block connectivity (which blocks connect to which)
        connectivity = find_block_connectivity(block_assignments, block_info, neighbors)

        # Stage 7: Filter blocks using threshold filter and proportion filter
        print(f"[BFS Skeleton] Filtering blocks (threshold={request.threshold_filter})...")
        filtered_blocks, filtered_assignments, filtered_connectivity = filter_blocks(
            block_info,
            block_assignments,
            connectivity,
            threshold_filter=request.threshold_filter,
            use_proportion_filter=request.use_proportion_filter,
            proportion_threshold=request.proportion_threshold
        )
        num_blocks_after = len(filtered_blocks)
        print(f"[BFS Skeleton] Blocks after filtering: {num_blocks_after}")

        if num_blocks_after < 2:
            return SkeletonResponse(
                success=False,
                skeleton_points=[],
                num_nodes=0,
                num_blocks_before_filter=num_blocks_before,
                num_blocks_after_filter=num_blocks_after,
                dominant_axis=request.dominant_axis,
                points_before_filtering=points_original_count,
                points_after_filtering=points_after_filtering,
                error=f"Only {num_blocks_after} blocks after filtering. "
                      "Try reducing threshold_filter or disabling proportion_filter."
            )

        # Stage 8: Compute skeleton nodes from block centroids
        print("[BFS Skeleton] Computing skeleton nodes...")
        skeleton_nodes = compute_skeleton_nodes(points, filtered_blocks)

        # Stage 9: Build skeleton edges based on block connectivity
        print("[BFS Skeleton] Building skeleton tree...")
        edges, edge_lengths = build_skeleton_tree(filtered_blocks, filtered_connectivity, skeleton_nodes)
        print(f"[BFS Skeleton] Created {len(edges)} edges")

        # Stage 10: Apply Laplace smoothing
        if request.smooth_skeleton and len(skeleton_nodes) > 2:
            print(f"[BFS Skeleton] Smoothing ({request.smoothing_iterations} iterations)...")
            skeleton_nodes = laplace_smooth_skeleton(
                skeleton_nodes,
                edges,
                iterations=request.smoothing_iterations
            )

        # Order skeleton points from root to tips and get the ordering
        ordered_points, block_id_to_idx = order_skeleton_points_with_mapping(skeleton_nodes, edges, filtered_blocks)

        # Calculate total length
        total_length = calculate_skeleton_length_from_edges(skeleton_nodes, edges)

        # Count branch points (nodes with >2 connections)
        num_branches = count_branch_points(edges)

        # Calculate branch orders (Strahler numbers)
        branch_order_by_id = calculate_branch_orders(skeleton_nodes, edges, filtered_blocks)

        # Convert branch orders to array order (matching point indices)
        # block_id_to_idx maps block_id -> array index, so we need to create array in that order
        sorted_block_ids = sorted(block_id_to_idx.keys(), key=lambda bid: block_id_to_idx[bid])
        branch_orders_list = [branch_order_by_id.get(bid, 1) for bid in sorted_block_ids]
        max_branch_order = max(branch_orders_list) if branch_orders_list else 0

        # Build block info for response
        block_response = [
            SkeletonBlock(
                block_id=b['id'],
                center=skeleton_nodes[b['id']],
                quantized_level=b['level'],
                num_points=b['size']
            )
            for b in filtered_blocks
            if b['id'] in skeleton_nodes
        ]

        # Convert edges to list format [[from_idx, to_idx], ...] using array indices
        edges_list = []
        for e in edges:
            from_id, to_id = e[0], e[1]
            if from_id in block_id_to_idx and to_id in block_id_to_idx:
                edges_list.append([block_id_to_idx[from_id], block_id_to_idx[to_id]])

        print(f"[BFS Skeleton] Complete: {len(skeleton_nodes)} nodes, {len(edges)} edges, {num_branches} branches, max order: {max_branch_order}")

        return SkeletonResponse(
            success=True,
            skeleton_points=ordered_points,
            skeleton_edges=edges_list,
            branch_orders=branch_orders_list,
            total_length=total_length,
            num_nodes=len(skeleton_nodes),
            num_edges=len(edges),
            num_branches=num_branches,
            max_branch_order=max_branch_order,
            blocks=block_response,
            points_before_filtering=points_original_count,
            points_after_filtering=points_after_filtering,
            num_blocks_before_filter=num_blocks_before,
            num_blocks_after_filter=num_blocks_after,
            dominant_axis=request.dominant_axis,
            num_slices=len(skeleton_nodes)  # Legacy compatibility
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Skeleton extraction failed: {str(e)}")


# ==================== PLANT MODEL GENERATION API ====================
# Uses pyhelios3d PlantArchitecture to generate procedural plant models

class PlantGenerationRequest(BaseModel):
    """Request for generating a plant model"""
    plant_type: str = "bean"  # Plant model name from library
    age: float = 30.0  # Age in days
    # Optional position offset (defaults to origin)
    position_x: float = 0.0
    position_y: float = 0.0
    position_z: float = 0.0
    # Advanced parameters (optional)
    random_seed: Optional[int] = None  # Random seed for reproducibility


class PlantCanopyRequest(BaseModel):
    """Request for generating a canopy of regularly spaced plants"""
    plant_type: str = "bean"  # Plant model name from library
    age: float = 30.0  # Age of all plants in days
    # Cartesian center of the canopy grid (defaults to origin)
    center_x: float = 0.0
    center_y: float = 0.0
    center_z: float = 0.0
    # Spacing between plants (meters) in the x- and y-directions
    spacing_x: float = 0.5
    spacing_y: float = 0.5
    # Number of plants in the x- and y-directions
    count_x: int = 3
    count_y: int = 3
    # Probability (0-1) that each grid position is occupied; 1.0 fills all
    germination_rate: float = 1.0
    # Advanced parameters (optional)
    random_seed: Optional[int] = None  # Random seed for reproducibility


class PlantStreamRequest(BaseModel):
    """Request for streaming plant/canopy generation with progress (SSE).

    `mode` selects single-plant vs. canopy; the relevant subset of fields is
    used for each. Single plants additionally create a retained session so the
    age slider keeps working after generation.
    """
    mode: str = "single"  # "single" | "canopy"
    plant_type: str = "bean"
    age: float = 30.0
    random_seed: Optional[int] = None
    # Single-plant position (mode == "single")
    position_x: float = 0.0
    position_y: float = 0.0
    position_z: float = 0.0
    # Canopy parameters (mode == "canopy")
    center_x: float = 0.0
    center_y: float = 0.0
    center_z: float = 0.0
    spacing_x: float = 0.5
    spacing_y: float = 0.5
    count_x: int = 3
    count_y: int = 3
    germination_rate: float = 1.0


class PlantMaterial(BaseModel):
    """Material definition for plant rendering"""
    name: str
    color: Optional[List[float]] = None  # [r, g, b] ambient/diffuse color (0-1 range)
    texture_name: Optional[str] = None  # Name of texture in textures dict
    has_alpha: bool = False  # Whether texture has alpha transparency


class PlantMaterialGroup(BaseModel):
    """Group of triangles sharing the same material"""
    material_name: str
    triangle_indices: List[int]  # Indices into the main indices array


class PlantGenerationResponse(BaseModel):
    """Response containing generated plant mesh data and Helios XML structure"""
    success: bool
    vertices: List[List[float]]  # [[x, y, z], ...]
    indices: List[List[int]]  # [[v0, v1, v2], ...] triangle indices
    normals: Optional[List[List[float]]] = None  # [[nx, ny, nz], ...]
    colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] vertex colors (0-1 range)
    # Texture support (OBJ export)
    uv_coordinates: Optional[List[List[float]]] = None  # [[u, v], ...] per vertex
    materials: Optional[List[PlantMaterial]] = None  # Material definitions
    material_groups: Optional[List[PlantMaterialGroup]] = None  # Triangle-to-material mapping
    textures: Optional[Dict[str, str]] = None  # {texture_name: base64_png_data}
    vertex_count: int
    triangle_count: int
    plant_type: str
    age: float
    height: Optional[float] = None
    available_models: Optional[List[str]] = None
    helios_xml: Optional[str] = None  # Plant structure XML for Helios simulation
    error: Optional[str] = None
    # Session support for age stepping
    session_id: Optional[str] = None  # Session ID for time-stepping
    # Canopy support (echoed back so the frontend can label/store the grid)
    plant_count: Optional[int] = None  # Total plants actually built (after germination)
    count_x: Optional[int] = None      # Grid columns requested
    count_y: Optional[int] = None      # Grid rows requested
    spacing_x: Optional[float] = None  # Spacing used in x (meters)
    spacing_y: Optional[float] = None  # Spacing used in y (meters)


# ==================== PLANT SESSION MANAGEMENT ====================
# Stateful session management for incremental plant growth simulation

import uuid
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

# Global storage for active plant sessions
_plant_sessions: Dict[str, Any] = {}
_session_lock = threading.Lock()


@dataclass
class PlantSession:
    """Holds an active pyhelios session for incremental plant growth"""
    session_id: str
    plant_type: str
    plant_id: int
    context: Any  # pyhelios Context
    plantarch: Any  # pyhelios PlantArchitecture
    current_age: float
    position: tuple  # (x, y, z)
    created_at: float  # timestamp


class PlantSessionCreateRequest(BaseModel):
    """Request to create a new plant session"""
    plant_type: str = "bean"
    initial_age: float = 1.0  # Start at age 1 day
    position_x: float = 0.0
    position_y: float = 0.0
    position_z: float = 0.0
    random_seed: Optional[int] = None


class PlantSessionCreateResponse(BaseModel):
    """Response after creating a plant session"""
    success: bool
    session_id: Optional[str] = None
    plant_type: str
    current_age: float
    height: Optional[float] = None
    helios_xml: Optional[str] = None
    error: Optional[str] = None


class PlantSessionAdvanceRequest(BaseModel):
    """Request to advance time on a plant session"""
    dt: float = 1.0  # Days to advance (must be >= 0)


class PlantSessionAdvanceResponse(BaseModel):
    """Response after advancing plant time, includes updated geometry"""
    success: bool
    session_id: str
    previous_age: float
    current_age: float
    height: Optional[float] = None
    # Geometry data
    vertices: List[List[float]]
    indices: List[List[int]]
    colors: Optional[List[List[float]]] = None
    # Texture data (Helios real UVs, V-flipped) — lets the textured renderer
    # show leaf/bark textures for session-generated plants too.
    normals: Optional[List[List[float]]] = None
    uv_coordinates: Optional[List[List[float]]] = None
    materials: Optional[List[PlantMaterial]] = None
    material_groups: Optional[List[PlantMaterialGroup]] = None
    textures: Optional[Dict[str, str]] = None
    vertex_count: int
    triangle_count: int
    error: Optional[str] = None


class PlantSessionStatusResponse(BaseModel):
    """Status of a plant session"""
    success: bool
    session_id: str
    plant_type: str
    current_age: float
    height: Optional[float] = None
    error: Optional[str] = None


@app.get("/api/plant/models")
async def get_available_plant_models():
    """Get list of available plant models from pyhelios library"""
    try:
        from pyhelios import Context, PlantArchitecture

        with Context() as context:
            with PlantArchitecture(context) as plantarch:
                models = plantarch.getAvailablePlantModels()
                return {"success": True, "models": models}
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to get plant models: {str(e)}")


# ==================== PLANT SESSION ENDPOINTS ====================

def _extract_session_geometry(session: PlantSession) -> tuple:
    """
    Extract geometry from an active plant session.

    Returns (vertices, indices, colors, vertex_count, triangle_count, textures)
    where `textures` is a dict with the optional texture payload:
      {"normals", "uvs", "materials", "material_groups", "textures"}
    UVs are Helios's real per-vertex coordinates, V-flipped for three.js — the
    same convention as /api/plant/generate, so the textured renderer handles
    plants from either path identically.
    """
    import os
    import base64

    context = session.context
    plantarch = session.plantarch

    # Woody species get brown stems
    WOODY_SPECIES = {
        'almond', 'apple', 'apple_fruitingwall', 'easternredbud', 'olive',
        'pistachio', 'walnut', 'bougainvillea', 'grapevine_VSP', 'grapevine_Wye',
        'grapevine_GDC', 'grapevine_geneva_double_curtain', 'grapevine_vertical_shoot_positioned',
        'grapevine_sprawl', 'grapevine_unilateral_cordon'
    }
    is_woody = session.plant_type in WOODY_SPECIES

    # Extract geometry by object
    object_ids = context.getAllObjectIDs()

    vertices = []
    colors = []
    normals = []
    uvs = []
    faces = []
    vertex_index = 0
    triangle_index = 0

    materials_dict = {}        # mat_label -> PlantMaterial
    material_groups_dict = {}  # mat_label -> [triangle index, ...]
    texture_files = {}         # texture basename -> source path

    for obj_id in object_ids:
        try:
            prim_infos = context.getPrimitivesInfoForObject(obj_id)
        except:
            continue

        if not prim_infos:
            continue

        # Check first primitive for material/texture info
        first_prim = prim_infos[0]
        try:
            mat_label = context.getPrimitiveMaterialLabel(first_prim.uuid)
            texture_path = context.getMaterialTexture(mat_label) if mat_label else None
        except:
            mat_label = None
            texture_path = None

        is_textured = texture_path and len(texture_path) > 0
        texture_name_lower = texture_path.lower() if texture_path else ""
        is_leaf_texture = 'leaf' in texture_name_lower or 'Leaf' in (texture_path or "")

        if is_textured:
            texture_name = os.path.basename(texture_path)
            if mat_label not in materials_dict:
                materials_dict[mat_label] = PlantMaterial(
                    name=mat_label,
                    texture_name=texture_name,
                    has_alpha=True,
                )
                material_groups_dict[mat_label] = []
                texture_files[texture_name] = texture_path

        for prim_info in prim_infos:
            try:
                if prim_info.primitive_type.value != 1:
                    continue

                tri_verts = prim_info.vertices
                if len(tri_verts) != 3:
                    continue

                prim_color = prim_info.color
                color_rgb = [prim_color.r, prim_color.g, prim_color.b]

                # Color assignment logic (vertex-color fallback)
                if is_textured and (color_rgb[0] == 0 and color_rgb[1] == 0 and color_rgb[2] == 0):
                    if is_leaf_texture:
                        color_rgb = [0.3, 0.55, 0.2]
                    elif is_woody:
                        color_rgb = [0.45, 0.3, 0.15]
                    else:
                        color_rgb = [0.3, 0.55, 0.2]
                elif not is_textured and is_woody:
                    brightness = color_rgb[0] + color_rgb[1] + color_rgb[2]
                    if brightness < 0.5:
                        color_rgb = [0.45, 0.3, 0.15]

                prim_normal = prim_info.normal
                normal_xyz = [prim_normal.x, prim_normal.y, prim_normal.z]

                # Real Helios UVs (V-flipped). A textured primitive without UVs
                # falls back to vertex color and is left out of the group.
                prim_uvs = prim_info.texture_uv if is_textured else None
                tri_is_textured = (
                    is_textured and prim_uvs is not None and len(prim_uvs) == 3
                )

                face_indices = []
                for vi, v in enumerate(tri_verts):
                    vertices.append([v.x, v.y, v.z])
                    colors.append(color_rgb)
                    normals.append(normal_xyz)
                    if tri_is_textured:
                        uv = prim_uvs[vi]
                        uvs.append([uv.x, 1.0 - uv.y])
                    else:
                        uvs.append([0.0, 0.0])
                    face_indices.append(vertex_index)
                    vertex_index += 1

                faces.append(face_indices)

                if tri_is_textured and mat_label in material_groups_dict:
                    material_groups_dict[mat_label].append(triangle_index)

                triangle_index += 1
            except:
                continue

    # Load textures as base64.
    textures_data = {}
    for tex_name, tex_path in texture_files.items():
        if os.path.exists(tex_path):
            try:
                with open(tex_path, 'rb') as f:
                    textures_data[tex_name] = base64.b64encode(f.read()).decode('utf-8')
            except Exception:
                pass

    materials_list = list(materials_dict.values()) if materials_dict else None
    material_groups_list = [
        PlantMaterialGroup(material_name=name, triangle_indices=tris)
        for name, tris in material_groups_dict.items() if tris
    ] if material_groups_dict else None

    texture_payload = {
        "normals": normals if normals else None,
        "uvs": uvs if any(u != [0.0, 0.0] for u in uvs) else None,
        "materials": materials_list,
        "material_groups": material_groups_list,
        "textures": textures_data if textures_data else None,
    }

    return vertices, faces, colors, len(vertices), len(faces), texture_payload


@app.post("/api/plant/session/create", response_model=PlantSessionCreateResponse)
async def create_plant_session(request: PlantSessionCreateRequest):
    """
    Create a new plant session for incremental growth simulation.
    The session keeps the pyhelios context alive for efficient time stepping.
    """
    import time

    try:
        from pyhelios import Context, PlantArchitecture
        from pyhelios.wrappers.DataTypes import vec3

        # Create session ID
        session_id = str(uuid.uuid4())[:8]

        print(f"[Plant Session] Creating session {session_id}: type={request.plant_type}, initial_age={request.initial_age}")

        # Create context and plant architecture (NOT using 'with' - we keep them alive)
        context = Context()
        context.__enter__()

        plantarch = PlantArchitecture(context)
        plantarch.__enter__()

        # Get available models for validation
        available_models = plantarch.getAvailablePlantModels()

        if request.plant_type not in available_models:
            # Clean up on error
            plantarch.__exit__(None, None, None)
            context.__exit__(None, None, None)
            return PlantSessionCreateResponse(
                success=False,
                plant_type=request.plant_type,
                current_age=0,
                error=f"Unknown plant type '{request.plant_type}'"
            )

        # Load and build plant
        plantarch.loadPlantModelFromLibrary(request.plant_type)

        build_params = {}
        if request.random_seed is not None:
            build_params['random_seed'] = request.random_seed

        plant_id = plantarch.buildPlantInstanceFromLibrary(
            base_position=vec3(request.position_x, request.position_y, request.position_z),
            age=request.initial_age,
            build_parameters=build_params if build_params else None
        )

        height = plantarch.getPlantHeight(plant_id)
        current_age = plantarch.getPlantAge(plant_id)

        # Create and store session
        session = PlantSession(
            session_id=session_id,
            plant_type=request.plant_type,
            plant_id=plant_id,
            context=context,
            plantarch=plantarch,
            current_age=current_age,
            position=(request.position_x, request.position_y, request.position_z),
            created_at=time.time()
        )

        # Write plant structure XML for morph tool
        helios_xml = None
        try:
            import tempfile
            with tempfile.NamedTemporaryFile(suffix='.xml', delete=False) as tmp_xml:
                xml_path = tmp_xml.name
            plantarch.writePlantStructureXML(plant_id, xml_path)
            with open(xml_path, 'r') as f:
                helios_xml = f.read()
            import os
            os.unlink(xml_path)
        except Exception as xml_err:
            print(f"[Plant Session] Warning: failed to write XML: {xml_err}")

        with _session_lock:
            _plant_sessions[session_id] = session

        print(f"[Plant Session] Created session {session_id}: age={current_age:.1f}, height={height:.3f}m")

        return PlantSessionCreateResponse(
            success=True,
            session_id=session_id,
            plant_type=request.plant_type,
            current_age=current_age,
            height=height,
            helios_xml=helios_xml,
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return PlantSessionCreateResponse(
            success=False,
            plant_type=request.plant_type,
            current_age=0,
            error=str(e)
        )


@app.post("/api/plant/session/{session_id}/advance", response_model=PlantSessionAdvanceResponse)
async def advance_plant_session(session_id: str, request: PlantSessionAdvanceRequest):
    """
    Advance time for a plant session and return updated geometry.
    """
    try:
        with _session_lock:
            if session_id not in _plant_sessions:
                raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
            session = _plant_sessions[session_id]

        if request.dt < 0:
            raise HTTPException(status_code=400, detail="dt must be >= 0")

        previous_age = session.current_age

        # Advance time
        if request.dt > 0:
            session.plantarch.advanceTime(request.dt)

        # Get updated state
        current_age = session.plantarch.getPlantAge(session.plant_id)
        height = session.plantarch.getPlantHeight(session.plant_id)
        session.current_age = current_age

        # Extract geometry (+ real Helios UVs / materials / textures)
        vertices, faces, colors, vertex_count, triangle_count, tex = _extract_session_geometry(session)

        print(f"[Plant Session] Advanced {session_id}: {previous_age:.1f} -> {current_age:.1f} days, {vertex_count} vertices")

        return PlantSessionAdvanceResponse(
            success=True,
            session_id=session_id,
            previous_age=previous_age,
            current_age=current_age,
            height=height,
            vertices=vertices,
            indices=faces,
            colors=colors,
            normals=tex["normals"],
            uv_coordinates=tex["uvs"],
            materials=tex["materials"],
            material_groups=tex["material_groups"],
            textures=tex["textures"],
            vertex_count=vertex_count,
            triangle_count=triangle_count
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return PlantSessionAdvanceResponse(
            success=False,
            session_id=session_id,
            previous_age=0,
            current_age=0,
            vertices=[],
            indices=[],
            vertex_count=0,
            triangle_count=0,
            error=str(e)
        )


@app.get("/api/plant/session/{session_id}", response_model=PlantSessionStatusResponse)
async def get_plant_session_status(session_id: str):
    """Get the current status of a plant session."""
    try:
        with _session_lock:
            if session_id not in _plant_sessions:
                raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
            session = _plant_sessions[session_id]

        height = session.plantarch.getPlantHeight(session.plant_id)

        return PlantSessionStatusResponse(
            success=True,
            session_id=session_id,
            plant_type=session.plant_type,
            current_age=session.current_age,
            height=height
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return PlantSessionStatusResponse(
            success=False,
            session_id=session_id,
            plant_type="",
            current_age=0,
            error=str(e)
        )


@app.delete("/api/plant/session/{session_id}")
async def delete_plant_session(session_id: str):
    """Delete a plant session and free resources."""
    try:
        with _session_lock:
            if session_id not in _plant_sessions:
                raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
            session = _plant_sessions.pop(session_id)

        # Clean up pyhelios resources
        try:
            session.plantarch.__exit__(None, None, None)
            session.context.__exit__(None, None, None)
        except:
            pass

        print(f"[Plant Session] Deleted session {session_id}")

        return {"success": True, "session_id": session_id}

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/plant/sessions")
async def list_plant_sessions():
    """List all active plant sessions."""
    with _session_lock:
        sessions = []
        for sid, session in _plant_sessions.items():
            sessions.append({
                "session_id": sid,
                "plant_type": session.plant_type,
                "current_age": session.current_age,
                "created_at": session.created_at
            })
        return {"success": True, "sessions": sessions, "count": len(sessions)}


# ==================== PLANT MORPH ENDPOINTS ====================
# Uses the plant structure XML roundtrip: parse existing XML to extract
# per-phytomer parameters, allow tuning, then rebuild via readPlantStructureXML.


def _parse_plant_xml(xml_string: str) -> dict:
    """
    Parse a Helios plant structure XML string into a structured dict.
    Returns { plant_age, base_position, shoots: [...] } where each shoot
    has shoot_type_label and a list of phytomers with internode/petiole/leaf params.
    """
    import xml.etree.ElementTree as ET

    root = ET.fromstring(xml_string)
    plant = root.find('plant_instance')
    if plant is None:
        raise ValueError("No <plant_instance> found in XML")

    result = {
        "plant_age": float(plant.findtext('plant_age', '0').strip()),
        "base_position": plant.findtext('base_position', '0 0 0').strip(),
        "shoots": [],
    }

    for shoot_el in plant.findall('shoot'):
        shoot = {
            "shoot_id": int(shoot_el.get('ID', '-1')),
            "shoot_type_label": (shoot_el.findtext('shoot_type_label') or 'unknown').strip(),
            "parent_shoot_id": int((shoot_el.findtext('parent_shoot_ID') or '-1').strip()),
            "parent_node_index": int((shoot_el.findtext('parent_node_index') or '0').strip()),
            "parent_petiole_index": int((shoot_el.findtext('parent_petiole_index') or '0').strip()),
            "base_rotation": (shoot_el.findtext('base_rotation') or '0 0 0').strip(),
            "phytomers": [],
        }

        for phytomer_el in shoot_el.findall('phytomer'):
            internode_el = phytomer_el.find('internode')
            if internode_el is None:
                continue

            internode = {}
            for child in internode_el:
                if child.tag == 'petiole':
                    continue  # handled separately
                internode[child.tag] = child.text.strip() if child.text else ''

            petioles = []
            for petiole_el in internode_el.findall('petiole'):
                petiole = {}
                leaves = []
                for child in petiole_el:
                    if child.tag == 'leaf':
                        leaf = {}
                        for lc in child:
                            leaf[lc.tag] = lc.text.strip() if lc.text else ''
                        leaves.append(leaf)
                    else:
                        petiole[child.tag] = child.text.strip() if child.text else ''
                petiole['leaves'] = leaves
                petioles.append(petiole)

            shoot["phytomers"].append({
                "internode": internode,
                "petioles": petioles,
            })

        result["shoots"].append(shoot)

    return result


def _build_plant_xml(parsed: dict) -> str:
    """
    Rebuild a Helios plant structure XML string from a parsed dict.
    Inverse of _parse_plant_xml.
    """
    import xml.etree.ElementTree as ET

    root = ET.Element('helios')
    plant = ET.SubElement(root, 'plant_instance', ID='0')
    ET.SubElement(plant, 'base_position').text = f' {parsed["base_position"]} '
    ET.SubElement(plant, 'plant_age').text = f' {parsed["plant_age"]} '

    for shoot in parsed['shoots']:
        shoot_el = ET.SubElement(plant, 'shoot', ID=str(shoot['shoot_id']))
        ET.SubElement(shoot_el, 'shoot_type_label').text = f' {shoot["shoot_type_label"]} '
        ET.SubElement(shoot_el, 'parent_shoot_ID').text = f' {shoot["parent_shoot_id"]} '
        ET.SubElement(shoot_el, 'parent_node_index').text = f' {shoot["parent_node_index"]} '
        ET.SubElement(shoot_el, 'parent_petiole_index').text = f' {shoot["parent_petiole_index"]} '
        ET.SubElement(shoot_el, 'base_rotation').text = f' {shoot["base_rotation"]} '

        for phytomer in shoot['phytomers']:
            phytomer_el = ET.SubElement(shoot_el, 'phytomer')
            internode_el = ET.SubElement(phytomer_el, 'internode')

            for key, val in phytomer['internode'].items():
                ET.SubElement(internode_el, key).text = val

            for petiole in phytomer['petioles']:
                petiole_el = ET.SubElement(internode_el, 'petiole')
                for key, val in petiole.items():
                    if key == 'leaves':
                        for leaf in val:
                            leaf_el = ET.SubElement(petiole_el, 'leaf')
                            for lk, lv in leaf.items():
                                ET.SubElement(leaf_el, lk).text = lv
                    else:
                        ET.SubElement(petiole_el, key).text = val

    ET.indent(root, space='\t')
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding='unicode')


def _get_distribution_params(plant_type: str, xml_string: str) -> dict:
    """
    Extract distribution-level shoot parameters from the Helios plant model library.
    Creates a disposable context, loads the model, builds a minimal instance to register
    shoot types, then calls getCurrentShootParameters for each unique shoot type label
    found in the XML.

    Returns { shoot_type_label: { param_name: { distribution, parameters } | bool } }
    Falls back to {} on any failure.
    """
    try:
        import xml.etree.ElementTree as ET
        from pyhelios import Context, PlantArchitecture

        # Extract unique shoot type labels from the XML
        root = ET.fromstring(xml_string)
        plant = root.find('plant_instance')
        if plant is None:
            return {}

        labels = set()
        for shoot_el in plant.findall('shoot'):
            label = (shoot_el.findtext('shoot_type_label') or '').strip()
            if label:
                labels.add(label)

        if not labels:
            return {}

        # Create disposable context to query parameters
        context = Context()
        context.__enter__()
        plantarch = PlantArchitecture(context)
        plantarch.__enter__()

        try:
            plantarch.loadPlantModelFromLibrary(plant_type)

            # Build a minimal instance so shoot types get registered
            from pyhelios.wrappers.DataTypes import vec3
            plantarch.buildPlantInstanceFromLibrary(
                base_position=vec3(0, 0, 0),
                age=1
            )

            result = {}
            for label in sorted(labels):
                try:
                    params = plantarch.getCurrentShootParameters(label)
                    result[label] = params
                except Exception as e:
                    print(f"[Morph] Warning: getCurrentShootParameters('{label}') failed: {e}")
                    continue

            return result
        finally:
            plantarch.__exit__(None, None, None)
            context.__exit__(None, None, None)

    except Exception as e:
        print(f"[Morph] Warning: _get_distribution_params failed: {e}")
        return {}


class PlantMorphParseRequest(BaseModel):
    """Request to parse plant XML into editable parameters"""
    helios_xml: str
    plant_type: str

class PlantMorphParseResponse(BaseModel):
    """Parsed plant structure for the morph UI"""
    success: bool
    plant_type: str
    plant_age: float = 0
    base_position: str = "0 0 0"
    shoots: List[dict] = []
    distribution_params: Dict[str, dict] = {}
    error: Optional[str] = None

class PlantMorphRequest(BaseModel):
    """Request to morph/regrow a plant from modified XML"""
    plant_type: str
    helios_xml: str  # The modified plant structure XML
    error: Optional[str] = None

class PlantMorphResponse(BaseModel):
    """Response from POST morph"""
    success: bool
    session_id: Optional[str] = None
    vertices: List[List[float]] = []
    indices: List[List[int]] = []
    colors: Optional[List[List[float]]] = None
    # Texture data so a morphed plant stays textured.
    normals: Optional[List[List[float]]] = None
    uv_coordinates: Optional[List[List[float]]] = None
    materials: Optional[List[PlantMaterial]] = None
    material_groups: Optional[List[PlantMaterialGroup]] = None
    textures: Optional[Dict[str, str]] = None
    vertex_count: int = 0
    triangle_count: int = 0
    current_age: float = 0
    height: Optional[float] = None
    helios_xml: Optional[str] = None  # Updated XML from the rebuilt plant
    error: Optional[str] = None


@app.post("/api/plant/morph/parse", response_model=PlantMorphParseResponse)
async def parse_plant_morph_parameters(request: PlantMorphParseRequest):
    """Parse a plant structure XML string into editable parameters."""
    try:
        parsed = _parse_plant_xml(request.helios_xml)

        # Get distribution-level parameters (non-fatal)
        dist_params = {}
        try:
            dist_params = _get_distribution_params(request.plant_type, request.helios_xml)
        except Exception as dp_err:
            print(f"[Morph] Warning: distribution params extraction failed: {dp_err}")

        return PlantMorphParseResponse(
            success=True,
            plant_type=request.plant_type,
            plant_age=parsed['plant_age'],
            base_position=parsed['base_position'],
            shoots=parsed['shoots'],
            distribution_params=dist_params,
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        return PlantMorphParseResponse(
            success=False,
            plant_type=request.plant_type,
            error=str(e),
        )


@app.post("/api/plant/morph", response_model=PlantMorphResponse)
async def morph_plant(request: PlantMorphRequest):
    """Rebuild a plant from modified structure XML."""
    import time
    import tempfile
    import os

    try:
        from pyhelios import Context, PlantArchitecture

        session_id = str(uuid.uuid4())[:8]
        print(f"[Morph] Rebuilding plant {session_id}: type={request.plant_type}")

        context = Context()
        context.__enter__()
        plantarch = PlantArchitecture(context)
        plantarch.__enter__()

        # Load the plant model library so shoot types are defined
        plantarch.loadPlantModelFromLibrary(request.plant_type)

        # Write the modified XML to a temp file and read it back
        with tempfile.NamedTemporaryFile(suffix='.xml', delete=False, mode='w') as tmp:
            tmp.write(request.helios_xml)
            xml_path = tmp.name

        try:
            plant_ids = plantarch.readPlantStructureXML(xml_path)
        finally:
            os.unlink(xml_path)

        if not plant_ids:
            plantarch.__exit__(None, None, None)
            context.__exit__(None, None, None)
            return PlantMorphResponse(
                success=False,
                error="readPlantStructureXML returned no plant IDs"
            )

        plant_id = plant_ids[0]
        current_age = plantarch.getPlantAge(plant_id)
        height = plantarch.getPlantHeight(plant_id)

        # Parse base_position from the XML for session storage
        import xml.etree.ElementTree as ET
        xml_root = ET.fromstring(request.helios_xml)
        pos_text = (xml_root.find('plant_instance').findtext('base_position') or '0 0 0').strip()
        pos_parts = [float(x) for x in pos_text.split()]
        position = (pos_parts[0] if len(pos_parts) > 0 else 0,
                     pos_parts[1] if len(pos_parts) > 1 else 0,
                     pos_parts[2] if len(pos_parts) > 2 else 0)

        # Create session
        session = PlantSession(
            session_id=session_id,
            plant_type=request.plant_type,
            plant_id=plant_id,
            context=context,
            plantarch=plantarch,
            current_age=current_age,
            position=position,
            created_at=time.time()
        )

        # Extract geometry (+ real Helios UVs / materials / textures)
        vertices, faces, colors, vertex_count, triangle_count, tex = _extract_session_geometry(session)

        # Write new XML from rebuilt plant (non-fatal if it fails)
        new_helios_xml = request.helios_xml  # fallback to input XML
        try:
            with tempfile.NamedTemporaryFile(suffix='.xml', delete=False, mode='r') as tmp:
                new_xml_path = tmp.name
            plantarch.writePlantStructureXML(plant_id, new_xml_path)
            with open(new_xml_path, 'r') as f:
                new_helios_xml = f.read()
            os.unlink(new_xml_path)
        except Exception as xml_err:
            print(f"[Morph] Warning: failed to write new XML: {xml_err}")

        # Store session
        with _session_lock:
            _plant_sessions[session_id] = session

        print(f"[Morph] Rebuilt plant {session_id}: age={current_age:.1f}, height={height:.3f}m, {vertex_count} vertices")

        return PlantMorphResponse(
            success=True,
            session_id=session_id,
            vertices=vertices,
            indices=faces,
            colors=colors,
            normals=tex["normals"],
            uv_coordinates=tex["uvs"],
            materials=tex["materials"],
            material_groups=tex["material_groups"],
            textures=tex["textures"],
            vertex_count=vertex_count,
            triangle_count=triangle_count,
            current_age=current_age,
            height=height,
            helios_xml=new_helios_xml,
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            plantarch.__exit__(None, None, None)
            context.__exit__(None, None, None)
        except:
            pass
        return PlantMorphResponse(
            success=False,
            error=str(e),
        )


@app.post("/api/plant/generate", response_model=PlantGenerationResponse)
async def generate_plant_model(request: PlantGenerationRequest):
    """
    Generate a procedural plant model using pyhelios PlantArchitecture.

    Uses direct primitive extraction from pyhelios Context API to get valid geometry.
    Textured organs carry Helios's own per-vertex UV coordinates (V-flipped for
    three.js), so leaf textures sample the correct cell of the leaf atlas.
    """
    import tempfile
    import os

    # Woody species get brown stems, herbaceous species get green stems
    WOODY_SPECIES = {
        'almond', 'apple', 'apple_fruitingwall', 'easternredbud', 'olive',
        'pistachio', 'walnut', 'bougainvillea', 'grapevine_VSP', 'grapevine_Wye',
        'grapevine_GDC', 'grapevine_geneva_double_curtain', 'grapevine_vertical_shoot_positioned',
        'grapevine_sprawl', 'grapevine_unilateral_cordon'
    }

    try:
        from pyhelios import Context, PlantArchitecture
        from pyhelios.wrappers.DataTypes import vec3

        print(f"[Plant Generation] Starting: type={request.plant_type}, age={request.age}")
        is_woody = request.plant_type in WOODY_SPECIES

        # Create context and plant architecture
        with Context() as context:
            with PlantArchitecture(context) as plantarch:
                # Get available models for reference
                available_models = plantarch.getAvailablePlantModels()

                # Validate plant type
                if request.plant_type not in available_models:
                    return PlantGenerationResponse(
                        success=False,
                        vertices=[],
                        indices=[],
                        vertex_count=0,
                        triangle_count=0,
                        plant_type=request.plant_type,
                        age=request.age,
                        available_models=available_models,
                        error=f"Unknown plant type '{request.plant_type}'. Available: {', '.join(available_models[:10])}..."
                    )

                # Load plant model
                plantarch.loadPlantModelFromLibrary(request.plant_type)

                # Build plant instance with optional build_parameters
                build_params = {}
                if request.random_seed is not None:
                    build_params['random_seed'] = request.random_seed
                    print(f"[Plant Generation] Using random_seed={request.random_seed} for reproducibility")

                plant_id = plantarch.buildPlantInstanceFromLibrary(
                    base_position=vec3(request.position_x, request.position_y, request.position_z),
                    age=request.age,
                    build_parameters=build_params if build_params else None
                )

                # Get plant height
                height = plantarch.getPlantHeight(plant_id)
                print(f"[Plant Generation] Built plant: type={request.plant_type}, age={request.age}, height={height:.3f}m, seed={request.random_seed}")

                # Extract geometry by object to properly handle textures
                # Each object represents a leaf or stem section
                object_ids = context.getAllObjectIDs()
                print(f"[Plant Generation] Extracting {len(object_ids)} objects...")

                # Build mesh data
                vertices = []  # Flat list of vertex positions
                colors = []    # Per-vertex colors (RGB 0-1)
                normals = []   # Per-vertex normals
                uvs = []       # Per-vertex UV coordinates (for textured objects)
                faces = []     # Triangle indices (for compatibility)

                # Track materials and their triangles
                materials_dict = {}  # material_name -> PlantMaterial
                material_groups_dict = {}  # material_name -> list of triangle indices
                texture_files = {}  # texture_name -> file_path

                vertex_index = 0
                triangle_index = 0

                for obj_id in object_ids:
                    # Get all primitive info for this object directly
                    try:
                        prim_infos = context.getPrimitivesInfoForObject(obj_id)
                    except:
                        continue

                    if not prim_infos:
                        continue

                    # Check first primitive for material/texture info
                    first_prim = prim_infos[0]
                    try:
                        mat_label = context.getPrimitiveMaterialLabel(first_prim.uuid)
                        texture_path = context.getMaterialTexture(mat_label) if mat_label else None
                    except:
                        mat_label = None
                        texture_path = None

                    # Determine if this object is textured
                    is_textured = texture_path and len(texture_path) > 0

                    # For woody species, determine if texture is for leaves vs bark/branches
                    texture_name_lower = texture_path.lower() if texture_path else ""
                    is_leaf_texture = 'leaf' in texture_name_lower or 'Leaf' in (texture_path or "")

                    # Collect all vertices for this object first (for UV computation)
                    object_vertices = []
                    object_triangles = []  # List of (prim_info, tri_verts)

                    for prim_info in prim_infos:
                        try:
                            # Only process triangles (primitive_type value 1)
                            if prim_info.primitive_type.value != 1:
                                continue

                            tri_verts = prim_info.vertices
                            if len(tri_verts) != 3:
                                continue

                            object_triangles.append((prim_info, tri_verts))
                            for v in tri_verts:
                                object_vertices.append([v.x, v.y, v.z])
                        except:
                            continue

                    if not object_triangles:
                        continue

                    # Track the material for textured objects. UVs come straight
                    # from Helios per-primitive (prim_info.texture_uv) — NOT a
                    # PCA projection — so each leaf samples the correct cell of
                    # the leaf texture atlas. They are V-flipped per triangle
                    # below for three.js (which expects V increasing upward).
                    if is_textured:
                        texture_name = os.path.basename(texture_path)

                        # Track material
                        if mat_label not in materials_dict:
                            materials_dict[mat_label] = PlantMaterial(
                                name=mat_label,
                                texture_name=texture_name,
                                has_alpha=True  # Leaf textures use alpha
                            )
                            material_groups_dict[mat_label] = []
                            texture_files[texture_name] = texture_path

                    # Add triangles to main mesh
                    for prim_info, tri_verts in object_triangles:
                        # Get color (RGBcolor has r, g, b attributes)
                        prim_color = prim_info.color
                        color_rgb = [prim_color.r, prim_color.g, prim_color.b]

                        # Vertex-color fallback. Textured organs render their
                        # real texture RGB, so these fixups only matter for the
                        # untextured fallback path (e.g. a textured leaf whose
                        # primitive lacked UVs, or non-textured stems/flowers).

                        if is_textured and (color_rgb[0] == 0 and color_rgb[1] == 0 and color_rgb[2] == 0):
                            # Textured objects often have black [0,0,0] colors from Helios
                            if is_leaf_texture:
                                # Leaf textures → green
                                color_rgb = [0.3, 0.55, 0.2]
                            elif is_woody:
                                # Bark/branch textures on woody species → brown
                                color_rgb = [0.45, 0.3, 0.15]
                            else:
                                # Default to green for other textured parts
                                color_rgb = [0.3, 0.55, 0.2]

                        elif not is_textured and is_woody:
                            # Non-textured parts on woody species
                            # Check brightness to distinguish stems (dark) from flowers (bright)
                            brightness = color_rgb[0] + color_rgb[1] + color_rgb[2]
                            if brightness < 0.5:
                                # Dark colors = stems/branches → brown
                                color_rgb = [0.45, 0.3, 0.15]
                            # else: keep original color (likely flowers)

                        # Get normal (vec3)
                        prim_normal = prim_info.normal
                        normal_xyz = [prim_normal.x, prim_normal.y, prim_normal.z]

                        # Real Helios UVs for this triangle, aligned to its
                        # vertices. A primitive may carry a texture file yet have
                        # no UVs (e.g. a flat-colored organ that shares a
                        # material); in that case fall back to degenerate UVs and
                        # don't add it to the textured material group, so it
                        # renders via vertex color instead of smearing the atlas.
                        prim_uvs = prim_info.texture_uv if is_textured else None
                        tri_is_textured = (
                            is_textured
                            and prim_uvs is not None
                            and len(prim_uvs) == 3
                        )

                        # Add vertices, colors, normals, and UVs for this triangle
                        tri_indices = []
                        for vi, v in enumerate(tri_verts):
                            vertices.append([v.x, v.y, v.z])
                            colors.append(color_rgb)
                            normals.append(normal_xyz)

                            if tri_is_textured:
                                uv = prim_uvs[vi]
                                # V-flip for three.js (flipY=false on the frontend)
                                uvs.append([uv.x, 1.0 - uv.y])
                            else:
                                uvs.append([0.0, 0.0])

                            tri_indices.append(vertex_index)
                            vertex_index += 1

                        faces.append(tri_indices)

                        # Track which material this triangle uses (only when it
                        # actually has texture coordinates to sample with)
                        if tri_is_textured and mat_label in material_groups_dict:
                            material_groups_dict[mat_label].append(triangle_index)

                        triangle_index += 1

                # Load texture files as base64
                import base64
                textures_data = {}
                for tex_name, tex_path in texture_files.items():
                    if os.path.exists(tex_path):
                        try:
                            with open(tex_path, 'rb') as f:
                                textures_data[tex_name] = base64.b64encode(f.read()).decode('utf-8')
                            print(f"[Plant Generation] Loaded texture: {tex_name}")
                        except Exception as e:
                            print(f"[Plant Generation] Failed to load texture {tex_name}: {e}")

                # Build response data structures
                materials_list = list(materials_dict.values()) if materials_dict else None
                material_groups_list = [
                    PlantMaterialGroup(material_name=mat_name, triangle_indices=tri_indices)
                    for mat_name, tri_indices in material_groups_dict.items()
                    if tri_indices
                ] if material_groups_dict else None

                print(f"[Plant Generation] Extracted {len(vertices)} vertices, {len(faces)} triangles")
                print(f"[Plant Generation] Found {len(materials_dict)} textured materials, {len(textures_data)} textures loaded")

                # Generate Helios plant structure XML
                with tempfile.NamedTemporaryFile(suffix='.xml', delete=False) as tmp_xml:
                    xml_path = tmp_xml.name

                plantarch.writePlantStructureXML(plant_id, xml_path)

                with open(xml_path, 'r') as f:
                    helios_xml = f.read()

                os.unlink(xml_path)

                print(f"[Plant Generation] Complete: {len(vertices)} vertices, {len(faces)} triangles")

                return PlantGenerationResponse(
                    success=True,
                    vertices=vertices,
                    indices=faces,
                    normals=normals,
                    colors=colors,  # Vertex colors for non-textured parts
                    uv_coordinates=uvs if uvs else None,
                    materials=materials_list,
                    material_groups=material_groups_list,
                    textures=textures_data if textures_data else None,
                    vertex_count=len(vertices),
                    triangle_count=len(faces),
                    plant_type=request.plant_type,
                    age=request.age,
                    height=height,
                    available_models=available_models,
                    helios_xml=helios_xml
                )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Plant generation failed: {str(e)}")


# Woody species get brown stems, herbaceous species get green stems. Shared by
# the single-plant and canopy generation paths.
_WOODY_SPECIES = {
    'almond', 'apple', 'apple_fruitingwall', 'easternredbud', 'olive',
    'pistachio', 'walnut', 'bougainvillea', 'grapevine_VSP', 'grapevine_Wye',
    'grapevine_GDC', 'grapevine_geneva_double_curtain', 'grapevine_vertical_shoot_positioned',
    'grapevine_sprawl', 'grapevine_unilateral_cordon'
}


def _extract_context_plant_geometry(context, is_woody: bool, progress_cb=None) -> tuple:
    """
    Extract merged plant geometry from every object in a pyhelios Context.

    Walks context.getAllObjectIDs(), so a canopy of N plants (all added to the
    same context) comes back as one merged mesh. UVs are Helios's real
    per-vertex coordinates, V-flipped for three.js — identical convention to
    /api/plant/generate and _extract_session_geometry.

    If progress_cb is given, it is called with a fraction in [0, 1] as objects
    are processed, so a streaming caller can report extraction progress.

    Returns (vertices, faces, colors, normals, uvs, materials_list,
             material_groups_list, textures_data).
    """
    import os
    import base64

    object_ids = context.getAllObjectIDs()
    total_objects = len(object_ids) or 1

    vertices = []
    colors = []
    normals = []
    uvs = []
    faces = []
    vertex_index = 0
    triangle_index = 0

    materials_dict = {}        # mat_label -> PlantMaterial
    material_groups_dict = {}  # mat_label -> [triangle index, ...]
    texture_files = {}         # texture basename -> source path

    for obj_idx, obj_id in enumerate(object_ids):
        if progress_cb is not None and (obj_idx % 64 == 0):
            progress_cb(obj_idx / total_objects)
        try:
            prim_infos = context.getPrimitivesInfoForObject(obj_id)
        except Exception:
            continue

        if not prim_infos:
            continue

        first_prim = prim_infos[0]
        try:
            mat_label = context.getPrimitiveMaterialLabel(first_prim.uuid)
            texture_path = context.getMaterialTexture(mat_label) if mat_label else None
        except Exception:
            mat_label = None
            texture_path = None

        is_textured = texture_path and len(texture_path) > 0
        texture_name_lower = texture_path.lower() if texture_path else ""
        is_leaf_texture = 'leaf' in texture_name_lower or 'Leaf' in (texture_path or "")

        if is_textured:
            texture_name = os.path.basename(texture_path)
            if mat_label not in materials_dict:
                materials_dict[mat_label] = PlantMaterial(
                    name=mat_label,
                    texture_name=texture_name,
                    has_alpha=True,
                )
                material_groups_dict[mat_label] = []
                texture_files[texture_name] = texture_path

        for prim_info in prim_infos:
            try:
                if prim_info.primitive_type.value != 1:
                    continue

                tri_verts = prim_info.vertices
                if len(tri_verts) != 3:
                    continue

                prim_color = prim_info.color
                color_rgb = [prim_color.r, prim_color.g, prim_color.b]

                # Vertex-color fallback (matches /api/plant/generate).
                if is_textured and (color_rgb[0] == 0 and color_rgb[1] == 0 and color_rgb[2] == 0):
                    if is_leaf_texture:
                        color_rgb = [0.3, 0.55, 0.2]
                    elif is_woody:
                        color_rgb = [0.45, 0.3, 0.15]
                    else:
                        color_rgb = [0.3, 0.55, 0.2]
                elif not is_textured and is_woody:
                    brightness = color_rgb[0] + color_rgb[1] + color_rgb[2]
                    if brightness < 0.5:
                        color_rgb = [0.45, 0.3, 0.15]

                prim_normal = prim_info.normal
                normal_xyz = [prim_normal.x, prim_normal.y, prim_normal.z]

                prim_uvs = prim_info.texture_uv if is_textured else None
                tri_is_textured = (
                    is_textured and prim_uvs is not None and len(prim_uvs) == 3
                )

                face_indices = []
                for vi, v in enumerate(tri_verts):
                    vertices.append([v.x, v.y, v.z])
                    colors.append(color_rgb)
                    normals.append(normal_xyz)
                    if tri_is_textured:
                        uv = prim_uvs[vi]
                        uvs.append([uv.x, 1.0 - uv.y])
                    else:
                        uvs.append([0.0, 0.0])
                    face_indices.append(vertex_index)
                    vertex_index += 1

                faces.append(face_indices)

                if tri_is_textured and mat_label in material_groups_dict:
                    material_groups_dict[mat_label].append(triangle_index)

                triangle_index += 1
            except Exception:
                continue

    textures_data = {}
    for tex_name, tex_path in texture_files.items():
        if os.path.exists(tex_path):
            try:
                with open(tex_path, 'rb') as f:
                    textures_data[tex_name] = base64.b64encode(f.read()).decode('utf-8')
            except Exception:
                pass

    if progress_cb is not None:
        progress_cb(1.0)

    materials_list = list(materials_dict.values()) if materials_dict else None
    material_groups_list = [
        PlantMaterialGroup(material_name=name, triangle_indices=tris)
        for name, tris in material_groups_dict.items() if tris
    ] if material_groups_dict else None

    return (
        vertices, faces, colors, normals, uvs,
        materials_list, material_groups_list, textures_data,
    )


@app.post("/api/plant/canopy/generate", response_model=PlantGenerationResponse)
async def generate_plant_canopy(request: PlantCanopyRequest):
    """
    Generate a canopy of regularly spaced plants using pyhelios PlantArchitecture.

    Builds a grid of `count_x` x `count_y` plants of the same species, spaced by
    `spacing_x` / `spacing_y` meters and centered on the canopy center. All plants
    are added to a single context and returned as one merged mesh, matching the
    single-plant /api/plant/generate response shape so the renderer is identical.
    """
    try:
        from pyhelios import Context, PlantArchitecture
        from pyhelios.wrappers.DataTypes import vec3, vec2, int2

        # Validate canopy parameters with actionable errors.
        if request.count_x <= 0 or request.count_y <= 0:
            return PlantGenerationResponse(
                success=False, vertices=[], indices=[], vertex_count=0,
                triangle_count=0, plant_type=request.plant_type, age=request.age,
                error=f"Plant counts must be positive (got {request.count_x} x {request.count_y}).",
            )
        if request.age < 0:
            return PlantGenerationResponse(
                success=False, vertices=[], indices=[], vertex_count=0,
                triangle_count=0, plant_type=request.plant_type, age=request.age,
                error=f"Age must be non-negative (got {request.age}).",
            )
        if not (0.0 <= request.germination_rate <= 1.0):
            return PlantGenerationResponse(
                success=False, vertices=[], indices=[], vertex_count=0,
                triangle_count=0, plant_type=request.plant_type, age=request.age,
                error=f"Germination rate must be between 0 and 1 (got {request.germination_rate}).",
            )

        print(f"[Plant Canopy] Starting: type={request.plant_type}, age={request.age}, "
              f"grid={request.count_x}x{request.count_y}, spacing=({request.spacing_x},{request.spacing_y}), "
              f"germination={request.germination_rate}")
        is_woody = request.plant_type in _WOODY_SPECIES

        with Context() as context:
            with PlantArchitecture(context) as plantarch:
                available_models = plantarch.getAvailablePlantModels()

                if request.plant_type not in available_models:
                    return PlantGenerationResponse(
                        success=False, vertices=[], indices=[], vertex_count=0,
                        triangle_count=0, plant_type=request.plant_type, age=request.age,
                        available_models=available_models,
                        error=f"Unknown plant type '{request.plant_type}'. Available: {', '.join(available_models[:10])}...",
                    )

                plantarch.loadPlantModelFromLibrary(request.plant_type)

                build_params = {}
                if request.random_seed is not None:
                    build_params['random_seed'] = request.random_seed

                plant_ids = plantarch.buildPlantCanopyFromLibrary(
                    canopy_center=vec3(request.center_x, request.center_y, request.center_z),
                    plant_spacing=vec2(request.spacing_x, request.spacing_y),
                    plant_count=int2(request.count_x, request.count_y),
                    age=request.age,
                    germination_rate=request.germination_rate,
                    build_parameters=build_params if build_params else None,
                )

                if not plant_ids:
                    return PlantGenerationResponse(
                        success=False, vertices=[], indices=[], vertex_count=0,
                        triangle_count=0, plant_type=request.plant_type, age=request.age,
                        plant_count=0, count_x=request.count_x, count_y=request.count_y,
                        spacing_x=request.spacing_x, spacing_y=request.spacing_y,
                        error="No plants germinated. Try a higher germination rate.",
                    )

                # Report the first plant's height as a representative value.
                try:
                    height = plantarch.getPlantHeight(plant_ids[0])
                except Exception:
                    height = None

                print(f"[Plant Canopy] Built {len(plant_ids)} plants; extracting geometry...")

                (vertices, faces, colors, normals, uvs,
                 materials_list, material_groups_list, textures_data) = \
                    _extract_context_plant_geometry(context, is_woody)

                # XML export: a canopy is not a morph target, so write the first
                # plant's structure (representative) without failing the request.
                helios_xml = None
                try:
                    import tempfile
                    import os
                    with tempfile.NamedTemporaryFile(suffix='.xml', delete=False) as tmp_xml:
                        xml_path = tmp_xml.name
                    plantarch.writePlantStructureXML(plant_ids[0], xml_path)
                    with open(xml_path, 'r') as f:
                        helios_xml = f.read()
                    os.unlink(xml_path)
                except Exception as xml_err:
                    print(f"[Plant Canopy] Warning: failed to write XML: {xml_err}")

                print(f"[Plant Canopy] Complete: {len(plant_ids)} plants, "
                      f"{len(vertices)} vertices, {len(faces)} triangles")

                return PlantGenerationResponse(
                    success=True,
                    vertices=vertices,
                    indices=faces,
                    normals=normals if normals else None,
                    colors=colors,
                    uv_coordinates=uvs if uvs else None,
                    materials=materials_list,
                    material_groups=material_groups_list,
                    textures=textures_data if textures_data else None,
                    vertex_count=len(vertices),
                    triangle_count=len(faces),
                    plant_type=request.plant_type,
                    age=request.age,
                    height=height,
                    available_models=available_models,
                    helios_xml=helios_xml,
                    plant_count=len(plant_ids),
                    count_x=request.count_x,
                    count_y=request.count_y,
                    spacing_x=request.spacing_x,
                    spacing_y=request.spacing_y,
                )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Plant canopy generation failed: {str(e)}")


@app.post("/api/plant/generate/stream")
async def generate_plant_stream(request: PlantStreamRequest):
    """
    Generate a single plant or a canopy with Server-Sent Events progress.

    Emits:
      event: progress  data: {"progress": 0.0-1.0, "message": "..."}
      event: result    data: <PlantGenerationResponse-shaped JSON>
      event: error     data: {"detail": "..."}

    Progress maps the C++ growth phase to 0–0.6 (via setProgressCallback),
    geometry extraction to 0.6–0.95, and JSON serialization to the final 1.0.
    Single-plant builds create a retained session (echoed as session_id) so the
    age slider keeps working; canopies are stateless.
    """
    import asyncio
    import queue as _queue
    import time

    progress_queue: "_queue.Queue" = _queue.Queue()
    is_canopy = request.mode == "canopy"

    def _do():
        from pyhelios import Context, PlantArchitecture
        from pyhelios.wrappers.DataTypes import vec3, vec2, int2

        is_woody = request.plant_type in _WOODY_SPECIES

        # Validate canopy params up front (cheap, before any native work).
        if is_canopy:
            if request.count_x <= 0 or request.count_y <= 0:
                progress_queue.put(("error", "Plant counts must be positive."))
                return
            if not (0.0 <= request.germination_rate <= 1.0):
                progress_queue.put(("error", "Germination rate must be between 0 and 1."))
                return
        if request.age < 0:
            progress_queue.put(("error", "Age must be non-negative."))
            return

        # Single plants retain the context/plantarch in a session (no `with`);
        # canopies build inside a `with` and discard the context afterward.
        context = Context()
        context.__enter__()
        plantarch = PlantArchitecture(context)
        plantarch.__enter__()
        keep_session = False

        try:
            available_models = plantarch.getAvailablePlantModels()
            if request.plant_type not in available_models:
                progress_queue.put(("error", f"Unknown plant type '{request.plant_type}'."))
                return

            plantarch.loadPlantModelFromLibrary(request.plant_type)

            build_params = {}
            if request.random_seed is not None:
                build_params['random_seed'] = request.random_seed

            # Growth progress (C++ advanceTime) → 0–0.6. The callback fires on a
            # native thread; just enqueue, never touch the event loop here.
            def on_progress(progress: float, message: str):
                progress_queue.put(("progress", max(0.0, min(progress, 1.0)) * 0.6, "Growing plants..."))

            plantarch.setProgressCallback(on_progress)
            progress_queue.put(("progress", 0.0, "Growing plants..."))

            if is_canopy:
                plant_ids = plantarch.buildPlantCanopyFromLibrary(
                    canopy_center=vec3(request.center_x, request.center_y, request.center_z),
                    plant_spacing=vec2(request.spacing_x, request.spacing_y),
                    plant_count=int2(request.count_x, request.count_y),
                    age=request.age,
                    germination_rate=request.germination_rate,
                    build_parameters=build_params if build_params else None,
                )
                if not plant_ids:
                    progress_queue.put(("error", "No plants germinated. Try a higher germination rate."))
                    return
                primary_id = plant_ids[0]
            else:
                primary_id = plantarch.buildPlantInstanceFromLibrary(
                    base_position=vec3(request.position_x, request.position_y, request.position_z),
                    age=request.age,
                    build_parameters=build_params if build_params else None,
                )
                plant_ids = [primary_id]

            plantarch.setProgressCallback(None)

            try:
                height = plantarch.getPlantHeight(primary_id)
            except Exception:
                height = None

            # Geometry extraction → 0.6–0.95.
            def extract_progress(frac: float):
                progress_queue.put(("progress", 0.6 + max(0.0, min(frac, 1.0)) * 0.35, "Packing geometry..."))

            (vertices, faces, colors, normals, uvs,
             materials_list, material_groups_list, textures_data) = \
                _extract_context_plant_geometry(context, is_woody, progress_cb=extract_progress)

            # Plant structure XML (first/only plant).
            helios_xml = None
            try:
                import tempfile
                import os as _os2
                with tempfile.NamedTemporaryFile(suffix='.xml', delete=False) as tmp_xml:
                    xml_path = tmp_xml.name
                plantarch.writePlantStructureXML(primary_id, xml_path)
                with open(xml_path, 'r') as f:
                    helios_xml = f.read()
                _os2.unlink(xml_path)
            except Exception as xml_err:
                print(f"[Plant Stream] Warning: failed to write XML: {xml_err}")

            result = {
                "success": True,
                "vertices": vertices,
                "indices": faces,
                "normals": normals if normals else None,
                "colors": colors,
                "uv_coordinates": uvs if uvs else None,
                "materials": [m.model_dump() for m in materials_list] if materials_list else None,
                "material_groups": [g.model_dump() for g in material_groups_list] if material_groups_list else None,
                "textures": textures_data if textures_data else None,
                "vertex_count": len(vertices),
                "triangle_count": len(faces),
                "plant_type": request.plant_type,
                "age": request.age,
                "height": height,
                "available_models": available_models,
                "helios_xml": helios_xml,
            }

            if is_canopy:
                result.update({
                    "plant_count": len(plant_ids),
                    "count_x": request.count_x,
                    "count_y": request.count_y,
                    "spacing_x": request.spacing_x,
                    "spacing_y": request.spacing_y,
                })
            else:
                # Retain the session for age scrubbing (same shape as
                # create_plant_session). Reuse the plant_type's current age.
                session_id = str(uuid.uuid4())[:8]
                current_age = plantarch.getPlantAge(primary_id)
                session = PlantSession(
                    session_id=session_id,
                    plant_type=request.plant_type,
                    plant_id=primary_id,
                    context=context,
                    plantarch=plantarch,
                    current_age=current_age,
                    position=(request.position_x, request.position_y, request.position_z),
                    created_at=time.time(),
                )
                with _session_lock:
                    _plant_sessions[session_id] = session
                result["session_id"] = session_id
                result["age"] = current_age
                keep_session = True

            # Serialize here, in the worker thread — for a large canopy this is
            # the single most expensive uninstrumented step (millions of floats).
            # Doing it in the SSE generator instead would freeze the bar at the
            # last progress value while the event loop blocks on json.dumps.
            progress_queue.put(("progress", 0.97, "Finalizing..."))
            result_json = json.dumps(result)
            progress_queue.put(("done", result_json))
        except Exception as e:
            import traceback
            traceback.print_exc()
            progress_queue.put(("error", str(e)))
        finally:
            try:
                plantarch.setProgressCallback(None)
            except Exception:
                pass
            # Tear down pyhelios resources unless a session owns them now.
            if not keep_session:
                try:
                    plantarch.__exit__(None, None, None)
                    context.__exit__(None, None, None)
                except Exception:
                    pass

    async def event_generator():
        loop = asyncio.get_event_loop()
        task = loop.run_in_executor(None, _do)

        while True:
            try:
                item = await asyncio.to_thread(progress_queue.get, True, 0.25)
            except _queue.Empty:
                if task.done():
                    exc = task.exception()
                    if exc:
                        yield f"event: error\ndata: {json.dumps({'detail': str(exc)})}\n\n"
                    break
                continue

            kind = item[0]
            if kind == "progress":
                _, progress_val, message = item
                yield f"event: progress\ndata: {json.dumps({'progress': progress_val, 'message': message})}\n\n"
            elif kind == "done":
                # item[1] is already-serialized JSON (built in the worker thread).
                yield f"event: result\ndata: {item[1]}\n\n"
                break
            elif kind == "error":
                yield f"event: error\ndata: {json.dumps({'detail': item[1]})}\n\n"
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ==================== TEXTURED MESH IMPORT (OBJ + MTL) ====================
# Parses an OBJ (with its sibling MTL and texture images) from a disk path and
# returns geometry + real per-vertex UVs + base64 textures, in the same shape
# the renderer already consumes for plant models (so the same textured renderer
# handles both). Triangles are emitted non-indexed (3 vertices each), matching
# the plant path's expanded-geometry convention.

class MeshImportRequest(BaseModel):
    """Request to import a textured mesh from a file on disk."""
    path: str  # Absolute path to the .obj file


class MeshImportResponse(BaseModel):
    """Imported mesh geometry + textures (mirrors PlantGenerationResponse)."""
    success: bool
    vertices: List[List[float]] = []          # [[x, y, z], ...]
    indices: List[List[int]] = []             # [[v0, v1, v2], ...]
    normals: Optional[List[List[float]]] = None
    colors: Optional[List[List[float]]] = None        # per-vertex (from Kd)
    uv_coordinates: Optional[List[List[float]]] = None  # [[u, v], ...] V-flipped
    materials: Optional[List[PlantMaterial]] = None
    material_groups: Optional[List[PlantMaterialGroup]] = None
    textures: Optional[Dict[str, str]] = None         # {basename: base64 png/jpg}
    vertex_count: int = 0
    triangle_count: int = 0
    filename: Optional[str] = None
    has_textures: bool = False
    error: Optional[str] = None


def _parse_mtl(mtl_path: Path) -> Dict[str, dict]:
    """Parse a .mtl file into {material_name: {"Kd": [r,g,b], "map_Kd": str}}.

    `map_Kd` keeps the raw token as written in the MTL (may be relative); the
    caller resolves it against the MTL's directory."""
    materials: Dict[str, dict] = {}
    current = None
    try:
        with open(mtl_path, 'r', errors='ignore') as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                key = parts[0]
                if key == 'newmtl' and len(parts) >= 2:
                    current = parts[1]
                    materials[current] = {}
                elif current is None:
                    continue
                elif key == 'Kd' and len(parts) >= 4:
                    materials[current]['Kd'] = [float(parts[1]), float(parts[2]), float(parts[3])]
                elif key == 'map_Kd' and len(parts) >= 2:
                    # The texture path is the last token (skip any options like -s).
                    materials[current]['map_Kd'] = parts[-1]
    except FileNotFoundError:
        pass
    return materials


def _import_ply_mesh(ply_path: Path) -> MeshImportResponse:
    """Read a polygon-mesh PLY (ASCII or binary) into MeshImportResponse geometry.

    PLY is an ambiguous container — it may hold a point cloud (vertices only) or a
    polygon mesh (vertices + faces). The caller has already decided this is a mesh
    (the frontend sniffs the header for `element face`); here we require triangles
    and reject a vertices-only PLY. open3d's read_triangle_mesh transparently
    handles ascii / binary_little_endian / binary_big_endian. PLY meshes carry no
    MTL or textures, so the textured fields stay empty."""
    import open3d as o3d

    try:
        mesh = o3d.io.read_triangle_mesh(str(ply_path))
    except Exception as e:  # noqa: BLE001 - surface a clean 400
        raise HTTPException(status_code=400, detail=f"Failed to read PLY mesh: {e}")

    triangles = np.asarray(mesh.triangles)
    if triangles.size == 0:
        raise HTTPException(
            status_code=400,
            detail="No faces found in PLY mesh (file appears to be a point cloud).",
        )

    if not mesh.has_vertex_normals():
        mesh.compute_vertex_normals()

    vertices = np.asarray(mesh.vertices, dtype=float)
    normals = np.asarray(mesh.vertex_normals, dtype=float)
    colors_arr = np.asarray(mesh.vertex_colors, dtype=float)  # 0-1, per vertex

    out_colors = colors_arr.tolist() if colors_arr.shape[0] == vertices.shape[0] else None
    out_normals = normals.tolist() if normals.shape[0] == vertices.shape[0] else None

    return MeshImportResponse(
        success=True,
        vertices=vertices.tolist(),
        indices=triangles.tolist(),
        normals=out_normals,
        colors=out_colors,
        uv_coordinates=None,
        materials=None,
        material_groups=None,
        textures=None,
        vertex_count=int(vertices.shape[0]),
        triangle_count=int(triangles.shape[0]),
        filename=ply_path.name,
        has_textures=False,
    )


@app.post("/api/mesh/import", response_model=MeshImportResponse)
async def import_textured_mesh(request: MeshImportRequest):
    """Parse an OBJ (+ MTL + texture images) from disk into textured geometry."""
    import base64

    obj_path = Path(request.path)
    if not obj_path.is_file():
        raise HTTPException(status_code=404, detail=f"Mesh file not found: {request.path}")
    ext = obj_path.suffix.lower()
    if ext == '.ply':
        # PLY meshes carry no MTL/textures; open3d reads ASCII + binary directly.
        return _import_ply_mesh(obj_path)
    if ext != '.obj':
        raise HTTPException(status_code=400, detail="Only .obj and .ply files are supported for mesh import")

    base_dir = obj_path.parent

    # Pass 1: collect raw vertex / uv / normal tables and material library refs.
    positions: List[List[float]] = []   # v
    tex_coords: List[List[float]] = []  # vt
    vert_normals: List[List[float]] = []  # vn
    mtl_libs: List[str] = []

    # Expanded (non-indexed) output, grouped per active material.
    out_vertices: List[List[float]] = []
    out_normals: List[List[float]] = []
    out_uvs: List[List[float]] = []
    out_faces: List[List[int]] = []
    tri_material: List[Optional[str]] = []  # material name active for each triangle

    current_material: Optional[str] = None
    vertex_index = 0

    def _idx(token: str, table_len: int) -> Optional[int]:
        """Resolve an OBJ index token (1-based, negatives relative to end)."""
        if token == '' or token is None:
            return None
        i = int(token)
        if i < 0:
            return table_len + i
        return i - 1

    try:
        with open(obj_path, 'r', errors='ignore') as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                cmd = parts[0]
                if cmd == 'v' and len(parts) >= 4:
                    positions.append([float(parts[1]), float(parts[2]), float(parts[3])])
                elif cmd == 'vt' and len(parts) >= 3:
                    tex_coords.append([float(parts[1]), float(parts[2])])
                elif cmd == 'vn' and len(parts) >= 4:
                    vert_normals.append([float(parts[1]), float(parts[2]), float(parts[3])])
                elif cmd == 'mtllib' and len(parts) >= 2:
                    mtl_libs.append(' '.join(parts[1:]))
                elif cmd == 'usemtl' and len(parts) >= 2:
                    current_material = parts[1]
                elif cmd == 'f' and len(parts) >= 4:
                    # Resolve each corner to (pos, vt, vn) indices.
                    corners = []
                    for tok in parts[1:]:
                        comp = tok.split('/')
                        pi = _idx(comp[0], len(positions)) if len(comp) >= 1 else None
                        ti = _idx(comp[1], len(tex_coords)) if len(comp) >= 2 and comp[1] != '' else None
                        ni = _idx(comp[2], len(vert_normals)) if len(comp) >= 3 and comp[2] != '' else None
                        corners.append((pi, ti, ni))
                    # Fan-triangulate polygons.
                    for k in range(1, len(corners) - 1):
                        tri = [corners[0], corners[k], corners[k + 1]]
                        face_idx = []
                        for (pi, ti, ni) in tri:
                            if pi is None or pi < 0 or pi >= len(positions):
                                # Malformed corner; skip the whole triangle.
                                face_idx = []
                                break
                            out_vertices.append(positions[pi])
                            if ni is not None and 0 <= ni < len(vert_normals):
                                out_normals.append(vert_normals[ni])
                            else:
                                out_normals.append([0.0, 0.0, 0.0])  # filled below
                            if ti is not None and 0 <= ti < len(tex_coords):
                                u, v = tex_coords[ti]
                                out_uvs.append([u, 1.0 - v])  # V-flip for three.js
                            else:
                                out_uvs.append([0.0, 0.0])
                            face_idx.append(vertex_index)
                            vertex_index += 1
                        if not face_idx:
                            continue
                        out_faces.append(face_idx)
                        tri_material.append(current_material)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse OBJ: {e}")

    if not out_faces:
        raise HTTPException(status_code=400, detail="No triangles found in OBJ file")

    # Compute flat normals for any triangle that had no vn.
    has_any_normals = any(n != [0.0, 0.0, 0.0] for n in out_normals)
    for ti, face in enumerate(out_faces):
        if all(out_normals[i] == [0.0, 0.0, 0.0] for i in face):
            a = np.array(out_vertices[face[0]])
            b = np.array(out_vertices[face[1]])
            c = np.array(out_vertices[face[2]])
            n = np.cross(b - a, c - a)
            ln = np.linalg.norm(n)
            n = (n / ln).tolist() if ln > 1e-12 else [0.0, 0.0, 1.0]
            for i in face:
                out_normals[i] = n
            has_any_normals = True

    # Parse all referenced MTL files; first definition of a name wins.
    mtl_materials: Dict[str, dict] = {}
    for lib in mtl_libs:
        for name, props in _parse_mtl(base_dir / lib).items():
            mtl_materials.setdefault(name, props)

    # Load textures (resolved relative to the OBJ dir) as base64, keyed by basename.
    textures_data: Dict[str, str] = {}
    material_texture_name: Dict[str, str] = {}  # material -> texture basename
    for name, props in mtl_materials.items():
        tex_token = props.get('map_Kd')
        if not tex_token:
            continue
        tex_path = (base_dir / tex_token)
        if not tex_path.is_file():
            # Try just the basename in the OBJ directory.
            tex_path = base_dir / os.path.basename(tex_token)
        if tex_path.is_file():
            tex_name = tex_path.name
            material_texture_name[name] = tex_name
            if tex_name not in textures_data:
                try:
                    with open(tex_path, 'rb') as tf:
                        textures_data[tex_name] = base64.b64encode(tf.read()).decode('utf-8')
                except Exception:
                    pass

    # Build per-vertex colors from each triangle's material Kd (fallback grey).
    out_colors: List[List[float]] = [[0.8, 0.8, 0.8]] * len(out_vertices)
    for ti, face in enumerate(out_faces):
        mat = tri_material[ti]
        kd = mtl_materials.get(mat, {}).get('Kd') if mat else None
        if kd:
            for i in face:
                out_colors[i] = kd

    # Material groups: only for materials that actually have a loaded texture.
    materials_list: List[PlantMaterial] = []
    groups: Dict[str, List[int]] = {}
    for ti, mat in enumerate(tri_material):
        if mat and mat in material_texture_name and material_texture_name[mat] in textures_data:
            groups.setdefault(mat, []).append(ti)
    for mat, tri_indices in groups.items():
        tex_name = material_texture_name[mat]
        kd = mtl_materials.get(mat, {}).get('Kd')
        materials_list.append(PlantMaterial(
            name=mat,
            color=kd,
            texture_name=tex_name,
            has_alpha=tex_name.lower().endswith('.png'),  # assume PNG may carry alpha
        ))
    material_groups_list = [
        PlantMaterialGroup(material_name=mat, triangle_indices=tris)
        for mat, tris in groups.items()
    ]

    has_textures = bool(textures_data) and bool(material_groups_list)

    return MeshImportResponse(
        success=True,
        vertices=out_vertices,
        indices=out_faces,
        normals=out_normals if has_any_normals else None,
        colors=out_colors,
        uv_coordinates=out_uvs if has_textures else None,
        materials=materials_list or None,
        material_groups=material_groups_list or None,
        textures=textures_data or None,
        vertex_count=len(out_vertices),
        triangle_count=len(out_faces),
        filename=obj_path.name,
        has_textures=has_textures,
    )


# ==================== POINT CLOUD LAS/LAZ IMPORT/EXPORT ====================
# Uses laspy for reading and writing LAS/LAZ files with compression support

class PointCloudExportRequest(BaseModel):
    """Request for exporting a point cloud.

    Flat clouds send inline `points` (+ optional `colors`) and `format` in
    {"las","laz"}. Octree-backed clouds send `source` instead — and may request
    any of {"las","laz","xyz","txt","csv","ply"} since the renderer has no
    positions to format text from. The backend reads the source file, applies
    pending translation, and returns base64-encoded output in all cases.
    """
    points: Optional[List[List[float]]] = None  # [[x, y, z], ...]
    colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] in 0-1 range
    source: Optional[PointSource] = None         # octree-backed clouds read from disk
    format: str = "laz"  # las | laz | xyz | txt | csv | ply
    filename: Optional[str] = None  # Optional filename for the export


class PointCloudExportResponse(BaseModel):
    """Response containing the exported file data"""
    success: bool
    data: Optional[str] = None  # Base64-encoded file content
    filename: str
    point_count: int
    has_colors: bool
    format: str
    error: Optional[str] = None


class PointCloudImportResponse(BaseModel):
    """Response containing imported point cloud data"""
    success: bool
    points: Optional[List[List[float]]] = None  # [[x, y, z], ...]
    colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] in 0-1 range
    point_count: int = 0
    has_colors: bool = False
    filename: Optional[str] = None
    error: Optional[str] = None


def _format_points_as_text(
    fmt: str,
    points: np.ndarray,
    colors: Optional[np.ndarray],
    intensity: Optional[np.ndarray],
) -> str:
    """Format an (N,3) point array (+ optional 0-1 colors, intensity) as XYZ /
    TXT / CSV / PLY / OBJ text. Column conventions match the renderer's flat
    text export exactly: 6-decimal positions, colors as 0-255 ints, intensity
    4-decimal."""
    n = len(points)
    has_colors = colors is not None and len(colors) == n
    has_int = intensity is not None and len(intensity) == n
    rgb = np.clip(np.rint(colors * 255.0), 0, 255).astype(int) if has_colors else None

    lines: List[str] = []
    if fmt == "xyz":
        for i in range(n):
            lines.append(f"{points[i, 0]:.6f} {points[i, 1]:.6f} {points[i, 2]:.6f}")
    elif fmt in ("txt", "csv"):
        sep = "," if fmt == "csv" else " "
        head = ["X", "Y", "Z"]
        if has_colors:
            head += ["R", "G", "B"]
        if has_int:
            head += ["Intensity"]
        lines.append(sep.join(head))
        for i in range(n):
            cols = [f"{points[i, 0]:.6f}", f"{points[i, 1]:.6f}", f"{points[i, 2]:.6f}"]
            if has_colors:
                cols += [str(rgb[i, 0]), str(rgb[i, 1]), str(rgb[i, 2])]
            if has_int:
                cols += [f"{float(intensity[i]):.4f}"]
            lines.append(sep.join(cols))
    elif fmt == "ply":
        lines += ["ply", "format ascii 1.0", f"element vertex {n}",
                  "property float x", "property float y", "property float z"]
        if has_colors:
            lines += ["property uchar red", "property uchar green", "property uchar blue"]
        lines.append("end_header")
        for i in range(n):
            line = f"{points[i, 0]:.6f} {points[i, 1]:.6f} {points[i, 2]:.6f}"
            if has_colors:
                line += f" {rgb[i, 0]} {rgb[i, 1]} {rgb[i, 2]}"
            lines.append(line)
    elif fmt == "obj":
        lines += ["# Point cloud exported from Phytograph", f"# {n} points"]
        for i in range(n):
            lines.append(f"v {points[i, 0]:.6f} {points[i, 1]:.6f} {points[i, 2]:.6f}")
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported text export format: {fmt}")
    return "\n".join(lines)


@app.post("/api/pointcloud/export", response_model=PointCloudExportResponse)
async def export_point_cloud_las(request: PointCloudExportRequest):
    """
    Export a point cloud.

    Flat clouds export LAS/LAZ via laspy. Octree-backed clouds send a `source`
    descriptor and may export any of LAS/LAZ/XYZ/TXT/CSV/PLY/OBJ — the backend
    reads the source file (the renderer has no positions to format). Returns
    base64-encoded file data that can be downloaded on the frontend.
    """
    import tempfile
    import base64

    fmt = request.format.lower()

    # Octree-backed export: read points (+ colors/intensity) from the source
    # file, then dispatch by format. Text formats stream out here because the
    # renderer can't iterate an empty positions buffer.
    src_colors = None
    src_intensity = None
    if request.source is not None:
        src = request.source
        src.want_colors = True
        points, src_colors, src_intensity = _read_points_from_source(src)
        if fmt in ("xyz", "txt", "csv", "ply", "obj"):
            try:
                text = _format_points_as_text(fmt, points, src_colors, src_intensity)
            except HTTPException:
                raise
            except Exception as e:
                return PointCloudExportResponse(
                    success=False, data=None, filename="", point_count=0,
                    has_colors=False, format=request.format,
                    error=f"Export failed: {e}",
                )
            ext = "." + fmt
            filename = request.filename or f"pointcloud{ext}"
            if not filename.endswith(ext):
                filename = filename.rsplit(".", 1)[0] + ext
            return PointCloudExportResponse(
                success=True,
                data=base64.b64encode(text.encode("utf-8")).decode("utf-8"),
                filename=filename,
                point_count=int(len(points)),
                has_colors=src_colors is not None,
                format=request.format,
            )
        # LAS/LAZ fall through to the laspy path below using `points`/`src_colors`.

    try:
        import laspy
    except ImportError:
        return PointCloudExportResponse(
            success=False,
            data=None,
            filename="",
            point_count=0,
            has_colors=False,
            format=request.format,
            error="laspy library not installed. Run: pip install laspy[lazrs]"
        )

    try:
        if request.source is not None:
            # points already loaded above; colors come back as 0-1 (N,3) or None.
            has_colors = src_colors is not None and len(src_colors) > 0
            colors_arr = src_colors
        else:
            points = np.array(request.points or [])
            has_colors = request.colors is not None and len(request.colors) > 0
            colors_arr = np.array(request.colors) if has_colors else None

        if len(points) == 0:
            return PointCloudExportResponse(
                success=False,
                data=None,
                filename="",
                point_count=0,
                has_colors=False,
                format=request.format,
                error="No points provided"
            )

        # Choose point format: 0 = XYZ only, 2 = XYZ + RGB
        point_format = 2 if has_colors else 0

        # Create LAS header
        header = laspy.LasHeader(point_format=point_format, version="1.2")

        # Calculate offsets and scales for precision
        min_coords = points.min(axis=0)
        max_coords = points.max(axis=0)

        header.offsets = min_coords
        header.scales = [0.001, 0.001, 0.001]  # 1mm precision

        # Create LAS data
        las = laspy.LasData(header)
        las.x = points[:, 0]
        las.y = points[:, 1]
        las.z = points[:, 2]

        # Add colors if available (convert from 0-1 to 16-bit)
        if has_colors:
            # Ensure colors are in 0-1 range and convert to 16-bit
            colors = np.clip(np.asarray(colors_arr, dtype=np.float64), 0, 1)
            las.red = (colors[:, 0] * 65535).astype(np.uint16)
            las.green = (colors[:, 1] * 65535).astype(np.uint16)
            las.blue = (colors[:, 2] * 65535).astype(np.uint16)

        # Determine file extension
        ext = ".laz" if request.format.lower() == "laz" else ".las"
        filename = request.filename or f"pointcloud{ext}"
        if not filename.endswith(ext):
            filename = filename.rsplit('.', 1)[0] + ext

        # Write to temporary file
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp_path = tmp.name

        try:
            las.write(tmp_path)

            # Read back and encode as base64
            with open(tmp_path, 'rb') as f:
                file_data = base64.b64encode(f.read()).decode('utf-8')

            return PointCloudExportResponse(
                success=True,
                data=file_data,
                filename=filename,
                point_count=len(points),
                has_colors=has_colors,
                format=request.format
            )
        finally:
            import os
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return PointCloudExportResponse(
            success=False,
            data=None,
            filename="",
            point_count=0,
            has_colors=False,
            format=request.format,
            error=f"Export failed: {str(e)}"
        )


@app.post("/api/pointcloud/import", response_model=PointCloudImportResponse)
async def import_point_cloud_las(file: UploadFile = File(...)):
    """
    Import a LAS or LAZ file and return the point cloud data.

    Uses laspy with lazrs backend for LAZ decompression.
    Supports LAS 1.0-1.4 and all point formats.
    """
    import tempfile
    import os

    try:
        import laspy
    except ImportError:
        return PointCloudImportResponse(
            success=False,
            error="laspy library not installed. Run: pip install laspy[lazrs]"
        )

    try:
        # Get file extension
        filename = file.filename or "upload.las"
        ext = os.path.splitext(filename)[1].lower()

        if ext not in ['.las', '.laz']:
            return PointCloudImportResponse(
                success=False,
                error=f"Unsupported file format: {ext}. Expected .las or .laz"
            )

        # Save uploaded file to temp location
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            # Read LAS/LAZ file
            las = laspy.read(tmp_path)

            # Extract points (use scaled coordinates)
            points = np.column_stack([las.x, las.y, las.z])

            # Check for RGB colors
            colors = None
            has_colors = False

            # Point formats 2, 3, 5, 7, 8, 10 have RGB
            if hasattr(las, 'red') and hasattr(las, 'green') and hasattr(las, 'blue'):
                try:
                    red = np.array(las.red)
                    green = np.array(las.green)
                    blue = np.array(las.blue)

                    # Check if colors are actually set (not all zeros)
                    if red.max() > 0 or green.max() > 0 or blue.max() > 0:
                        # Convert from 16-bit to 0-1 range
                        colors = np.column_stack([
                            red / 65535.0,
                            green / 65535.0,
                            blue / 65535.0
                        ]).tolist()
                        has_colors = True
                except:
                    pass

            return PointCloudImportResponse(
                success=True,
                points=points.tolist(),
                colors=colors,
                point_count=len(points),
                has_colors=has_colors,
                filename=filename
            )

        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return PointCloudImportResponse(
            success=False,
            error=f"Import failed: {str(e)}"
        )


# ==================== POINT CLOUD PATH-BASED IMPORT ====================
# Reads point-cloud files directly from disk rather than over HTTP. The
# renderer's TS parsers (parseXYZ, parsePLY, parsePCD) all materialise the
# whole file as a JS string and hit V8's max string size (~512 MB) on
# multi-hundred-MB scans typical of TLS surveys. The endpoint here returns a
# packed binary stream so we don't re-trip the same limit on the response.

# Helios <ASCII_format> tokens we recognise for XYZ-family files. Roles in
# DATA_ROLES populate dedicated fields (positions/colours/intensity); the
# per-pulse multi-return roles (timestamp/target_index/target_count) are carried
# as extra dimensions under their canonical slug (see `_MULTI_RETURN_SLUGS`) so
# the LAD path can recover them; any remaining known-but-unmapped role
# (deviation, …) is carried as a generic extra so pandas stays column-aligned.
_XYZ_DATA_ROLES = {
    'x', 'y', 'z',
    'r', 'g', 'b',
    'r255', 'g255', 'b255',
    'intensity', 'reflectance',
}
# Canonical per-pulse slugs Helios's ASCII loader reads from each hit's data map
# to tell single- from multi-return scans (see `_LAD_MULTI_RETURN_COLUMNS`). We
# pin these as extra-dim slugs at import so they survive edits/bake exactly like
# positions and the LAD accessor can find them deterministically — regardless of
# the source header text or how the wizard labelled the column.
_MULTI_RETURN_SLUGS = ('timestamp', 'target_index', 'target_count')
_MULTI_RETURN_LABELS = {
    'timestamp': 'Timestamp',
    'target_index': 'Target Index',
    'target_count': 'Target Count',
}
# Structured-scan raster indices: the integer (row, column) position of each
# point within the scanner's rectangular acquisition grid. Carried as extra
# dimensions under these pinned slugs so the C++ grid-based direction recovery
# (LiDAR.cpp, for gap-filling unplaceable misses) finds the raster by name —
# exactly like the E57 structured-import path emits them (see `_e57_*`). Pinning
# the slug means an ASCII export with row/column columns round-trips into the
# same recovery machinery regardless of the source header text.
_GRID_INDEX_SLUGS = ('row_index', 'column_index')
_GRID_INDEX_LABELS = {
    'row_index': 'Row Index',
    'column_index': 'Column Index',
}
_XYZ_KNOWN_ROLES = (
    _XYZ_DATA_ROLES | set(_MULTI_RETURN_SLUGS) | set(_GRID_INDEX_SLUGS) | {'deviation'}
)

# Per-point sky/miss flag carried as a LAS extra dimension (0.0 = hit, 1.0 =
# miss). Misses are laser pulses that returned nothing (hit the sky); Helios
# represents each as a real point placed `_MISS_GAP_DISTANCE` metres from the
# scanner along the pulse direction. They flow through the same extra-dim →
# octree → session → LAD machinery as any scalar, so deletes/bake keep them in
# lockstep with positions, the renderer can colour/hide them, and the LAD path
# reads them for free. The slug is pinned (case-insensitive aliases accepted on
# import) so the renderer and LAD find it deterministically.
_MISS_SLUG = 'is_miss'
_MISS_LABEL = 'Miss'
# Aliases a source column may use for the miss flag (PLY property / E57 field).
_MISS_ALIASES = {'is_miss', 'miss', 'sky', 'ismiss'}
# Same set with punctuation/case stripped, for matching a sanitised slug.
_MISS_ALIASES_NORMALISED = {re.sub(r'[^a-z0-9]+', '', a) for a in _MISS_ALIASES}


def _normalise_miss_alias(name: str) -> Optional[str]:
    """Return `_MISS_SLUG` when `name` is any miss-flag spelling (is_miss / miss
    / sky, case- and punctuation-insensitive), else None."""
    base = re.sub(r'[^a-z0-9]+', '', name.strip().lower())
    return _MISS_SLUG if base in _MISS_ALIASES_NORMALISED else None
# Distance (metres) at which a miss point is placed from the scanner origin along
# its pulse direction. Matches Helios's gap_distance (LiDAR.cpp gapfillMisses).
_MISS_GAP_DISTANCE = 20000.0

# Magic bytes on the wire. Renderer aborts if it sees anything else, so the
# format is implicitly versioned by this value.
_POINTCLOUD_BIN_MAGIC = b'PHX1'

# Extensions dispatched to the pandas-based ASCII path. Anything in this set
# may be accompanied by a Helios `ascii_format` hint; PLY/PCD ignore it.
_PANDAS_EXTENSIONS = {'xyz', 'txt', 'csv', 'pts', 'asc'}
_OPEN3D_EXTENSIONS = {'ply', 'pcd'}


class ColumnPlanEntry(BaseModel):
    """One column's import mapping, produced by the import wizard.

    `role` is a Helios-style token (x/y/z/r255/g255/b255/r/g/b/intensity/
    reflectance/skip) or the literal 'extra' for a carried scalar field. For an
    'extra' column, `slug`/`label` give the on-disk LAS extra-dim name and the
    picker label (rename), and `categorical` marks it for discrete colouring in
    the renderer. `index` is the 0-based source column position.
    """
    index: int
    role: str
    slug: Optional[str] = None
    label: Optional[str] = None
    categorical: bool = False


class ColumnPlan(BaseModel):
    """Explicit column layout for an XYZ-family file, from the import wizard.

    When attached to an import/convert request it fully overrides header/format
    auto-detection. `rgb_is_255` records whether the r/g/b columns are 0-255
    integers (True) or already 0-1 floats (False) so the LAS writer scales them
    correctly. Applies only to ASCII formats; PLY/PCD/LAS define their own
    layout and ignore it.
    """
    columns: List[ColumnPlanEntry]
    rgb_is_255: bool = True


class ImportPointCloudByPathRequest(BaseModel):
    """Path-based point-cloud import.

    `ascii_format` is a Helios <ASCII_format> string (e.g.
    'x y z r255 g255 b255 reflectance') and applies only to XYZ-family
    extensions; PLY/PCD ignore it because their column layout is in-file.
    If omitted for an XYZ-family file, columns are sniffed from the first
    non-blank, non-comment row. `column_plan`, when present, fully overrides
    both — it's the explicit layout chosen in the import wizard.
    """
    file_path: str
    ascii_format: Optional[str] = None
    column_plan: Optional[ColumnPlan] = None


class PointCloudPreviewRequest(BaseModel):
    """Inspect a point-cloud file cheaply for the import wizard.

    Reads only the header + first `max_rows` data rows (ASCII) or the header +
    a few points (LAS/PLY/PCD) — never materialises the whole file. The optional
    `ascii_format` hint biases role detection the same way the import path does.
    """
    file_path: str
    ascii_format: Optional[str] = None
    max_rows: int = 20


class PreviewColumn(BaseModel):
    """One source column as the wizard should present it.

    `detected_role` is the auto-detected Helios role (or 'extra'/'skip');
    `suggested_slug`/`suggested_label` mirror what import would name a carried
    scalar (so the wizard's defaults match the eventual on-disk attribute).
    `type_hint` is a sniffed value shape (integer/float/categorical/empty) used
    to pre-tick the categorical checkbox. `remappable` is True only for ASCII
    formats — PLY/PCD/LAS define their own layout, so roles can't be reassigned.
    """
    index: int
    header_name: Optional[str] = None
    detected_role: str
    suggested_label: str
    suggested_slug: str
    type_hint: str
    remappable: bool


class PointCloudPreviewResponse(BaseModel):
    kind: str                       # ascii | ply | pcd | las
    delimiter: Optional[str] = None  # comma | whitespace | tab | semicolon | None
    has_header: bool
    columns: List[PreviewColumn]
    sample_rows: List[List[str]]
    warning: Optional[str] = None


def _tokenize_ascii_format(fmt: str) -> List[str]:
    return [tok.lower() if tok.lower() in _XYZ_KNOWN_ROLES else 'skip'
            for tok in fmt.split()]


def _first_nonblank_ascii_line(file_path: str) -> Optional[tuple]:
    """Return (line_text, was_commented) for the first meaningful line of an
    ASCII point file, or None if the file is empty/all-blank.

    `line_text` has any leading comment marker ('#' / '//') and surrounding
    whitespace stripped, so the caller can inspect a *commented* header the same
    way it would a bare one. Some exporters write the column legend as a comment
    (e.g. '# x y z r255 g255 b255 row column is_miss') so pandas — which is told
    comment='#' — skips it as data while a human still sees the labels. We
    recover those labels here. `was_commented` lets callers that drive pandas's
    `skiprows` know the line is already dropped by `comment='#'` and must NOT be
    counted again.
    """
    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            if line.startswith('#'):
                return line.lstrip('#').strip(), True
            if line.startswith('//'):
                return line[2:].strip(), True
            return line, False
    return None


def _role_from_header_name(name: str) -> Optional[str]:
    """Map a header column name to a known XYZ role, or None if unrecognised.

    Recognises the common terrestrial-scanner / Helios header conventions:
    'XYZ[0][m]'/'X' → x, 'Reflectance[dB]' → reflectance, 'Intensity' → intensity,
    'Red'/'R' → r255, etc. An unrecognised name returns None so the caller can
    carry it as an extra-dimension scalar (e.g. 'Deviation[]', 'Timestamp[s]').
    """
    # Indexed position headers: 'XYZ[0][m]' → x, 'XYZ[1]' → y, 'XYZ[2]' → z.
    m = re.match(r'\s*xyz\s*\[\s*([0-2])\s*\]', name.strip(), re.IGNORECASE)
    if m:
        return ('x', 'y', 'z')[int(m.group(1))]
    base = re.sub(r'\[.*?\]', '', name).strip().lower()
    base = re.sub(r'[^a-z0-9]+', '', base)
    if base in ('x', 'easting'):
        return 'x'
    if base in ('y', 'northing'):
        return 'y'
    if base in ('z', 'height', 'elevation'):
        return 'z'
    if base in ('r', 'red', 'r255', 'red255'):
        return 'r255'
    if base in ('g', 'green', 'g255', 'green255'):
        return 'g255'
    if base in ('b', 'blue', 'b255', 'blue255'):
        return 'b255'
    if base in ('intensity',):
        return 'intensity'
    if base in ('reflectance', 'reflectivity'):
        return 'reflectance'
    # Per-pulse multi-return columns Helios's LAD path needs. Recognise the
    # canonical names plus the common LAS aliases so a header-only ASCII export
    # round-trips them under the canonical slug (see `_MULTI_RETURN_SLUGS`).
    if base in ('timestamp', 'gpstime', 'time'):
        return 'timestamp'
    if base in ('targetindex', 'returnnumber'):
        return 'target_index'
    if base in ('targetcount', 'numberofreturns', 'numreturns'):
        return 'target_count'
    # Structured-scan raster indices (see `_GRID_INDEX_SLUGS`). Recognise the
    # canonical slugs plus the common row/col header spellings so a scan export
    # carrying its grid position round-trips into the recovery path.
    if base in ('rowindex', 'row', 'scanrow', 'scanrowindex', 'rasterrow'):
        return 'row_index'
    if base in ('columnindex', 'column', 'col', 'scancolumn', 'scancol',
                'scancolumnindex', 'rastercolumn'):
        return 'column_index'
    # Sky/miss flag (see `_MISS_ALIASES`). Pinned to the canonical `is_miss`
    # slug so a header-carrying ASCII export round-trips the column the LAD path
    # reads, matching the E57/structured-PLY recovery convention.
    if base in _MISS_ALIASES_NORMALISED:
        return _MISS_SLUG
    return None


def _autodetect_xyz_columns(file_path: str) -> List[str]:
    """Pick a column layout when the caller didn't supply <ASCII_format>.

    When the file has a header row (comma- or whitespace-delimited names with
    letters), map each header name to a known role via `_role_from_header_name`
    and leave unrecognised columns as 'skip' — the LAS writer's column plan
    then carries those as extra-dimension scalars under their header name.
    This is what makes a Pistachio-style export's Reflectance/Deviation/...
    columns colourable after import.

    Without a header, fall back to the positional convention: xyz first, then
    r255/g255/b255 if there are six columns, then intensity at column seven.
    Matches legacy Helios projects shipped without a format tag.
    """
    header = _read_ascii_header_names(file_path)
    if header is not None and len(header) >= 3:
        roles = [_role_from_header_name(h) or 'skip' for h in header]
        # Only trust the header mapping if it actually pinned x/y/z; otherwise
        # the names were too exotic and the positional fallback is safer.
        if all(r in roles for r in ('x', 'y', 'z')):
            return roles

    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            # Skip a header row for the positional count — use the first data row.
            if any(re.search(r'[a-zA-Z]', tok) for tok in line.split()):
                continue
            ncols = len(line.split())
            if ncols >= 7:
                return ['x', 'y', 'z', 'r255', 'g255', 'b255', 'intensity']
            if ncols >= 6:
                return ['x', 'y', 'z', 'r255', 'g255', 'b255']
            if ncols >= 4:
                return ['x', 'y', 'z', 'intensity']
            if ncols >= 3:
                return ['x', 'y', 'z']
            break
    return ['x', 'y', 'z']


def _first_data_row_has_letters(file_path: str) -> bool:
    """Detect a leading *uncommented* text header row that pandas must skip.

    Helios scan files don't have one, but plain XYZ exports from other tools
    sometimes do (e.g. 'X Y Z R G B'). We skip such a row so pandas can read
    the rest as floats without falling off the C engine.

    A *commented* header ('# X Y Z ...') is NOT counted here: the readers pass
    comment='#' to pandas, which already drops it, so adding skiprows on top
    would eat the first real data row. We still recover its labels via
    `_read_ascii_header_names`."""
    first = _first_nonblank_ascii_line(file_path)
    if first is None:
        return False
    line, was_commented = first
    if was_commented:
        return False
    return any(re.search(r'[a-zA-Z]', tok) for tok in line.split())


# Roles that already map to a dedicated LAS field — never carried as extra
# dimensions (they'd duplicate position/rgb/intensity in the octree).
_XYZ_RESERVED_ROLES = {
    'x', 'y', 'z', 'r', 'g', 'b', 'r255', 'g255', 'b255',
    'intensity', 'reflectance', 'skip',
}


def _sanitize_extra_dim_name(raw: str) -> str:
    """Slugify a source header name into a laspy-safe LAS extra-dimension name.

    laspy/LAS extra dimensions accept a restricted name set: we keep
    [A-Za-z0-9_], collapse every other run to a single underscore, trim
    leading/trailing underscores, and cap at the 32-char LAS limit. A name
    that sanitises to empty (e.g. all punctuation) falls back to 'field'.
    Callers dedupe collisions; this function is deterministic per input.

    Examples:
      'Reflectance[dB]' -> 'Reflectance_dB'
      'Target Index[]'  -> 'Target_Index'
      'XYZ[0][m]'       -> 'XYZ_0_m'
    """
    slug = re.sub(r'[^A-Za-z0-9_]+', '_', raw).strip('_')
    if not slug:
        slug = 'field'
    return _avoid_reserved_las_dim(slug[:32])


# LAS point format 3 (and the standard dimensions every format carries) reserve
# these names. An extra dimension may NOT reuse one — laspy's dtype build fails
# with "field '<name>' occurs more than once". A user-renamed scalar, or a
# source column literally named "Intensity"/"Classification", can sanitise onto
# one of these, so we rename the collision. Matched case-insensitively because
# laspy lower-cases extra-dim names internally.
_LAS_RESERVED_DIM_NAMES = {
    'x', 'y', 'z', 'intensity', 'bit_fields', 'raw_classification',
    'classification', 'classification_flags', 'scan_angle_rank', 'scan_angle',
    'user_data', 'point_source_id', 'gps_time', 'red', 'green', 'blue', 'nir',
    'return_number', 'number_of_returns', 'scan_direction_flag',
    'edge_of_flight_line', 'synthetic', 'key_point', 'withheld', 'overlap',
    'scanner_channel',
}


def _avoid_reserved_las_dim(slug: str) -> str:
    """Rename an extra-dimension slug that collides (case-insensitively) with a
    built-in LAS dimension, so `header.add_extra_dim` can't crash the converter.
    'Intensity' -> 'Intensity_field', 'classification' -> 'classification_field'."""
    if slug.lower() in _LAS_RESERVED_DIM_NAMES:
        suffixed = f"{slug}_field"
        return suffixed[:32]
    return slug


def _humanize_extra_dim_label(raw: str) -> str:
    """Tidy a source header into a human-readable picker label.

    Keeps unit brackets but normalises whitespace and drops empty brackets:
      'Reflectance[dB]' -> 'Reflectance [dB]'
      'Target Index[]'  -> 'Target Index'
      'Deviation[]'     -> 'Deviation'
    Falls back to the raw string (stripped) when nothing else applies.
    """
    s = raw.strip()
    # Drop empty bracket pairs entirely ('Deviation[]' -> 'Deviation').
    s = re.sub(r'\[\s*\]', '', s)
    # Space out a unit bracket that abuts a word ('Reflectance[dB]' ->
    # 'Reflectance [dB]') without touching brackets already preceded by space.
    s = re.sub(r'(?<=\S)\[', ' [', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s or raw.strip()


def _read_ascii_header_names(file_path: str) -> Optional[List[str]]:
    """Return the column display names from a leading header row, if present.

    XYZ-family files from terrestrial scanners often carry a comma-delimited
    header (e.g. 'XYZ[0][m],XYZ[1][m],...,Reflectance[dB],Deviation[]') even
    though the data rows are whitespace-delimited. We only treat the first
    non-blank, non-comment line as a header when it actually contains letters
    (mirrors `_first_data_row_has_letters`); otherwise there are no names to
    recover and we return None.

    Splits on commas when the line is comma-delimited, else on whitespace, so
    multi-word names like 'Target Index[]' survive in the comma case.

    A *commented* first line ('# x y z ...') is also accepted as a header, but
    only when its tokens actually resolve to x/y/z roles — that guard keeps a
    plain prose comment ('# exported by FooScan v2') from being mistaken for
    column names.
    """
    first = _first_nonblank_ascii_line(file_path)
    if first is None:
        return None
    line, was_commented = first
    if not any(re.search(r'[a-zA-Z]', tok) for tok in line.split()):
        return None
    parts = line.split(',') if ',' in line else line.split()
    names = [p.strip() for p in parts]
    if was_commented:
        # Be conservative with commented lines: only trust them as a header when
        # they map to a real x/y/z layout, else they're just a remark.
        roles = [_role_from_header_name(n) for n in names]
        if not all(r in roles for r in ('x', 'y', 'z')):
            return None
    return names


# A pandas `names=` list can't contain a repeated value, so a column plan that
# skips more than one column can't use bare 'skip' for each. These helpers give
# every skipped column a unique placeholder that the readers still recognise and
# drop via `usecols`. Bare 'skip' (from the auto-detect path, which never repeats
# it) is also treated as a skip for backwards compatibility.
def _skip_name(pos: int) -> str:
    return f"skip:{pos}"


def _is_skip_name(name: str) -> bool:
    return name == 'skip' or name.startswith('skip:')


def _dedupe_slug(base: str, used_slugs: "set[str]") -> str:
    """Return `base` (or a numbered variant) not yet in `used_slugs`, capped at
    the 32-char LAS limit. Mutates `used_slugs` to reserve the result."""
    slug = base
    n = 2
    while slug in used_slugs:
        suffix = f"_{n}"
        slug = base[:32 - len(suffix)] + suffix
        n += 1
    used_slugs.add(slug)
    return slug


def _plan_columns(roles: List[str], header_names: Optional[List[str]]):
    """Turn a per-column role list into a pandas `names` list + extra_dims.

    Shared by `_xyz_column_plan` (the import/convert path) and the preview
    endpoint so the slugs/labels a user sees in the wizard are byte-identical to
    what import produces. A column whose role is reserved (x/y/z/rgb/intensity/
    reflectance) keeps its role token; a multi-return role (timestamp/
    target_index/target_count) becomes an 'extra:<canonical slug>' so the LAD
    path can find it deterministically; anything else ('skip', deviation, …)
    becomes an 'extra:<slug>' carried into the octree, named from the header row
    when present, else a positional 'Column N' fallback.

    Returns (names, extra_dims) where each extra dim is
    {col, slug, label, categorical} ('categorical' defaults False here; the
    structured column-plan path can override it).
    """
    names: List[str] = []
    extra_dims: List[dict] = []
    used_slugs: "set[str]" = set()
    for i, role in enumerate(roles):
        if role in _XYZ_RESERVED_ROLES and role != 'skip':
            names.append(role)
            continue
        if role in _MULTI_RETURN_SLUGS:
            # Pin the canonical slug/label regardless of header text so the LAD
            # accessor can recover these columns by name.
            slug = _dedupe_slug(role, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": _MULTI_RETURN_LABELS[role],
                               "categorical": False})
            continue
        if role in _GRID_INDEX_SLUGS:
            # Structured-scan raster index: pin the canonical slug/label so the
            # grid-based miss-recovery path finds the raster by name (same as the
            # multi-return slugs above, and what the E57 structured path emits).
            slug = _dedupe_slug(role, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": _GRID_INDEX_LABELS[role],
                               "categorical": False})
            continue
        if role == _MISS_SLUG:
            # Sky/miss flag: pin the canonical is_miss slug/label regardless of
            # the source header spelling (is_miss/miss/sky) so the LAD path and
            # renderer find it by name, matching the E57/PLY recovery convention.
            slug = _dedupe_slug(_MISS_SLUG, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": _MISS_LABEL, "categorical": False})
            continue
        if header_names is not None and i < len(header_names) and header_names[i]:
            label = _humanize_extra_dim_label(header_names[i])
            base = _sanitize_extra_dim_name(header_names[i])
        else:
            label = f"Column {i + 1}"
            base = f"col_{i + 1}"
        slug = _dedupe_slug(base, used_slugs)
        col_id = f"extra:{slug}"
        names.append(col_id)
        extra_dims.append({"col": col_id, "slug": slug, "label": label,
                           "categorical": False})
    return names, extra_dims


def _plan_columns_from_column_plan(column_plan: "ColumnPlan"):
    """Build (names, extra_dims) directly from a wizard-supplied ColumnPlan.

    Honours each entry's explicit role, and for role=='extra' the user's custom
    slug/label/categorical. Falls back to a sane slug when the wizard omitted
    one. Reserved roles keep their token; a multi-return role (or an extra
    slugged as one) is pinned to its canonical slug/label so the LAD path finds
    it; 'skip' (or an extra with no usable name) is dropped. Slugs are
    de-duplicated so two custom names can't collide on disk.
    """
    names: List[str] = []
    extra_dims: List[dict] = []
    used_slugs: "set[str]" = set()
    for pos, entry in enumerate(sorted(column_plan.columns, key=lambda e: e.index)):
        role = (entry.role or 'skip').lower()
        if role in _XYZ_RESERVED_ROLES and role != 'skip':
            names.append(role)
            continue
        # A column mapped to a multi-return field — either by naming the role
        # token directly or by slugging an 'extra' as one — is carried under the
        # canonical slug/label so the LAD accessor can recover it by name. But a
        # column the user explicitly marked categorical (the wizard's 'Label'
        # role) is a discrete class field by intent: multi-return per-pulse
        # values (timestamp/target index/count) are never categorical, so honour
        # the user's choice and let it fall through to the generic extra-dim path
        # (preserving its sanitised slug + categorical flag) instead of diverting
        # it into the LAD canonicalisation, which would lower-case the slug and
        # relabel it as a per-pulse field.
        mr = role if role in _MULTI_RETURN_SLUGS else (entry.slug or '').lower()
        if mr in _MULTI_RETURN_SLUGS and not entry.categorical:
            slug = _dedupe_slug(mr, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": (entry.label or '').strip() or _MULTI_RETURN_LABELS[mr],
                               "categorical": bool(entry.categorical)})
            continue
        # Structured-grid indices (scan row / column): carry under the canonical
        # `row_index`/`column_index` slug so the LAD/recovery path finds the
        # raster by name — same treatment as the multi-return slugs above, and
        # matching what the E57 structured-import path emits. These are integer
        # grid positions, never categorical class fields.
        gi = role if role in _GRID_INDEX_SLUGS else (entry.slug or '').lower()
        if gi in _GRID_INDEX_SLUGS:
            slug = _dedupe_slug(gi, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": (entry.label or '').strip() or _GRID_INDEX_LABELS[gi],
                               "categorical": False})
            continue
        # Sky/miss flag: a column whose role token or slug names a miss alias
        # (is_miss/miss/sky) carries under the canonical is_miss slug so the LAD
        # path and renderer find it by name — matching the E57/PLY convention.
        # Never categorical (it's a 0/1 flag the LAD check reads as a continuous
        # value), so honour it regardless of the wizard's categorical toggle.
        ms = role if role == _MISS_SLUG else _normalise_miss_alias(entry.slug or '')
        if ms == _MISS_SLUG:
            slug = _dedupe_slug(_MISS_SLUG, used_slugs)
            col_id = f"extra:{slug}"
            names.append(col_id)
            extra_dims.append({"col": col_id, "slug": slug,
                               "label": (entry.label or '').strip() or _MISS_LABEL,
                               "categorical": False})
            continue
        if role == 'skip' or (role == 'extra' and not (entry.slug or entry.label)):
            # A skipped column, or an 'extra' with no usable name, carries
            # nothing. Use a UNIQUE placeholder (not bare 'skip') so pandas
            # doesn't reject a names= list with repeated 'skip' entries; the
            # readers drop these via _is_skip_name.
            names.append(_skip_name(pos))
            continue
        # role == 'extra' (or any unreserved token) → carry as an extra dim.
        # A categorical override of a multi-return column reaches here with the
        # wizard's lower-cased canonical slug (e.g. 'target_index'); prefer the
        # human label so it slugs to a readable class-field name ('Target_Index')
        # rather than the LAD canonical it's no longer being used as.
        slug_source = entry.slug
        if entry.categorical and (entry.slug or '').lower() in _MULTI_RETURN_SLUGS:
            slug_source = entry.label or entry.slug
        base = _sanitize_extra_dim_name(slug_source or entry.label or f"col_{entry.index + 1}")
        slug = _dedupe_slug(base, used_slugs)
        label = (entry.label or "").strip() or _humanize_extra_dim_label(slug)
        col_id = f"extra:{slug}"
        names.append(col_id)
        extra_dims.append({"col": col_id, "slug": slug, "label": label,
                           "categorical": bool(entry.categorical)})
    return names, extra_dims


def _xyz_column_plan(source_path: "_Path", ascii_format: Optional[str],
                     column_plan: "Optional[ColumnPlan]" = None):
    """Resolve the column layout for an XYZ-family file, carrying unmapped
    numeric columns as octree extra dimensions.

    Returns (names, extra_dims) where:
      - `names` is the per-column identifier list for pandas `names=` — known
        roles keep their role token (x/y/z/r255/intensity/...), extras get a
        unique 'extra:<slug>' identifier, and truly droppable columns (no
        header name, beyond the recognised layout) stay 'skip'.
      - `extra_dims` is an ordered list of dicts {col, slug, label, categorical}
        for each carried extra column, where `col` is the matching entry in
        `names`.

    When `column_plan` is supplied (the import wizard's explicit choices) it
    fully determines the layout — roles, custom slugs/labels, and the
    categorical flag — bypassing header/format sniffing. When it's None,
    behaviour is exactly as before: role tokens come from
    `_tokenize_ascii_format` / `_autodetect_xyz_columns`, and extras are named
    from the header row (or a positional 'Column N' fallback).
    """
    if column_plan is not None:
        return _plan_columns_from_column_plan(column_plan)

    roles = (_tokenize_ascii_format(ascii_format)
             if ascii_format
             else _autodetect_xyz_columns(str(source_path)))
    header_names = _read_ascii_header_names(str(source_path))
    return _plan_columns(roles, header_names)


def _pack_pointcloud_response(positions: np.ndarray,
                              colors: Optional[np.ndarray],
                              intensity: Optional[np.ndarray]) -> StreamingResponse:
    """Stream a packed binary response matching the renderer decoder.

    Response layout (little-endian):
      offset  size   field
      0       4      magic 'PHX1'
      4       4      uint32 point_count
      8       1      uint8  has_colors (0/1)
      9       1      uint8  has_intensity (0/1)
      10      22     reserved (zero)
      32      pc*12  float32 positions [x0,y0,z0,x1,y1,z1,...]
      ...     pc*12  float32 colors    [r0,g0,b0,...]      (if has_colors)
      ...     pc*4   float32 intensity [i0,i1,...]         (if has_intensity)
    """
    import struct

    point_count = int(positions.shape[0])
    header = struct.pack(
        '<4sIBB22x', _POINTCLOUD_BIN_MAGIC, point_count,
        1 if colors is not None else 0,
        1 if intensity is not None else 0,
    )

    def chunks():
        yield header
        yield np.ascontiguousarray(positions, dtype=np.float32).tobytes()
        if colors is not None:
            yield np.ascontiguousarray(colors, dtype=np.float32).tobytes()
        if intensity is not None:
            yield np.ascontiguousarray(intensity, dtype=np.float32).tobytes()

    return StreamingResponse(chunks(), media_type='application/octet-stream')


def _load_xyz_arrays(
    file_path: str, ascii_format: Optional[str],
    column_plan: "Optional[ColumnPlan]" = None,
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Parse an ASCII xyz-family file via pandas and return numpy arrays.

    Returns (positions[N,3] float32, colors[N,3] float32 | None,
    intensity[N] float32 | None). Separated from the response-packing step
    so the crop endpoint can reuse the loader and apply a boolean mask
    before responding.

    When `column_plan` is supplied (import wizard) it determines the column
    roles and whether r/g/b are 0-255 ints or 0-1 floats; otherwise roles come
    from the Helios `ascii_format` hint or are auto-detected.
    """
    if column_plan is not None:
        columns = [(e.role or 'skip').lower()
                   for e in sorted(column_plan.columns, key=lambda e: e.index)]
        rgb_is_255 = column_plan.rgb_is_255
    else:
        columns = (_tokenize_ascii_format(ascii_format)
                   if ascii_format
                   else _autodetect_xyz_columns(file_path))
        rgb_is_255 = True

    # role -> column index. Keep first occurrence on duplicates so pandas
    # doesn't see a repeated column name.
    role_to_idx: Dict[str, int] = {}
    for idx, role in enumerate(columns):
        if role in _XYZ_DATA_ROLES and role not in role_to_idx:
            role_to_idx[role] = idx

    if not all(r in role_to_idx for r in ('x', 'y', 'z')):
        raise HTTPException(
            status_code=400,
            detail="ASCII format must include x, y, and z columns."
        )

    sorted_roles = sorted(role_to_idx.items(), key=lambda kv: kv[1])
    usecols = [idx for _, idx in sorted_roles]
    names = [role for role, _ in sorted_roles]

    skiprows = 1 if _first_data_row_has_letters(file_path) else 0

    try:
        df = pd.read_csv(
            file_path,
            sep=r'\s+', header=None, comment='#',
            usecols=usecols, names=names,
            dtype=np.float32, engine='c', skip_blank_lines=True,
            skiprows=skiprows, on_bad_lines='skip',
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to parse {file_path}: {e}")

    if df.empty:
        raise HTTPException(status_code=400, detail=f"No data rows found in {file_path}")

    df = df.dropna(subset=['x', 'y', 'z'])
    if df.empty:
        raise HTTPException(status_code=400, detail=f"No valid xyz rows in {file_path}")

    positions = np.column_stack([
        df['x'].to_numpy(dtype=np.float32, copy=False),
        df['y'].to_numpy(dtype=np.float32, copy=False),
        df['z'].to_numpy(dtype=np.float32, copy=False),
    ]).astype(np.float32, copy=False)

    colors = None
    if all(c in df.columns for c in ('r255', 'g255', 'b255')):
        colors = np.column_stack([
            df['r255'].to_numpy(dtype=np.float32, copy=False) / 255.0,
            df['g255'].to_numpy(dtype=np.float32, copy=False) / 255.0,
            df['b255'].to_numpy(dtype=np.float32, copy=False) / 255.0,
        ]).astype(np.float32, copy=False)
    elif all(c in df.columns for c in ('r', 'g', 'b')):
        colors = np.column_stack([
            df['r'].to_numpy(dtype=np.float32, copy=False),
            df['g'].to_numpy(dtype=np.float32, copy=False),
            df['b'].to_numpy(dtype=np.float32, copy=False),
        ]).astype(np.float32, copy=False)

    intensity = None
    for role in ('intensity', 'reflectance'):
        if role in df.columns:
            intensity = df[role].to_numpy(dtype=np.float32, copy=False)
            break

    return positions, colors, intensity


def _load_ply_pcd_arrays(
    file_path: str,
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Parse PLY or PCD via open3d. Handles both ASCII and binary variants
    (open3d picks based on the file header), so the renderer is freed from
    streaming binary PLY/PCD too — same code path either way.

    Open3D loses scalar fields (intensity, reflectance, …) on read for PLY
    and PCD. If a downstream consumer needs them we'd need to parse the
    formats directly; none for now."""
    try:
        import open3d as o3d
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="open3d is not available; PLY/PCD by-path import is disabled.",
        )

    try:
        cloud = o3d.io.read_point_cloud(file_path)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Failed to parse {file_path}: {e}")

    points = np.asarray(cloud.points)
    if points.size == 0:
        raise HTTPException(status_code=400, detail=f"No points found in {file_path}")

    positions = points.astype(np.float32, copy=False)
    colors = np.asarray(cloud.colors).astype(np.float32, copy=False) if cloud.has_colors() else None
    intensity = None
    return positions, colors, intensity


def _load_pointcloud_arrays(
    file_path: str, ascii_format: Optional[str],
    column_plan: "Optional[ColumnPlan]" = None,
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Dispatch a path-based point-cloud load to the right backend by
    extension and return the raw numpy arrays. Shared entry point for the
    import and crop endpoints — keeps file-IO, format detection, and the
    PLY/PCD vs ASCII dispatch in one place.

    `column_plan` (import wizard) applies only to the XYZ-family branch.

    Raises HTTPException on missing file or unsupported extension.
    """
    import os

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower().lstrip('.')
    if ext in _PANDAS_EXTENSIONS:
        return _load_xyz_arrays(file_path, ascii_format, column_plan)
    if ext in _OPEN3D_EXTENSIONS:
        return _load_ply_pcd_arrays(file_path)

    raise HTTPException(
        status_code=400,
        detail=(
            f"Unsupported extension for path-based import: .{ext}. "
            f"Supported: {sorted(_PANDAS_EXTENSIONS | _OPEN3D_EXTENSIONS)}"
        ),
    )


def _read_points_from_source(
    src: PointSource,
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Resolve a PointSource to (positions[N,3] float64, colors[N,3] float32 in
    0-1 | None, intensity[N] float32 | None).

    Reuses `_load_pointcloud_arrays` (which dispatches XYZ via pandas and
    PLY/PCD via open3d, and 404s on a missing file), then applies the optional
    stride-downsample and translation. Positions come back as float64 because
    every consumer (open3d KD-trees, skeleton BFS, raycasting) wants double
    precision; colors/intensity keep their loader dtype.

    When `src.session_id` is set, points come from the live cloud session's
    in-RAM array with its per-point deletions already applied (the Family-1
    source of truth), so downstream ops honor unbaked deletions without a
    rebuild. The compute consumers of this path want positions only, so colours
    and intensity resolve to None here (the session DOES hold them — see
    `_read_las_into_arrays` — they're simply not surfaced for these ops).
    """
    if src.session_id is not None:
        sess = _get_cloud_session(src.session_id)
        with _cloud_session_lock:
            positions = sess.positions[~sess.deleted].copy()
        colors = None
        intensity = None
    else:
        positions, colors, intensity = _load_pointcloud_arrays(
            src.source_path, src.ascii_format
        )

    if src.max_points is not None and src.max_points > 0 and len(positions) > src.max_points:
        stride = int(math.ceil(len(positions) / src.max_points))
        positions = positions[::stride]
        colors = colors[::stride] if colors is not None else None
        intensity = intensity[::stride] if intensity is not None else None

    positions = positions.astype(np.float64, copy=False)
    if src.translation is not None:
        t = np.asarray(src.translation, dtype=np.float64)
        if t.shape != (3,):
            raise HTTPException(
                status_code=400,
                detail=f"translation must be [tx, ty, tz]; got {src.translation!r}",
            )
        positions = positions + t

    if not src.want_colors:
        colors = None

    return positions, colors, intensity


@app.post("/api/pointcloud/import_by_path")
async def import_pointcloud_by_path(request: ImportPointCloudByPathRequest):
    """Parse a point-cloud file from disk and stream back a packed binary
    representation. Dispatches by extension:

    * `.xyz` / `.txt` / `.csv` / `.pts` / `.asc` → pandas + optional
      Helios `ascii_format` hint.
    * `.ply` / `.pcd` → open3d (handles ASCII and binary).
    """
    positions, colors, intensity = _load_pointcloud_arrays(
        request.file_path, request.ascii_format, request.column_plan
    )
    return _pack_pointcloud_response(positions, colors, intensity)


# ============================================================================
# Point cloud → Potree 2.0 octree pipeline (added in 0.3.0)
# ============================================================================
# Flat-array import paths above OOM the renderer on multi-GB clouds. This
# section converts source files into Potree 2.0 octrees (metadata.json +
# hierarchy.bin + octree.bin) which the renderer streams via potree-core.
#
# PotreeConverter 2.x accepts LAS/LAZ only, so XYZ-family inputs are
# pre-converted via laspy in chunks. Both phases combined run at ~3 M pts/sec
# on M-series Macs with NVMe.

import hashlib as _hashlib
import os as _os
import shutil as _shutil
import subprocess as _subprocess
import sys as _sys
from pathlib import Path as _Path


_OCTREE_CACHE_VERSION = 1  # bump if cache layout changes (forces re-conversion)

# Default cache cap. Overridable via PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES.
# A typical 28 M-point cloud is ~340 MB on disk; 20 GB holds ~60 such clouds.
_DEFAULT_OCTREE_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024


def _octree_cache_root() -> _Path:
    """OS-appropriate user-data directory for cached octrees.

    macOS: ~/Library/Application Support/Phytograph/cache/octrees
    Linux: $XDG_CACHE_HOME/Phytograph/octrees (or ~/.cache/Phytograph/octrees)
    Windows: %LOCALAPPDATA%/Phytograph/cache/octrees
    Overridable via PHYTOGRAPH_OCTREE_CACHE_ROOT for tests."""
    override = _os.environ.get("PHYTOGRAPH_OCTREE_CACHE_ROOT")
    if override:
        return _Path(override)
    if _sys.platform == "darwin":
        base = _Path.home() / "Library" / "Application Support" / "Phytograph" / "cache"
    elif _sys.platform.startswith("win"):
        base = _Path(_os.environ.get("LOCALAPPDATA", _Path.home() / "AppData" / "Local")) / "Phytograph" / "cache"
    else:
        base = _Path(_os.environ.get("XDG_CACHE_HOME", _Path.home() / ".cache")) / "Phytograph"
    return base / "octrees"


def _canonical_ascii_format(ascii_format: Optional[str]) -> str:
    """Normalise whitespace and case so equivalent format strings hash the same."""
    if not ascii_format:
        return ""
    return " ".join(ascii_format.split()).lower()


def _canonical_column_plan(column_plan: "Optional[ColumnPlan]") -> str:
    """Stable JSON form of a ColumnPlan for hashing. Empty string when None so a
    plan-less import keeps the same cache identity it had before this field
    existed (no cache churn for existing users)."""
    if column_plan is None:
        return ""
    payload = {
        "rgb_is_255": column_plan.rgb_is_255,
        "columns": [
            {"index": e.index, "role": (e.role or "").lower(),
             "slug": e.slug or "", "label": e.label or "",
             "categorical": bool(e.categorical)}
            for e in sorted(column_plan.columns, key=lambda e: e.index)
        ],
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _octree_cache_key(source_path: str, ascii_format: Optional[str],
                      column_plan: "Optional[ColumnPlan]" = None) -> str:
    """Stable cache key for (source file, format, column plan). Includes mtime
    so edits to the source XYZ invalidate the cached octree. Two different
    wizard column plans on the same file get distinct cache entries."""
    p = _Path(source_path).resolve()
    try:
        mtime_ns = p.stat().st_mtime_ns
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Source file not found: {source_path}")
    h = _hashlib.sha1()
    h.update(str(_OCTREE_CACHE_VERSION).encode())
    h.update(b"\x00")
    h.update(str(p).encode())
    h.update(b"\x00")
    h.update(str(mtime_ns).encode())
    h.update(b"\x00")
    h.update(_canonical_ascii_format(ascii_format).encode())
    h.update(b"\x00")
    h.update(_canonical_column_plan(column_plan).encode())
    return h.hexdigest()


def _octree_cache_dir(source_path: str, ascii_format: Optional[str],
                      column_plan: "Optional[ColumnPlan]" = None) -> _Path:
    """Path where this (source, format, plan) tuple's octree lives. May not exist yet."""
    return _octree_cache_root() / _octree_cache_key(source_path, ascii_format, column_plan)


def _resolve_potree_converter_path() -> _Path:
    """Locate the PotreeConverter binary.

    Resolution order:
      1. $PHYTOGRAPH_POTREECONVERTER (explicit override, used by tests / CI).
      2. $PHYTOGRAPH_RESOURCES/potree_converter/<platform>/PotreeConverter
         (set by Electron main process for packaged builds).
      3. <repo root>/resources/potree_converter/<platform>/PotreeConverter
         (CI-built binary, dev fallback).
      4. <repo root>/tmp/potree-converter-src/build/PotreeConverter
         (locally built spike binary; dev convenience only).
    """
    override = _os.environ.get("PHYTOGRAPH_POTREECONVERTER")
    if override:
        p = _Path(override)
        if p.is_file():
            return p
        raise HTTPException(
            status_code=503,
            detail=f"PHYTOGRAPH_POTREECONVERTER points to a missing file: {override}",
        )

    if _sys.platform == "darwin":
        platform_dir = "darwin-arm64" if _os.uname().machine == "arm64" else "darwin-x64"
        bin_name = "PotreeConverter"
    elif _sys.platform.startswith("win"):
        platform_dir = "win-x64"
        bin_name = "PotreeConverter.exe"
    else:
        platform_dir = "linux-x64"
        bin_name = "PotreeConverter"

    candidates = []
    resources_env = _os.environ.get("PHYTOGRAPH_RESOURCES")
    if resources_env:
        candidates.append(_Path(resources_env) / "potree_converter" / platform_dir / bin_name)

    repo_root = _Path(__file__).resolve().parent.parent
    candidates.append(repo_root / "resources" / "potree_converter" / platform_dir / bin_name)
    candidates.append(repo_root / "tmp" / "potree-converter-src" / "build" / bin_name)

    for c in candidates:
        if c.is_file():
            return c

    raise HTTPException(
        status_code=503,
        detail=(
            f"PotreeConverter binary not found. Looked in: "
            f"{[str(c) for c in candidates]}. "
            f"Run `npm run build:potree-converter` or set PHYTOGRAPH_POTREECONVERTER."
        ),
    )


def _xyz_to_las(source_path: _Path, ascii_format: Optional[str], out_las: _Path,
                column_plan: "Optional[ColumnPlan]" = None) -> tuple[int, List[dict]]:
    """Stream an XYZ-family ASCII file into a LAS file via laspy in chunks.

    PotreeConverter 2.x accepts only LAS/LAZ; XYZ goes through here first.
    Streaming keeps peak memory bounded by `chunk_rows` * (cols × 8B), not
    by total point count.

    Column layout uses the same `ascii_format` convention as
    `_load_xyz_arrays` — roles are tokenised, with x/y/z mandatory and
    r255/g255/b255/intensity (or reflectance, mapped to intensity) optional.
    Any remaining numeric columns are carried into the octree as LAS extra
    dimensions (float32) so the renderer can colour by them later.

    Returns (total_points, extra_dims), where extra_dims is the
    [{slug, label}, ...] list of carried scalar attributes (for the cache's
    slug→label sidecar).
    """
    import laspy  # local: only when this code path runs

    names, extra_dims = _xyz_column_plan(source_path, ascii_format, column_plan)

    has_xyz = all(role in names for role in ("x", "y", "z"))
    if not has_xyz:
        raise HTTPException(
            status_code=400,
            detail=f"ASCII format must include x/y/z. Got columns: {names}",
        )

    # RGB may arrive as 0-255 ints (r255/g255/b255) or 0-1 floats (r/g/b). The
    # wizard's rgb_is_255 flag, when a column_plan is present, is authoritative;
    # otherwise infer from which role tokens the plan produced.
    rgb255_cols = ("r255", "g255", "b255")
    rgb01_cols = ("r", "g", "b")
    has_rgb255 = all(role in names for role in rgb255_cols)
    has_rgb01 = all(role in names for role in rgb01_cols)
    if column_plan is not None and (has_rgb255 or has_rgb01):
        rgb_is_255 = column_plan.rgb_is_255
    else:
        rgb_is_255 = has_rgb255
    rgb_cols = rgb255_cols if has_rgb255 else (rgb01_cols if has_rgb01 else None)
    intensity_role = next((r for r in ("intensity", "reflectance") if r in names), None)

    # LAS point format 3 carries XYZ + intensity + RGB. Extra numeric columns
    # are added as float32 extra dimensions; PotreeConverter writes the full
    # LAS schema (no --attributes filter), so they survive into the octree's
    # metadata.json attributes list and decode into named buffers in the
    # potree-core 2.0 loader.
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))

    skiprows = 1 if _first_data_row_has_letters(str(source_path)) else 0

    chunk_rows = 2_000_000
    total_points = 0
    with laspy.open(str(out_las), mode="w", header=header) as writer:
        reader = pd.read_csv(
            source_path,
            sep=r"\s+",
            header=None,
            names=names,
            usecols=[i for i, c in enumerate(names) if not _is_skip_name(c)],
            comment="#",
            skiprows=skiprows,
            chunksize=chunk_rows,
            engine="c",
        )
        for chunk in reader:
            # Drop rows with non-numeric / missing x/y/z. A .pts file leads
            # with a bare point-count line ('12345') that pandas pads to a
            # 1-field row (xyz NaN); without this it would otherwise be cast
            # to a garbage (0,0,0)-ish point in the octree. Mirrors the flat
            # loader's `df.dropna(subset=['x','y','z'])`.
            chunk = chunk.dropna(subset=["x", "y", "z"])
            n = len(chunk)
            if n == 0:
                continue
            record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
            record.x = chunk["x"].to_numpy(dtype=np.float64)
            record.y = chunk["y"].to_numpy(dtype=np.float64)
            record.z = chunk["z"].to_numpy(dtype=np.float64)
            if rgb_cols is not None:
                # LAS RGB is uint16 (16-bit per channel). 0-255 source scales by
                # 256 (preserves perceptual brightness; renderer right-shifts to
                # recover 8-bit). 0-1 float source scales straight to the full
                # 16-bit range (×65535).
                rc, gc, bc = rgb_cols
                if rgb_is_255:
                    record.red = chunk[rc].to_numpy(dtype=np.uint16) * 256
                    record.green = chunk[gc].to_numpy(dtype=np.uint16) * 256
                    record.blue = chunk[bc].to_numpy(dtype=np.uint16) * 256
                else:
                    record.red = np.clip(chunk[rc].to_numpy(dtype=np.float32) * 65535.0, 0, 65535).astype(np.uint16)
                    record.green = np.clip(chunk[gc].to_numpy(dtype=np.float32) * 65535.0, 0, 65535).astype(np.uint16)
                    record.blue = np.clip(chunk[bc].to_numpy(dtype=np.float32) * 65535.0, 0, 65535).astype(np.uint16)
            if intensity_role is not None:
                # Both 'intensity' and 'reflectance' fields in Helios scans
                # span 0-255. Map to LAS intensity's 0-65535 range.
                refl = chunk[intensity_role].to_numpy(dtype=np.float32)
                scaled = np.clip(refl * 256.0, 0, 65535).astype(np.uint16)
                record.intensity = scaled
            for ed in extra_dims:
                record[ed["slug"]] = chunk[ed["col"]].to_numpy(dtype=np.float32)
            writer.write_points(record)
            total_points += n

    return total_points, [{"slug": ed["slug"], "label": ed["label"]} for ed in extra_dims]


def _ply_to_las(source_path: _Path, out_las: _Path) -> tuple[int, List[dict]]:
    """Convert a PLY to LAS via plyfile so it can feed the PotreeConverter
    octree pipeline, preserving scalar fields as LAS extra dimensions.

    open3d (used on the flat path) drops every vertex property except position
    and RGB, so we parse the PLY directly. Recognised roles: x/y/z (required),
    red/green/blue or r/g/b (RGB), and the first of intensity/scalar_intensity/
    reflectance (mapped to LAS intensity). Every remaining numeric vertex
    property is carried as a float32 extra dimension so the renderer can colour
    by it — the same mechanism `_xyz_to_las` uses for unmapped ASCII columns.

    Sky/miss handling (for LAD): a property aliased to `is_miss` (is_miss/miss/
    sky) is normalised to the canonical `is_miss` extra dim. Rows with non-finite
    (NaN/Inf) coordinates are also treated as misses — a structured/organized PLY
    marks empty grid cells that way. A generic PLY carries no scanner origin, so
    a NaN-coord miss has no recoverable beam direction; those rows are dropped
    (they can't be placed as a far-field point) while any miss that DOES have
    finite far-field coords (e.g. exported from Helios) is kept and tagged.

    Returns (total_points, extra_dims), where extra_dims is the
    [{slug, label}, ...] list for the slug→label sidecar; `is_miss` is included
    whenever the PLY carried miss information.
    """
    import laspy  # local: only when this code path runs
    from plyfile import PlyData

    ply = PlyData.read(str(source_path))
    try:
        vertex = ply["vertex"].data
    except KeyError:
        raise HTTPException(
            status_code=400,
            detail="PLY has no 'vertex' element; cannot import as a point cloud.",
        )
    names = list(vertex.dtype.names or ())

    if not all(role in names for role in ("x", "y", "z")):
        raise HTTPException(
            status_code=400,
            detail=f"PLY missing x/y/z vertex properties. Got: {names}",
        )

    # RGB: PLY conventionally uses red/green/blue; accept short r/g/b too.
    if all(c in names for c in ("red", "green", "blue")):
        rgb_cols = ("red", "green", "blue")
    elif all(c in names for c in ("r", "g", "b")):
        rgb_cols = ("r", "g", "b")
    else:
        rgb_cols = None

    intensity_col = next(
        (c for c in ("intensity", "scalar_intensity", "reflectance") if c in names),
        None,
    )

    # An explicit miss-flag property (is_miss/miss/sky) maps to the canonical
    # `is_miss` slug, not a generic positional extra dim.
    miss_col = next((c for c in names if c.lower() in _MISS_ALIASES), None)

    reserved = {"x", "y", "z"}
    if rgb_cols:
        reserved.update(rgb_cols)
    if intensity_col:
        reserved.add(intensity_col)
    if miss_col:
        reserved.add(miss_col)

    # Carry every other numeric property as a float32 extra dim. Dedupe slugs
    # the same way the ASCII path does, since two headers can sanitise alike.
    extra_dims: List[dict] = []
    used_slugs: set[str] = set()
    for col in names:
        if col in reserved or not np.issubdtype(vertex[col].dtype, np.number):
            continue
        slug = _sanitize_extra_dim_name(col)
        base, i = slug, 1
        while slug in used_slugs:
            slug = f"{base[:29]}_{i}"
            i += 1
        used_slugs.add(slug)
        extra_dims.append({"col": col, "slug": slug, "label": _humanize_extra_dim_label(col)})

    x = vertex["x"].astype(np.float64)
    y = vertex["y"].astype(np.float64)
    z = vertex["z"].astype(np.float64)

    # Build the per-point miss flag from the explicit column and/or non-finite
    # coordinates (an organized PLY's empty grid cells).
    is_miss = np.zeros(len(vertex), dtype=np.float32)
    has_miss_info = False
    if miss_col is not None:
        is_miss = (np.asarray(vertex[miss_col]).astype(np.float64) != 0).astype(np.float32)
        has_miss_info = True
    nonfinite = ~(np.isfinite(x) & np.isfinite(y) & np.isfinite(z))
    if nonfinite.any():
        is_miss[nonfinite] = 1.0
        has_miss_info = True

    # Drop misses we can't place: a generic PLY has no scanner origin, so a
    # NaN-coord miss has no direction to project onto. A miss that still carries
    # finite (far-field) coords — e.g. a Helios export — is kept and tagged.
    keep = np.ones(len(vertex), dtype=bool)
    if nonfinite.any():
        keep = ~nonfinite

    if has_miss_info:
        # `is_miss` rides along as a normal extra dim through octree/session/LAD.
        extra_dims.append({"col": None, "slug": _MISS_SLUG, "label": _MISS_LABEL})

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))

    n = int(keep.sum())
    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    record.x = x[keep]
    record.y = y[keep]
    record.z = z[keep]
    if rgb_cols:
        # PLY RGB is 0-255 (uint8); LAS RGB is uint16. *256 keeps perceptual
        # brightness and lets the renderer right-shift to recover 8-bit, the
        # same convention as `_xyz_to_las`.
        record.red = vertex[rgb_cols[0]][keep].astype(np.uint16) * 256
        record.green = vertex[rgb_cols[1]][keep].astype(np.uint16) * 256
        record.blue = vertex[rgb_cols[2]][keep].astype(np.uint16) * 256
    if intensity_col is not None:
        refl = vertex[intensity_col][keep].astype(np.float32)
        record.intensity = np.clip(refl * 256.0, 0, 65535).astype(np.uint16)
    for ed in extra_dims:
        if ed["slug"] == _MISS_SLUG and ed.get("col") is None:
            record[_MISS_SLUG] = is_miss[keep]
        else:
            record[ed["slug"]] = vertex[ed["col"]][keep].astype(np.float32)

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        writer.write_points(record)

    return n, [{"slug": ed["slug"], "label": ed["label"]} for ed in extra_dims]


def _pcd_viewpoint_origin(source_path: _Path) -> Optional[list]:
    """Read the PCD header `VIEWPOINT tx ty tz qw qx qy qz` field and return the
    scanner translation `[tx, ty, tz]` when it is meaningfully non-identity.

    PCD is the only other supported format (besides E57) that records a sensor
    pose, but it carries ONLY a translation + orientation quaternion — no angular
    sweep or grid — and the overwhelming majority of files leave it at the
    identity default (`0 0 0 1 0 0 0`). We surface just the origin, and only when
    it differs from the default, so we don't fabricate a (0,0,0) scan origin for
    every PCD. The header is plain ASCII even in binary PCDs, so a small text
    scan of the first lines suffices. Returns None when absent/identity/unreadable.
    """
    try:
        with open(source_path, "r", encoding="ascii", errors="ignore") as fh:
            for _ in range(64):  # VIEWPOINT lives in the small fixed header
                line = fh.readline()
                if not line:
                    break
                if line.startswith("VIEWPOINT"):
                    parts = line.split()[1:]
                    if len(parts) < 3:
                        return None
                    tx, ty, tz = (float(parts[0]), float(parts[1]), float(parts[2]))
                    if abs(tx) < 1e-9 and abs(ty) < 1e-9 and abs(tz) < 1e-9:
                        return None  # identity default — nothing to populate
                    return [tx, ty, tz]
                if line.startswith("DATA"):
                    break  # header ended without a VIEWPOINT
    except Exception:
        return None
    return None


def _pcd_to_las(source_path: _Path, out_las: _Path) -> tuple[int, List[dict]]:
    """Convert a PCD to LAS so it can feed the PotreeConverter octree pipeline.

    PCD goes through open3d (`_load_ply_pcd_arrays`), which carries position and
    RGB only — PCD's ascii/binary/binary_compressed variants make robust scalar
    parsing more than this is worth for now, so scalar fields are not preserved.
    A non-identity PCD `VIEWPOINT` translation is stashed (keyed by the output
    LAS path) so create_cloud_session can auto-populate the scan origin, the same
    channel E57 uses. Returns (total_points, []).
    """
    import laspy  # local: only when this code path runs

    positions, colors, _ = _load_ply_pcd_arrays(str(source_path))

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)

    n = len(positions)
    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    record.x = positions[:, 0].astype(np.float64)
    record.y = positions[:, 1].astype(np.float64)
    record.z = positions[:, 2].astype(np.float64)
    if colors is not None:
        # open3d colors are 0-1 floats; LAS RGB is uint16. Scale to 8-bit then
        # *256 to match the `_xyz_to_las` / `_ply_to_las` convention.
        rgb8 = np.clip(colors * 255.0, 0, 255).astype(np.uint16)
        record.red = rgb8[:, 0] * 256
        record.green = rgb8[:, 1] * 256
        record.blue = rgb8[:, 2] * 256

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        writer.write_points(record)

    # Surface a non-identity sensor origin from the PCD VIEWPOINT, if any, via
    # the same per-output-LAS channel E57 uses. Only origin is recoverable from
    # PCD (no angular sweep / grid), so the rest of ScanParameters stays default.
    vp = _pcd_viewpoint_origin(source_path)
    if vp is not None:
        _e57_scan_meta[str(out_las.resolve())] = {
            "origin": vp,
            "scan_params": {"origin": vp},
            "has_misses": False,
            "miss_count": 0,
            "unplaceable_miss_count": 0,
        }

    return n, []


# Scanner origin recovered from the most recent E57 conversion, keyed by the
# absolute output LAS path. `_e57_to_las` writes it; `create_cloud_session` pops
# it right after conversion to surface the origin (and a hasMisses flag) to the
# renderer so it can place the scan's `ScanParameters.origin` and relocate miss
# points onto the bounding sphere for display. Threaded this way (rather than
# widening `_source_to_las`'s tuple) so the many other callers stay untouched.
_e57_scan_meta: Dict[str, dict] = {}


def _e57_scan_params(header, has_grid: bool) -> dict:
    """Recover scanner scan-pattern parameters from an E57 scan header so a
    non-XML E57 import can auto-populate a Scan's `ScanParameters` (origin +
    angular sweep + grid resolution), the same fields the Helios XML carries.

    E57 stores these in two optional header sub-structures:
      - `sphericalBounds`: azimuthStart/azimuthEnd and elevationMinimum/Maximum
        (radians). E57 elevation is measured from the XY plane (+up, range
        -pi/2..pi/2); Phytograph/Helios uses zenith (polar angle from +Z), so
        `zenith = 90 - elevation_deg`. Azimuth maps directly to phi (degrees).
      - `indexBounds`: row/column min/max — the structured-grid dimensions,
        which give the sample counts (n_theta = rows, n_phi = columns).

    `has_grid` says whether the SCAN DATA actually carried row/column indices
    (a true raster). indexBounds is only trusted for sample counts when it does:
    pye57 writes a degenerate indexBounds even for a flat, unstructured cloud
    (rowMaximum = point_count - 1), which would otherwise masquerade as a zenith
    resolution. Angular bounds (sphericalBounds) are independent of the grid and
    are read whenever present.

    Both sub-structures are optional in the spec; many files omit one or both.
    Every field is guarded independently — whatever isn't present is simply left
    out so the renderer falls back to its default (XML-parity behaviour: blank
    stays blank). Returns a dict with only the recoverable keys (may be empty).
    """
    params: dict = {}

    # Angular sweep from sphericalBounds (radians -> degrees, elevation->zenith).
    try:
        sb = header["sphericalBounds"]
    except Exception:
        sb = None
    if sb is not None:
        def _node_val(name):
            try:
                return float(sb[name].value())
            except Exception:
                return None
        az_start = _node_val("azimuthStart")
        az_end = _node_val("azimuthEnd")
        el_min = _node_val("elevationMinimum")
        el_max = _node_val("elevationMaximum")
        if az_start is not None and az_end is not None:
            params["phi_min"] = math.degrees(az_start)
            params["phi_max"] = math.degrees(az_end)
        if el_min is not None and el_max is not None:
            # zenith = 90 - elevation; min/max swap under the negation.
            params["theta_min"] = 90.0 - math.degrees(el_max)
            params["theta_max"] = 90.0 - math.degrees(el_min)

    # Grid resolution from indexBounds (row/column counts = sample counts), but
    # only when the scan is genuinely a raster (carried row/column indices) —
    # otherwise pye57's degenerate indexBounds would fake a zenith resolution.
    try:
        ib = header["indexBounds"] if has_grid else None
    except Exception:
        ib = None
    if ib is not None:
        def _ib_count(min_name, max_name):
            try:
                lo = int(ib[min_name].value())
                hi = int(ib[max_name].value())
            except Exception:
                return None
            n = hi - lo + 1
            return n if n > 1 else None
        n_rows = _ib_count("rowMinimum", "rowMaximum")
        n_cols = _ib_count("columnMinimum", "columnMaximum")
        # E57 grids are row=elevation/theta, column=azimuth/phi.
        if n_rows is not None:
            params["n_theta"] = n_rows
        if n_cols is not None:
            params["n_phi"] = n_cols

    return params


def _e57_to_las(source_path: _Path, out_las: _Path) -> tuple[int, List[dict]]:
    """Convert an E57 to LAS, recovering sky/miss points from the structured
    grid so the LAD inversion can account for beams that returned nothing.

    E57 carries each scan as a structured grid; a cell with no return is flagged
    via `cartesianInvalidState` (or `sphericalInvalidState`). We read the RAW
    scan (all cells, in the scanner-local frame) so misses survive, then:
      - valid cells -> real world point (pose-transformed), `is_miss = 0`;
      - invalid cells (misses) -> `is_miss = 1`. When a direction is recoverable
        (spherical angles, or a non-zero cartesian vector) the miss is PLACED at
        a far-field point `origin + dir * gap_distance` along the pulse direction,
        matching how Helios stores a miss. When it is NOT recoverable here (the
        common cartesian-grid case where invalid cells are zeroed and there are
        no spherical angles), the miss is KEPT and flagged but left at the scanner
        origin: direction recovery from the row/column raster (with tilt/noise
        handling and edge extrapolation) is done downstream in Helios C++. We
        preserve `row_index`/`column_index` so that recovery has the grid to work
        from. Unplaceable misses are counted and surfaced, never silently dropped.

    Each scan is transformed by ITS OWN pose (rotation + translation); a
    multi-scan E57 merges into one cloud with every scan's misses placed relative
    to its own origin. The first scan's origin is stashed in `_e57_scan_meta`
    (plus per-scan origins + the unplaceable-miss count) for the create endpoint.
    Intensity is normalised per scan from its observed valid range (E57 intensity
    is often 0..1 float); RGB colour (colorRed/Green/Blue) is carried into the LAS
    when present (misses get black). Returns (n, extra_dims) with `is_miss` always
    present and `row_index`/`column_index` present when the source carried a grid.
    """
    import laspy  # local: only when this code path runs
    import pye57

    e = pye57.E57(str(source_path))
    try:
        n_scans = e.scan_count
        if n_scans == 0:
            raise HTTPException(status_code=400, detail="E57 file has no scans.")

        all_xyz: List[np.ndarray] = []
        all_miss: List[np.ndarray] = []
        all_intensity: List[np.ndarray] = []
        all_rgb: List[np.ndarray] = []
        all_row: List[np.ndarray] = []
        all_col: List[np.ndarray] = []
        any_intensity = False
        any_color = False
        any_grid = False
        scan_origins: List[list] = []
        scan_params_list: List[dict] = []
        unplaceable_misses = 0

        for si in range(n_scans):
            header = e.get_header(si)
            try:
                rot = np.asarray(header.rotation_matrix, dtype=np.float64).reshape(3, 3)
            except Exception:
                rot = np.eye(3)
            try:
                trans = np.asarray(header.translation, dtype=np.float64).reshape(3)
            except Exception:
                trans = np.zeros(3)
            scan_origins.append(trans.tolist())

            raw = e.read_scan_raw(si)
            keys = set(raw.keys())

            # Local-frame cartesian for every cell (misses may be zeroed).
            if {"cartesianX", "cartesianY", "cartesianZ"} <= keys:
                local = np.column_stack([
                    np.asarray(raw["cartesianX"], dtype=np.float64),
                    np.asarray(raw["cartesianY"], dtype=np.float64),
                    np.asarray(raw["cartesianZ"], dtype=np.float64),
                ])
            elif {"sphericalRange", "sphericalAzimuth", "sphericalElevation"} <= keys:
                rng = np.asarray(raw["sphericalRange"], dtype=np.float64)
                az = np.asarray(raw["sphericalAzimuth"], dtype=np.float64)
                el = np.asarray(raw["sphericalElevation"], dtype=np.float64)
                local = np.column_stack([
                    rng * np.cos(el) * np.cos(az),
                    rng * np.cos(el) * np.sin(az),
                    rng * np.sin(el),
                ])
            else:
                raise HTTPException(
                    status_code=400,
                    detail="E57 scan has neither cartesian nor spherical point data.",
                )

            n_cell = local.shape[0]
            # Recover this scan's scan-pattern parameters (angular sweep + grid
            # resolution) so a non-XML E57 import auto-populates ScanParameters,
            # the same way an XML import does. Whatever the file omits is left
            # out and the renderer falls back to its default. Grid resolution is
            # only trusted when the scan is a true raster (carried row/column
            # indices) — see _e57_scan_params.
            cell_has_grid = {"rowIndex", "columnIndex"} <= keys
            sp = _e57_scan_params(header, cell_has_grid)
            sp["origin"] = trans.tolist()
            scan_params_list.append(sp)

            # Miss flag: prefer the explicit invalid-state field. invalidState
            # is 0 for a good return, non-zero for a miss/invalid cell.
            miss = np.zeros(n_cell, dtype=bool)
            for inv_key in ("cartesianInvalidState", "sphericalInvalidState"):
                if inv_key in keys:
                    miss = np.asarray(raw[inv_key]).astype(np.int64) != 0
                    break

            # Per-cell pulse direction (local frame). For misses with zeroed
            # cartesian, recover direction from spherical angles when present.
            local_dir = local.copy()
            if miss.any() and {"sphericalAzimuth", "sphericalElevation"} <= keys:
                az = np.asarray(raw["sphericalAzimuth"], dtype=np.float64)
                el = np.asarray(raw["sphericalElevation"], dtype=np.float64)
                sdir = np.column_stack([
                    np.cos(el) * np.cos(az),
                    np.cos(el) * np.sin(az),
                    np.sin(el),
                ])
                local_dir[miss] = sdir[miss]

            dir_norm = np.linalg.norm(local_dir, axis=1)
            # A miss we can place here has a usable direction; one we can't
            # (zeroed cartesian, no spherical) is KEPT and flagged for Helios to
            # recover from the grid, not dropped.
            placeable_miss = miss & (dir_norm >= 1e-9)
            unplaceable_miss = miss & (dir_norm < 1e-9)
            unplaceable_misses += int(unplaceable_miss.sum())

            # World coords: pose-transform real hits; far-field place the misses
            # we can; leave unplaceable misses at the scanner origin (flagged).
            world = (rot @ local.T).T + trans
            if placeable_miss.any():
                unit = local_dir[placeable_miss] / dir_norm[placeable_miss][:, None]
                world_dir = (rot @ unit.T).T
                world[placeable_miss] = trans + world_dir * _MISS_GAP_DISTANCE
            if unplaceable_miss.any():
                world[unplaceable_miss] = trans  # at origin until C++ recovery

            all_xyz.append(world)
            all_miss.append(miss.astype(np.float32))

            # Preserve the structured-grid indices so downstream (Helios C++) can
            # recover unplaceable-miss directions from the raster.
            if {"rowIndex", "columnIndex"} <= keys:
                all_row.append(np.asarray(raw["rowIndex"], dtype=np.float32))
                all_col.append(np.asarray(raw["columnIndex"], dtype=np.float32))
                any_grid = True
            else:
                all_row.append(np.full(n_cell, -1.0, dtype=np.float32))
                all_col.append(np.full(n_cell, -1.0, dtype=np.float32))

            if "intensity" in keys:
                inten = np.asarray(raw["intensity"], dtype=np.float64)
                # Normalise from the VALID cells' observed range to LAS uint16.
                # E57 intensity is commonly 0..1 float; a flat clip(0,65535) would
                # crush it to ~0. Misses have no real return -> 0.
                valid = ~miss
                if valid.any():
                    lo = float(np.nanmin(inten[valid]))
                    hi = float(np.nanmax(inten[valid]))
                else:
                    lo, hi = 0.0, 1.0
                span = hi - lo
                if span > 1e-12:
                    scaled = (inten - lo) / span * 65535.0
                else:
                    scaled = np.zeros_like(inten)
                scaled[miss] = 0.0
                all_intensity.append(np.clip(scaled, 0, 65535).astype(np.float32))
                any_intensity = True
            else:
                all_intensity.append(np.zeros(n_cell, dtype=np.float32))

            # RGB colour, when the scan carries it. E57 stores per-channel
            # colorRed/Green/Blue, usually uint8 0..255 but the spec allows other
            # integer ranges (declared in the file's colorLimits). Normalise each
            # channel from its declared/observed max to 8-bit, then store as the
            # LAS uint16 convention (8-bit << 8) used by the PLY/PCD paths. Misses
            # get black — they have no real return.
            if {"colorRed", "colorGreen", "colorBlue"} <= keys:
                cr = np.asarray(raw["colorRed"], dtype=np.float64)
                cg = np.asarray(raw["colorGreen"], dtype=np.float64)
                cb = np.asarray(raw["colorBlue"], dtype=np.float64)
                cmax = float(max(cr.max(initial=0.0), cg.max(initial=0.0),
                                 cb.max(initial=0.0)))
                # Scale so the brightest channel value maps to 255. Files that are
                # already 0..255 (the common case) pass through unchanged; a
                # 0..1 or 0..65535 file is brought into 8-bit range.
                scale = (255.0 / cmax) if cmax > 255.0 or (0.0 < cmax <= 1.0) else 1.0
                rgb8 = np.clip(
                    np.column_stack([cr, cg, cb]) * scale, 0, 255
                ).astype(np.uint16)
                rgb8[miss] = 0
                all_rgb.append(rgb8)
                any_color = True
            else:
                all_rgb.append(np.zeros((n_cell, 3), dtype=np.uint16))
    finally:
        e.close()

    xyz = np.concatenate(all_xyz, axis=0) if all_xyz else np.empty((0, 3), np.float64)
    is_miss = np.concatenate(all_miss, axis=0) if all_miss else np.empty((0,), np.float32)
    intensity = (np.concatenate(all_intensity, axis=0) if all_intensity
                 else np.empty((0,), np.float32))
    rgb = (np.concatenate(all_rgb, axis=0) if all_rgb
           else np.empty((0, 3), np.uint16))
    row_idx = np.concatenate(all_row, axis=0) if all_row else np.empty((0,), np.float32)
    col_idx = np.concatenate(all_col, axis=0) if all_col else np.empty((0,), np.float32)
    n = int(xyz.shape[0])

    extra_dims = [{"slug": _MISS_SLUG, "label": _MISS_LABEL}]
    if any_grid:
        extra_dims.append({"slug": "row_index", "label": "Row Index"})
        extra_dims.append({"slug": "column_index", "label": "Column Index"})

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))

    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    if n > 0:
        record.x = xyz[:, 0]
        record.y = xyz[:, 1]
        record.z = xyz[:, 2]
        if any_intensity:
            record.intensity = np.clip(intensity, 0, 65535).astype(np.uint16)
        if any_color:
            # Point format 3 carries RGB; *256 lifts 8-bit into the 16-bit LAS
            # channel, matching _ply_to_las / _pcd_to_las so colours render
            # identically regardless of source format.
            record.red = rgb[:, 0] * 256
            record.green = rgb[:, 1] * 256
            record.blue = rgb[:, 2] * 256
        record[_MISS_SLUG] = is_miss
        if any_grid:
            record["row_index"] = row_idx
            record["column_index"] = col_idx

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        writer.write_points(record)

    _e57_scan_meta[str(out_las.resolve())] = {
        "origin": (scan_origins[0] if scan_origins else [0.0, 0.0, 0.0]),
        "scan_origins": scan_origins,
        # Full scan-pattern parameters of the first scan (origin + whatever
        # angular sweep / grid resolution the file carried). create_cloud_session
        # forwards this so a lone-E57 import auto-creates a Scan with populated
        # ScanParameters, mirroring the Helios-XML import path.
        "scan_params": (scan_params_list[0] if scan_params_list else {"origin": [0.0, 0.0, 0.0]}),
        "has_misses": bool(is_miss.any()),
        "miss_count": int(is_miss.sum()),
        "unplaceable_miss_count": unplaceable_misses,
    }
    return n, extra_dims


def _las_extra_dim_labels(source_path: _Path) -> List[dict]:
    """Read a LAS/LAZ file's extra-dimension names (header only) so a passed-
    through octree still gets a slug→label sidecar.

    LAS/LAZ feed PotreeConverter unchanged, so their native extra dimensions
    already survive into the octree — but without a sidecar the renderer shows
    raw slugs. The LAS field name is already canonical, so slug == label.
    Reading just the header is cheap (no point data is decoded).
    """
    import laspy  # local: only when this code path runs

    try:
        with laspy.open(str(source_path)) as reader:
            dims = [d.name for d in reader.header.point_format.extra_dimensions]
    except Exception:
        # A malformed/unreadable header shouldn't block conversion; the file
        # is handed to PotreeConverter regardless, and the renderer falls back
        # to raw slugs when the sidecar is absent.
        return []
    return [{"slug": d, "label": d} for d in dims]


def _source_to_las(source_path: _Path, ascii_format: Optional[str], work_dir: _Path,
                   column_plan: "Optional[ColumnPlan]" = None) -> tuple[_Path, bool, List[dict]]:
    """Get a LAS file path for `source_path`, converting from another format
    if needed.

    Returns (las_path, is_temp, extra_dims) — caller deletes the file if
    is_temp. `extra_dims` is the [{slug, label}, ...] list of carried scalar
    attributes (read from the header for LAS/LAZ; derived during conversion for
    XYZ/PLY; empty for PCD, which carries position + RGB only).

    `column_plan` (import wizard) applies only to the XYZ-family branch; PLY/PCD/
    LAS define their own layout and ignore it.
    """
    ext = source_path.suffix.lower().lstrip(".")
    if ext in ("las", "laz"):
        return source_path, False, _las_extra_dim_labels(source_path)
    if ext in _PANDAS_EXTENSIONS:
        out = work_dir / (source_path.stem + ".las")
        _, extra_dims = _xyz_to_las(source_path, ascii_format, out, column_plan)
        return out, True, extra_dims
    if ext == "ply":
        out = work_dir / (source_path.stem + ".las")
        _, extra_dims = _ply_to_las(source_path, out)
        return out, True, extra_dims
    if ext == "pcd":
        out = work_dir / (source_path.stem + ".las")
        _, extra_dims = _pcd_to_las(source_path, out)
        return out, True, extra_dims
    if ext == "e57":
        out = work_dir / (source_path.stem + ".las")
        _, extra_dims = _e57_to_las(source_path, out)
        return out, True, extra_dims
    raise HTTPException(
        status_code=400,
        detail=f"Unsupported source extension for octree conversion: .{ext}",
    )


def _run_potree_converter(input_las: _Path, out_dir: _Path) -> None:
    """Invoke PotreeConverter on input_las, writing to out_dir.

    PyInstaller-bundled Pythons inject DYLD_LIBRARY_PATH / LD_LIBRARY_PATH
    pointing at the bundle's libs. Those collide with PotreeConverter's
    expectation of system libs, so we scrub them before spawning the child.
    """
    converter = _resolve_potree_converter_path()
    out_dir.mkdir(parents=True, exist_ok=True)

    env = _os.environ.copy()
    for var in ("DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "LD_LIBRARY_PATH"):
        env.pop(var, None)

    # No --attributes filter: PotreeConverter's default writes the full
    # LAS attribute schema (37 bytes/point). The renderer's potree-core
    # decoder is laid out for that exact byte ordering — filtering with
    # `--attributes position rgb intensity` produces a 20-byte stride but
    # the metadata's two `position` entries (Potree 2.0's morton-encoded
    # double-uint32 position format) make the worker expect 16 bytes per
    # point for position alone, which gives every-other-point garbage on
    # the filtered layout. Trading ~17 bytes/point of cache size for a
    # correct render.
    cmd = [
        str(converter),
        str(input_las),
        "-o", str(out_dir),
    ]
    result = _subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        # Surface the converter's stderr tail directly so failures are debuggable.
        tail = (result.stderr or result.stdout or "")[-1500:]
        raise HTTPException(
            status_code=500,
            detail=f"PotreeConverter failed (exit {result.returncode}): {tail}",
        )


# Sidecar JSON mapping LAS extra-dimension slugs to human-readable labels.
# Written alongside metadata.json at conversion time and read back by
# _read_octree_metadata so the renderer can show clean picker labels
# (e.g. slug 'Reflectance_dB' → label 'Reflectance [dB]') even on cache hits.
_OCTREE_LABELS_FILENAME = "attribute_labels.json"


def _write_octree_labels(octree_dir: _Path, extra_dims: List[dict]) -> None:
    """Persist the slug→label map for an octree's extra dimensions.

    No-op when there are no extra dims, so LAS/LAZ-sourced octrees don't grow
    an empty sidecar. `extra_dims` is the list returned by `_xyz_to_las`.
    """
    if not extra_dims:
        return
    mapping = {ed["slug"]: ed["label"] for ed in extra_dims}
    (octree_dir / _OCTREE_LABELS_FILENAME).write_text(json.dumps(mapping))


def _read_octree_labels(octree_dir: _Path) -> dict:
    """Load the slug→label sidecar, or {} if absent/unreadable.

    Octrees built before this feature (or from LAS/LAZ) have no sidecar; the
    renderer falls back to showing the raw slug in that case.
    """
    p = octree_dir / _OCTREE_LABELS_FILENAME
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text())
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _read_octree_metadata(octree_dir: _Path) -> dict:
    """Load metadata.json and return a renderer-friendly subset.

    Two quirks of PotreeConverter 2.x output we work around here:
      1. The JSON contains lowercase `inf`/`-inf` literals on uninitialised
         min/max fields for one of the attribute entries. Standard JSON
         rejects these, so we rewrite them to `null` before parsing.
      2. The attribute list often contains a duplicate `position` entry —
         a placeholder that never gets updated. We keep only the first
         occurrence of each attribute name.

    Extra-dimension attributes (carried from unmapped numeric source columns)
    get a human-readable `label` attached from the slug→label sidecar so the
    renderer's scalar picker can show clean names.
    """
    labels = _read_octree_labels(octree_dir)
    meta_path = octree_dir / "metadata.json"
    if not meta_path.is_file():
        raise HTTPException(
            status_code=500,
            detail=f"metadata.json missing from octree dir: {octree_dir}",
        )
    raw_text = meta_path.read_text()
    raw_text = re.sub(r'(?<![\w\.])-?inf(?![\w\.])', 'null', raw_text)
    raw_text = re.sub(r'(?<![\w\.])nan(?![\w\.])', 'null', raw_text)
    raw = json.loads(raw_text)
    bbox = raw.get("boundingBox", {})

    # PotreeConverter writes the FULL position attribute schema as two
    # entries: a primary "position" with the true min/max bounds, and a
    # second "position" with morton-encoded extension bits (uninitialised
    # min/max, hence the `inf` literals). The first occurrence is the one
    # we want for tight bounds; subsequent ones get dropped here.
    seen_attrs: set[str] = set()
    deduped = []
    tight_bounds = None
    for a in raw.get("attributes", []):
        name = a.get("name")
        if not name or name in seen_attrs:
            continue
        seen_attrs.add(name)
        # Preserve per-attribute min/max when present. The renderer needs
        # these for the intensity / height shaders' uniform ranges
        # (intensityRange, heightMin/Max) — without them the shader maps
        # every point to the same gradient sample and the cloud renders
        # as a solid colour.
        amin = a.get("min")
        amax = a.get("max")
        entry: dict = {
            "name": name,
            "size": int(a.get("size", 0)),
            "type": a.get("type"),
            "num_elements": int(a.get("numElements", 0)),
        }
        if name in labels:
            entry["label"] = labels[name]
        if isinstance(amin, list) and isinstance(amax, list):
            # Filter out None entries (came from `inf` rewrite).
            if all(v is not None for v in amin) and all(v is not None for v in amax):
                entry["min"] = [float(v) for v in amin]
                entry["max"] = [float(v) for v in amax]
        deduped.append(entry)
        if name == "position" and tight_bounds is None:
            mn = a.get("min")
            mx = a.get("max")
            # Skip if the values were rewritten to None by the `inf` sub.
            if (isinstance(mn, list) and isinstance(mx, list)
                and len(mn) == 3 and len(mx) == 3
                and all(v is not None for v in mn + mx)):
                tight_bounds = {"min": [float(v) for v in mn],
                                "max": [float(v) for v in mx]}

    return {
        "version": raw.get("version", "2.0"),
        "point_count": int(raw.get("points", 0)),
        "spacing": float(raw.get("spacing", 0.0)),
        "scale": list(raw.get("scale", [1.0, 1.0, 1.0])),
        "offset": list(raw.get("offset", [0.0, 0.0, 0.0])),
        # `bounds` is PotreeConverter's cube-padded octree extent (used by
        # the loader for LOD math). `tight_bounds` is the actual data
        # extent — what the UI should use for camera framing and crop-box
        # initialisation. Fall back to the padded box if the tight values
        # were missing.
        "bounds": {
            "min": list(bbox.get("min", [0.0, 0.0, 0.0])),
            "max": list(bbox.get("max", [0.0, 0.0, 0.0])),
        },
        "tight_bounds": tight_bounds or {
            "min": list(bbox.get("min", [0.0, 0.0, 0.0])),
            "max": list(bbox.get("max", [0.0, 0.0, 0.0])),
        },
        "attributes": deduped,
    }


def _dir_total_size(p: _Path) -> int:
    """Sum of sizes of regular files at any depth under p. Symlinks ignored."""
    total = 0
    for child in p.rglob("*"):
        try:
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
        except (FileNotFoundError, PermissionError):
            # File can disappear between iterdir and stat (concurrent eviction).
            continue
    return total


def _evict_octree_cache(max_bytes: int, keep: Optional[_Path] = None) -> List[str]:
    """Trim the octree cache to at most `max_bytes` of regular file content,
    removing oldest-accessed cache directories first. Returns the cache_ids
    that were evicted.

    `keep`, if provided, is never evicted — pass the cache dir we just wrote
    so a single fresh convert doesn't immediately drop itself when the cache
    is at the limit.
    """
    root = _octree_cache_root()
    if not root.is_dir():
        return []

    # Skip the .staging dirs and any non-sha1 entries (defensive against
    # files dropped in here by other tools).
    entries: list[tuple[float, _Path]] = []
    for child in root.iterdir():
        if not child.is_dir():
            continue
        if child.name.endswith(".staging"):
            continue
        if len(child.name) != 40 or not all(c in "0123456789abcdef" for c in child.name):
            continue
        try:
            atime = child.stat().st_atime
        except FileNotFoundError:
            continue
        entries.append((atime, child))

    # Oldest first.
    entries.sort(key=lambda e: e[0])

    total = sum(_dir_total_size(p) for _, p in entries)
    evicted: List[str] = []
    if total <= max_bytes:
        return evicted

    for _, candidate in entries:
        if total <= max_bytes:
            break
        if keep is not None and candidate.resolve() == keep.resolve():
            continue
        size = _dir_total_size(candidate)
        try:
            _shutil.rmtree(candidate)
        except (FileNotFoundError, PermissionError):
            continue
        evicted.append(candidate.name)
        total -= size

    return evicted


# ---------------------------------------------------------------------------
# Import-wizard preview
# ---------------------------------------------------------------------------

# How a value column reads, used to pre-tick the wizard's "categorical" box.
_CATEGORICAL_MAX_DISTINCT = 32


def _detect_ascii_delimiter(file_path: str) -> Optional[str]:
    """Sniff the delimiter of the first data row. Mirrors the renderer's
    detectDelimiter precedence (comma → tab → semicolon → whitespace). Returns a
    human label ('comma'/'tab'/'semicolon'/'whitespace') or None if no data."""
    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            # Skip a leading text header row — we want a data row's delimiter.
            if any(re.search(r'[a-zA-Z]', tok) for tok in line.split()):
                continue
            if ',' in line:
                return 'comma'
            if '\t' in line:
                return 'tab'
            if ';' in line:
                return 'semicolon'
            return 'whitespace'
    return None


def _split_ascii_row(line: str, delimiter: Optional[str]) -> List[str]:
    if delimiter == 'comma':
        return [t.strip() for t in line.split(',')]
    if delimiter == 'tab':
        return [t.strip() for t in line.split('\t')]
    if delimiter == 'semicolon':
        return [t.strip() for t in line.split(';')]
    return line.split()


def _read_ascii_sample_rows(file_path: str, delimiter: Optional[str],
                            skip_header: bool, max_rows: int) -> List[List[str]]:
    """Return up to `max_rows` data rows as raw string tokens. Reads at most
    that many lines — never the whole file.

    `skip_header` drops a single leading header row. A *commented* header
    ('# x y z ...') is already dropped by the comment-line skip below, so we
    must NOT also consume the first data row — otherwise the wizard preview
    would silently lose row one. Detect that case up front."""
    # A commented header is removed by the '#'/'//' filter, so there is no
    # uncommented header row left to skip.
    first = _first_nonblank_ascii_line(file_path)
    header_is_commented = first is not None and first[1]
    rows: List[List[str]] = []
    header_skipped = (not skip_header) or header_is_commented
    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            if not header_skipped:
                header_skipped = True
                continue
            rows.append(_split_ascii_row(line, delimiter))
            if len(rows) >= max_rows:
                break
    return rows


def _column_type_hint(values: List[str]) -> str:
    """Sniff a value shape from sampled string tokens. 'categorical' when the
    column is small non-negative integers with few distinct values (a class /
    label column); else integer/float/empty."""
    nonblank = [v for v in values if v != '']
    if not nonblank:
        return 'empty'
    all_int = all(re.fullmatch(r'-?\d+', v) is not None for v in nonblank)
    if all_int:
        ints = [int(v) for v in nonblank]
        distinct = set(ints)
        if all(i >= 0 for i in ints) and len(distinct) <= _CATEGORICAL_MAX_DISTINCT:
            return 'categorical'
        return 'integer'
    all_float = True
    for v in nonblank:
        try:
            float(v)
        except ValueError:
            all_float = False
            break
    return 'float' if all_float else 'categorical'


def _preview_ascii(file_path: str, ascii_format: Optional[str],
                   max_rows: int) -> PointCloudPreviewResponse:
    header_names = _read_ascii_header_names(file_path)
    has_header = header_names is not None
    delimiter = _detect_ascii_delimiter(file_path)
    sample_rows = _read_ascii_sample_rows(file_path, delimiter, has_header, max_rows)

    roles = (_tokenize_ascii_format(ascii_format)
             if ascii_format
             else _autodetect_xyz_columns(file_path))
    # Determine column count from the widest of (roles, header, first row).
    ncols = len(roles)
    if header_names:
        ncols = max(ncols, len(header_names))
    if sample_rows:
        ncols = max(ncols, max(len(r) for r in sample_rows))

    columns: List[PreviewColumn] = []
    for i in range(ncols):
        role = roles[i] if i < len(roles) else 'skip'
        # Re-derive the same default slug/label _plan_columns would assign for
        # THIS position, so the wizard's suggestion matches import before edits.
        if role in _XYZ_RESERVED_ROLES and role != 'skip':
            detected_role = role
            suggested_slug = ''
            suggested_label = (header_names[i] if header_names and i < len(header_names)
                               and header_names[i] else role)
        elif role in _MULTI_RETURN_SLUGS:
            # A per-pulse multi-return column (timestamp/target_index/
            # target_count): pin the canonical slug/label regardless of header
            # text, exactly as `_plan_columns` does, so the wizard's column plan
            # carries it under the name the LAD accessor recovers it by. Without
            # this the column defaulted to a positional 'col_N' slug, the LAD
            # path failed to find the three multi-return columns, and the
            # full-waveform inversion ran on zeroed data.
            detected_role = 'extra'
            suggested_slug = role
            suggested_label = _MULTI_RETURN_LABELS[role]
        elif role in _GRID_INDEX_SLUGS:
            # A structured-scan raster index (row_index/column_index): the wizard
            # exposes these as dedicated dropdown roles, so report the role token
            # directly (not 'extra') to pre-select the matching option. The slug
            # is pinned to the canonical name so the recovery path finds the grid.
            detected_role = role
            suggested_slug = role
            suggested_label = _GRID_INDEX_LABELS[role]
        elif role == _MISS_SLUG:
            # A sky/miss flag: carried as a scalar extra dim under the canonical
            # is_miss slug (the wizard has no dedicated miss role), so the LAD
            # path and renderer find it by name regardless of the source spelling
            # (is_miss/miss/sky). Pin the slug/label to match `_plan_columns`.
            detected_role = 'extra'
            suggested_slug = _MISS_SLUG
            suggested_label = _MISS_LABEL
        else:
            detected_role = 'extra' if role != 'skip' else 'skip'
            if header_names is not None and i < len(header_names) and header_names[i]:
                suggested_label = _humanize_extra_dim_label(header_names[i])
                suggested_slug = _sanitize_extra_dim_name(header_names[i])
            else:
                suggested_label = f"Column {i + 1}"
                suggested_slug = f"col_{i + 1}"
        col_values = [r[i] for r in sample_rows if i < len(r)]
        columns.append(PreviewColumn(
            index=i,
            header_name=(header_names[i] if header_names and i < len(header_names) else None),
            detected_role=detected_role,
            suggested_label=suggested_label,
            suggested_slug=suggested_slug,
            type_hint=_column_type_hint(col_values),
            remappable=True,
        ))

    return PointCloudPreviewResponse(
        kind='ascii', delimiter=delimiter, has_header=has_header,
        columns=columns, sample_rows=sample_rows,
    )


def _ply_header_properties(file_path: str) -> tuple[List[str], bool, List[List[str]], int]:
    """Parse a PLY header without decoding the body. Returns
    (vertex_property_names, is_ascii, sample_rows, vertex_count). sample_rows is
    empty for binary PLY (we don't decode it for preview)."""
    props: List[str] = []
    fmt = 'ascii'
    vertex_count = 0
    in_vertex = False
    header_lines = 0
    with open(file_path, 'rb') as f:
        for raw in f:
            header_lines += 1
            line = raw.decode('latin-1', errors='replace').strip()
            low = line.lower()
            if low.startswith('format'):
                fmt = low.split()[1] if len(low.split()) > 1 else 'ascii'
            elif low.startswith('element '):
                parts = line.split()
                in_vertex = len(parts) >= 2 and parts[1].lower() == 'vertex'
                if in_vertex and len(parts) >= 3:
                    try:
                        vertex_count = int(parts[2])
                    except ValueError:
                        vertex_count = 0
            elif low.startswith('property') and in_vertex:
                props.append(line.split()[-1])
            elif low == 'end_header':
                break
            if header_lines > 1000:  # malformed / not really a PLY
                break

    sample_rows: List[List[str]] = []
    if fmt == 'ascii':
        with open(file_path) as f:
            past_header = False
            taken = 0
            for raw in f:
                s = raw.strip()
                if not past_header:
                    if s.lower() == 'end_header':
                        past_header = True
                    continue
                if not s:
                    continue
                sample_rows.append(s.split())
                taken += 1
                if taken >= 20:
                    break
    return props, fmt == 'ascii', sample_rows, vertex_count


def _ply_role_for(name: str) -> str:
    n = name.lower()
    if n in ('x', 'y', 'z'):
        return n
    if n in ('red', 'green', 'blue', 'r', 'g', 'b'):
        return {'red': 'r255', 'green': 'g255', 'blue': 'b255',
                'r': 'r255', 'g': 'g255', 'b': 'b255'}[n]
    if n in ('intensity', 'scalar_intensity', 'reflectance'):
        return 'intensity'
    return 'extra'


def _preview_ply(file_path: str) -> PointCloudPreviewResponse:
    props, is_ascii, sample_rows, _ = _ply_header_properties(file_path)
    columns: List[PreviewColumn] = []
    for i, name in enumerate(props):
        # `is_miss`/`miss`/`sky` is a system-managed sky/miss flag, not a
        # user-mappable column — keep it out of the wizard.
        if name.lower() in _MISS_ALIASES:
            continue
        role = _ply_role_for(name)
        is_extra = role == 'extra'
        col_values = [r[i] for r in sample_rows if i < len(r)]
        columns.append(PreviewColumn(
            index=i, header_name=name, detected_role=role,
            suggested_label=_humanize_extra_dim_label(name) if is_extra else name,
            suggested_slug=_sanitize_extra_dim_name(name) if is_extra else '',
            type_hint=_column_type_hint(col_values) if sample_rows else ('float' if is_extra else 'float'),
            remappable=False,
        ))
    warning = None if is_ascii else "Binary PLY: preview rows unavailable (fields shown from header)."
    return PointCloudPreviewResponse(
        kind='ply', delimiter=None, has_header=True,
        columns=columns, sample_rows=sample_rows, warning=warning,
    )


def _preview_pcd(file_path: str) -> PointCloudPreviewResponse:
    fields: List[str] = []
    with open(file_path, 'rb') as f:
        for raw in f:
            line = raw.decode('latin-1', errors='replace').strip()
            low = line.lower()
            if low.startswith('fields'):
                fields = line.split()[1:]
            elif low.startswith('data'):
                break
    columns: List[PreviewColumn] = []
    for i, name in enumerate(fields):
        n = name.lower()
        role = ('x' if n == 'x' else 'y' if n == 'y' else 'z' if n == 'z'
                else 'r255' if n in ('r', 'red') else 'g255' if n in ('g', 'green')
                else 'b255' if n in ('b', 'blue') else 'r255' if n == 'rgb' else 'extra')
        columns.append(PreviewColumn(
            index=i, header_name=name, detected_role=role,
            suggested_label=name, suggested_slug='', type_hint='float',
            remappable=False,
        ))
    return PointCloudPreviewResponse(
        kind='pcd', delimiter=None, has_header=True, columns=columns,
        sample_rows=[],
        warning="PCD import preserves position and RGB only; other scalar fields are dropped.",
    )


def _preview_las(file_path: str, max_rows: int) -> PointCloudPreviewResponse:
    import laspy
    columns: List[PreviewColumn] = []
    sample_rows: List[List[str]] = []
    with laspy.open(file_path) as reader:
        header = reader.header
        std = ['X', 'Y', 'Z']
        pf = header.point_format
        names = [d.name for d in pf.dimensions]
        # Present standard + extra dims; mark x/y/z and rgb/intensity roles.
        def role_for(n: str) -> str:
            ln = n.lower()
            if ln in ('x', 'y', 'z'):
                return ln
            if ln == 'red':
                return 'r255'
            if ln == 'green':
                return 'g255'
            if ln == 'blue':
                return 'b255'
            if ln == 'intensity':
                return 'intensity'
            return 'extra'
        extra_names = {d.name for d in pf.extra_dimensions}
        for i, n in enumerate(names):
            # `is_miss` is a system-managed sky/miss flag, not a user-mappable
            # column — never present it in the wizard (and don't let it be
            # renamed off the canonical slug the renderer/LAD depend on).
            if n.lower() in _MISS_ALIASES:
                continue
            role = role_for(n)
            is_extra = n in extra_names or role == 'extra'
            columns.append(PreviewColumn(
                index=i, header_name=n, detected_role=role,
                suggested_label=n, suggested_slug=n if is_extra else '',
                type_hint='categorical' if n.lower() == 'classification' else 'float',
                remappable=False,
            ))
        # Cheap value sample: read a small batch of points.
        try:
            pts = reader.read_points(min(max_rows, 20))
            for k in range(len(pts)):
                row = []
                for n in names:
                    try:
                        row.append(str(pts[n][k]))
                    except Exception:
                        row.append('')
                sample_rows.append(row)
        except Exception:
            sample_rows = []
    return PointCloudPreviewResponse(
        kind='las', delimiter=None, has_header=True, columns=columns,
        sample_rows=sample_rows,
    )


def _preview_e57(file_path: str) -> PointCloudPreviewResponse:
    """Summarise an E57's structure for the import wizard without decoding the
    full point data. Reports the scan count, total points, and which attributes
    the file carries (read cheaply from the first scan's declared `point_fields`,
    no point decode). Columns are fixed (E57 defines its own layout), so they're
    not remappable — we surface position plus whatever of intensity / RGB the
    file actually contains, so the user can see (and colour by) them.

    `is_miss` is deliberately omitted: it's a system-managed flag the converter
    populates, not a user column — showing it as an editable "scalar" would imply
    a rename the import ignores, and the flag is excluded from the octree anyway.
    """
    import pye57
    e = pye57.E57(file_path)
    try:
        n_scans = e.scan_count
        total = 0
        fields: set[str] = set()
        for si in range(n_scans):
            try:
                h = e.get_header(si)
                total += int(h.point_count)
                # Declared field names — available without decoding any points.
                fields.update(getattr(h, "point_fields", []) or [])
            except Exception:
                pass

        columns = [
            PreviewColumn(index=0, header_name='x', detected_role='x',
                          suggested_label='x', suggested_slug='', type_hint='float',
                          remappable=False),
            PreviewColumn(index=1, header_name='y', detected_role='y',
                          suggested_label='y', suggested_slug='', type_hint='float',
                          remappable=False),
            PreviewColumn(index=2, header_name='z', detected_role='z',
                          suggested_label='z', suggested_slug='', type_hint='float',
                          remappable=False),
        ]
        idx = 3
        # Surface the real scalars the converter carries through, so the wizard
        # shows the user what they'll be able to colour by (intensity / RGB).
        if 'intensity' in fields:
            columns.append(PreviewColumn(
                index=idx, header_name='intensity', detected_role='intensity',
                suggested_label='intensity', suggested_slug='', type_hint='float',
                remappable=False))
            idx += 1
        if {'colorRed', 'colorGreen', 'colorBlue'} <= fields:
            for ch, role in (('red', 'r255'), ('green', 'g255'), ('blue', 'b255')):
                columns.append(PreviewColumn(
                    index=idx, header_name=ch, detected_role=role,
                    suggested_label=ch, suggested_slug='', type_hint='float',
                    remappable=False))
                idx += 1

        warn = (f"E57 with {n_scans} scan(s), ~{total} points. Sky/miss points "
                "are recovered from the structured grid and tagged for LAD "
                "(hidden by default; use 'Show sky/miss points' to view).")
    finally:
        e.close()
    return PointCloudPreviewResponse(
        kind='e57', delimiter=None, has_header=True, columns=columns,
        sample_rows=[], warning=warn,
    )


@app.post("/api/pointcloud/preview")
async def preview_pointcloud(request: PointCloudPreviewRequest) -> PointCloudPreviewResponse:
    """Cheaply inspect a point-cloud file for the import wizard.

    Reads only enough of the file to show the wizard what was auto-detected and
    a handful of sample rows. Never 500s on a parse problem — returns a 200 with
    a `warning` and best-effort columns so the wizard can still offer
    "import with auto-detect"."""
    source = _Path(request.file_path).expanduser()
    if not source.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {request.file_path}")
    max_rows = max(1, min(int(request.max_rows or 20), 100))
    ext = source.suffix.lower().lstrip('.')
    try:
        if ext in _PANDAS_EXTENSIONS:
            return _preview_ascii(str(source), request.ascii_format, max_rows)
        if ext == 'ply':
            return _preview_ply(str(source))
        if ext == 'pcd':
            return _preview_pcd(str(source))
        if ext == 'e57':
            return _preview_e57(str(source))
        if ext in ('las', 'laz'):
            return _preview_las(str(source), max_rows)
    except Exception as e:  # never block import on a preview failure
        return PointCloudPreviewResponse(
            kind=ext or 'ascii', delimiter=None, has_header=False,
            columns=[], sample_rows=[],
            warning=f"Could not preview this file ({e}). You can still import with auto-detect.",
        )
    return PointCloudPreviewResponse(
        kind=ext or 'ascii', delimiter=None, has_header=False,
        columns=[], sample_rows=[],
        warning=f"Unsupported extension for preview: .{ext}.",
    )


def _canonical_translation(translation: Optional[List[float]]) -> str:
    """Stable string form for hashing. None and (0,0,0) collide on purpose —
    a no-op translation has the same cache identity as no translation."""
    if translation is None:
        return ""
    if len(translation) != 3:
        raise HTTPException(
            status_code=400,
            detail="translation, if provided, must be a 3-element [x, y, z] array.",
        )
    if all(float(v) == 0.0 for v in translation):
        return ""
    return ",".join(f"{float(v):.9g}" for v in translation)


def _canonical_region(region: dict) -> str:
    """Stable string form of the crop region for cache keying. Same shape →
    same string; same string → same octree. Polygon points and matrices are
    serialised verbatim because re-cropping with even slightly different
    camera framing produces a different filter mask."""
    kind = region.get("kind")
    if kind == "box":
        mn = region.get("min", [])
        mx = region.get("max", [])
        invert = bool(region.get("invert", False))
        if len(mn) != 3 or len(mx) != 3:
            raise HTTPException(
                status_code=400,
                detail="region.min and region.max must each be 3-element arrays.",
            )
        return "box|{}|{}|{}".format(
            ",".join(f"{float(v):.9g}" for v in mn),
            ",".join(f"{float(v):.9g}" for v in mx),
            "1" if invert else "0",
        )
    if kind == "polygon":
        pts = region.get("points", [])
        proj = region.get("projection", [])
        view = region.get("view", [])
        canvas = region.get("canvas", {})
        invert = bool(region.get("invert", False))
        if not isinstance(pts, list) or len(pts) < 3:
            raise HTTPException(
                status_code=400,
                detail="region.points must have at least 3 [x, y] entries.",
            )
        if len(proj) != 16 or len(view) != 16:
            raise HTTPException(
                status_code=400,
                detail="region.projection and region.view must each be 16-element matrices.",
            )
        w = canvas.get("width")
        h = canvas.get("height")
        if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w <= 0 or h <= 0:
            raise HTTPException(
                status_code=400,
                detail="region.canvas must have positive width and height.",
            )
        pts_s = ";".join(f"{float(p[0]):.6g},{float(p[1]):.6g}" for p in pts)
        return "polygon|{}|{}|{}|{}x{}|{}".format(
            pts_s,
            ",".join(f"{float(v):.6g}" for v in proj),
            ",".join(f"{float(v):.6g}" for v in view),
            int(w), int(h),
            "1" if invert else "0",
        )
    if kind == "squares_union":
        centers = region.get("centers", [])
        half_sizes = region.get("half_sizes", [])
        proj = region.get("projection", [])
        view = region.get("view", [])
        canvas = region.get("canvas", {})
        invert = bool(region.get("invert", False))
        if not isinstance(centers, list) or not isinstance(half_sizes, list):
            raise HTTPException(
                status_code=400,
                detail="region.centers and region.half_sizes must be arrays.",
            )
        if len(centers) == 0 or len(centers) != len(half_sizes):
            raise HTTPException(
                status_code=400,
                detail="region.centers and region.half_sizes must be non-empty and the same length.",
            )
        for c in centers:
            if len(c) != 2:
                raise HTTPException(
                    status_code=400,
                    detail="each region.centers entry must be a 2-element [px, py] array.",
                )
        if any(float(h) <= 0 for h in half_sizes):
            raise HTTPException(
                status_code=400,
                detail="every region.half_sizes entry must be positive.",
            )
        if len(proj) != 16 or len(view) != 16:
            raise HTTPException(
                status_code=400,
                detail="region.projection and region.view must each be 16-element matrices.",
            )
        w = canvas.get("width")
        h = canvas.get("height")
        if not isinstance(w, (int, float)) or not isinstance(h, (int, float)) or w <= 0 or h <= 0:
            raise HTTPException(
                status_code=400,
                detail="region.canvas must have positive width and height.",
            )
        squares_s = ";".join(
            "{},{}".format(
                ",".join(f"{float(v):.6g}" for v in c),
                f"{float(hs):.6g}",
            )
            for c, hs in zip(centers, half_sizes)
        )
        return "squares_union|{}|{}|{}|{}x{}|{}".format(
            squares_s,
            ",".join(f"{float(v):.6g}" for v in proj),
            ",".join(f"{float(v):.6g}" for v in view),
            int(w), int(h),
            "1" if invert else "0",
        )
    raise HTTPException(
        status_code=400,
        detail=f"region.kind must be 'box', 'polygon', or 'squares_union'. Got: {kind!r}",
    )


def _canonical_scalar_filters(filters: Optional[List[dict]]) -> str:
    """Stable, order-independent string form of the scalar filters for cache
    keying. Sorted so [{a},{b}] and [{b},{a}] collide on purpose — filter
    order does not change which points survive. Empty/None → "" so a
    scalar-free crop keeps its prior cache identity."""
    if not filters:
        return ""

    def _one(f: dict) -> str:
        vals = f.get("values")
        if vals:
            # Categorical: sorted unique class ids; independent of min/max.
            ids = sorted({int(round(float(v))) for v in vals})
            return "{}:set:{}".format(f["slug"], ",".join(str(i) for i in ids))
        return "{}:{:.9g}:{:.9g}".format(
            f["slug"], float(f["min"]), float(f["max"]),
        )

    parts = sorted(_one(f) for f in filters)
    return "scalar|" + ";".join(parts)


def _resolve_scalar_filter(f: dict) -> tuple:
    """Normalise one scalar-filter spec into `(lo, hi, value_set)`.

    `value_set` is a Python set of int class ids for a categorical filter, or
    None for a continuous [lo, hi] range. Continuous fields keep their float
    bounds; categorical fields ignore them. Shared by both filter functions so
    the membership semantics stay identical across ASCII and LAS sources."""
    vals = f.get("values")
    if vals:
        return float("-inf"), float("inf"), {int(round(float(v))) for v in vals}
    return float(f.get("min", float("-inf"))), float(f.get("max", float("inf"))), None


def _scalar_filter_mask(vals: "np.ndarray", lo: float, hi: float,
                        value_set: Optional[set]) -> "np.ndarray":
    """Boolean keep-mask for one resolved scalar filter over a value array.

    Categorical (value_set given): keep iff round(value) ∈ value_set. Continuous:
    keep iff lo <= value <= hi. Extra dims are float32 on disk, so rounding makes
    integer class labels robust to the float round-trip."""
    if value_set is not None:
        rounded = np.rint(vals).astype(np.int64)
        return np.isin(rounded, list(value_set))
    return (vals >= lo) & (vals <= hi)


def _squares_union_mask(
    pixels: "np.ndarray", centers: "np.ndarray", half_sizes: "np.ndarray",
) -> "np.ndarray":
    """Boolean mask: True for points whose canvas pixel falls inside ANY of the
    screen-space square stamps (the union).

    `pixels` is (n, 2) canvas pixels (from _project_world_to_pixel), `centers`
    is (k, 2) pixel centers, `half_sizes` is (k,) pixel half-extents. The test
    is axis-aligned in screen space: |px - cx| <= h AND |py - cy| <= h. Because
    the membership is purely 2D, a square removes points at every depth behind
    it — a stamp that extrudes through the whole cloud, like the polygon path.
    The erase brush keeps the complement (region invert=True). Shared by both
    filter functions so ASCII and LAS sources erase identically."""
    px = pixels[:, 0]
    py = pixels[:, 1]
    mask = np.zeros(pixels.shape[0], dtype=bool)
    for i in range(centers.shape[0]):
        h = half_sizes[i]
        mask |= (np.abs(px - centers[i, 0]) <= h) & (np.abs(py - centers[i, 1]) <= h)
    return mask


def _region_mask(positions: "np.ndarray", region: Optional[dict]) -> "np.ndarray":
    """Spatial keep-mask for already-materialised Nx3 world positions.

    Supports box / polygon / squares_union regions over a whole positions
    array at once, so the cloud session can mask its in-memory points.
    `region["invert"]` flips the spatial mask. `region` is None → keep all
    (all-True).

    Positions are world-space (translation already applied by the caller). For
    polygon/squares_union the camera matrices and canvas come from `region`,
    matching the renderer's frozen-camera preview. Returns a bool ndarray of
    length N.
    """
    n = positions.shape[0]
    if region is None:
        return np.ones(n, dtype=bool)
    if n == 0:
        return np.zeros(0, dtype=bool)

    kind = region.get("kind")
    if kind == "box":
        cmin = np.asarray(region["min"], dtype=np.float64)
        cmax = np.asarray(region["max"], dtype=np.float64)
        xs, ys, zs = positions[:, 0], positions[:, 1], positions[:, 2]
        mask = (
            (xs >= cmin[0]) & (xs <= cmax[0]) &
            (ys >= cmin[1]) & (ys <= cmax[1]) &
            (zs >= cmin[2]) & (zs <= cmax[2])
        )
    elif kind == "polygon":
        proj = np.asarray(region["projection"], dtype=np.float64)
        view = np.asarray(region["view"], dtype=np.float64)
        canvas = region["canvas"]
        polygon = np.asarray(region["points"], dtype=np.float64)
        if polygon.ndim != 2 or polygon.shape[1] != 2 or polygon.shape[0] < 3:
            raise HTTPException(
                status_code=400,
                detail="region.points must be at least 3 [x, y] entries.",
            )
        pixels = _project_world_to_pixel(
            positions, proj, view, int(canvas["width"]), int(canvas["height"]),
        )
        mask = _points_in_polygon_mask(pixels, polygon)
    elif kind == "squares_union":
        proj = np.asarray(region["projection"], dtype=np.float64)
        view = np.asarray(region["view"], dtype=np.float64)
        canvas = region["canvas"]
        centers = np.asarray(region["centers"], dtype=np.float64)
        half_sizes = np.asarray(region["half_sizes"], dtype=np.float64)
        pixels = _project_world_to_pixel(
            positions, proj, view, int(canvas["width"]), int(canvas["height"]),
        )
        mask = _squares_union_mask(pixels, centers, half_sizes)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown region.kind: {kind!r}")

    if bool(region.get("invert", False)):
        mask = ~mask
    return mask


def _project_world_to_pixel(
    positions: np.ndarray,
    projection: np.ndarray,
    view: np.ndarray,
    canvas_w: int,
    canvas_h: int,
) -> np.ndarray:
    """Project Nx3 world positions to Nx2 canvas pixels via the renderer's
    frozen camera matrices. Matches `projectWorldToCanvasPixel` in
    src/renderer/lib/cropGeometry.ts so the polygon test produces identical
    in/out membership to the renderer's preview.

    THREE.js stores matrices in column-major order, so the renderer's
    `Matrix4.elements` array applied as `m * v` is `elements.T @ v` in NumPy.
    """
    n = positions.shape[0]
    if n == 0:
        return np.zeros((0, 2), dtype=np.float64)

    # column-major flat → 4x4 row-major: transpose
    P = projection.reshape(4, 4, order="F").astype(np.float64)
    V = view.reshape(4, 4, order="F").astype(np.float64)
    M = P @ V  # 4x4

    # Homogeneous Nx4
    ones = np.ones((n, 1), dtype=np.float64)
    homo = np.concatenate([positions.astype(np.float64), ones], axis=1)  # Nx4
    clip = homo @ M.T  # Nx4 = (4x4 @ 4xN).T -> Nx4

    w = clip[:, 3]
    # Avoid division by zero — these points are behind the camera plane;
    # mark them as outside polygon space.
    safe = np.abs(w) > 1e-12
    ndc = np.zeros((n, 2), dtype=np.float64)
    ndc[safe, 0] = clip[safe, 0] / w[safe]
    ndc[safe, 1] = clip[safe, 1] / w[safe]
    # Points with w<=0 are behind the camera; push them well outside canvas.
    ndc[~safe, 0] = -1e9
    ndc[~safe, 1] = -1e9

    px = (ndc[:, 0] + 1.0) * 0.5 * canvas_w
    # Canvas Y flipped vs NDC.
    py = (1.0 - (ndc[:, 1] + 1.0) * 0.5) * canvas_h
    return np.stack([px, py], axis=1)


def _points_in_polygon_mask(pixels: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Vectorised ray-cast point-in-polygon for Nx2 pixels against an Mx2
    polygon. Returns a bool ndarray of length N.

    Matches `pointInPolygon` in src/renderer/lib/cropGeometry.ts (winding
    via crossing count: a point is inside iff the horizontal ray from it
    crosses an odd number of edges)."""
    n = pixels.shape[0]
    m = polygon.shape[0]
    if n == 0 or m < 3:
        return np.zeros(n, dtype=bool)

    inside = np.zeros(n, dtype=bool)
    px = pixels[:, 0]
    py = pixels[:, 1]
    # Edges: (polygon[i], polygon[j]) with j = i-1 wrap-around.
    j = m - 1
    for i in range(m):
        xi, yi = polygon[i, 0], polygon[i, 1]
        xj, yj = polygon[j, 0], polygon[j, 1]
        # Edge straddles the horizontal ray from the point (yi-py and yj-py
        # have opposite signs). Compute intersection x; flip `inside` when
        # the test point is to the left of that intersection.
        cond1 = (yi > py) != (yj > py)
        # Guard against zero-length vertical span (parallel edge): if (yj-yi)
        # is 0, cond1 is False for all points anyway.
        denom = (yj - yi)
        # Where denom is 0, intersect_x is irrelevant (cond1 is False).
        with np.errstate(divide="ignore", invalid="ignore"):
            intersect_x = np.where(denom != 0, (xj - xi) * (py - yi) / denom + xi, 0.0)
        cond2 = px < intersect_x
        inside = np.where(cond1 & cond2, ~inside, inside)
        j = i
    return inside


class CropOctreeRegion(BaseModel):
    """Box, polygon, or sphere-union spatial region for the cloud-session edit
    endpoints (delete_region / filter / split / extract). See _canonical_region
    for validation rules — the handlers delegate to that helper."""
    kind: str
    # Box fields
    min: Optional[List[float]] = None
    max: Optional[List[float]] = None
    # Polygon fields (screen-space, frozen camera matrices)
    points: Optional[List[List[float]]] = None
    projection: Optional[List[float]] = None
    view: Optional[List[float]] = None
    canvas: Optional[dict] = None
    # Squares-union fields (the erase brush). The brush paints a list of
    # screen-space square stamps under one frozen camera; each point is
    # projected to canvas pixels (via the same projection/view/canvas as the
    # polygon path) and is "inside" the region if it falls within ANY square —
    # a depth-independent stamp that extrudes through the whole cloud, exactly
    # like the polygon crop. The erase tool sends invert=True to keep the
    # complement (every point outside all painted squares). `centers` are
    # [px, py] pixel positions and `half_sizes` are the squares' half-extents
    # in pixels (axis-aligned in screen space).
    centers: Optional[List[List[float]]] = None
    half_sizes: Optional[List[float]] = None
    invert: bool = False


class ScalarFilter(BaseModel):
    """Keep only points whose imported scalar attribute `slug` matches.

    Two modes:
      - Continuous (default): keep points in the inclusive range [min, max].
      - Categorical: when `values` is set, keep points whose value rounds to one
        of the listed class ids (an OR within the field — `min`/`max` ignored).
        Used by the filter UI's class-checkbox path for integer-valued labels
        like `ground_class` / `tree_instance`, where a value such as `2` means a
        discrete class, not a position on a continuum, and a multi-select keep
        need not be contiguous.

    `slug` is the on-disk extra-dimension name (matches a key in the octree's
    `attributeRanges` / the `extra_dims` slugs produced by `_xyz_column_plan`).
    """
    slug: str
    # Optional so a categorical (`values`) filter can omit them. Defaulted to the
    # widest range so a malformed continuous filter keeps everything rather than
    # silently dropping points.
    min: float = float("-inf")
    max: float = float("inf")
    # When non-empty, switches this filter to categorical membership: keep iff
    # round(value) ∈ {round(v) for v in values}.
    values: Optional[List[float]] = None


# ===================== MUTABLE CLOUD SESSIONS (Family-1) =====================
#
# A cloud session holds an imported point cloud's positions in RAM as the
# mutable source of truth (the "Family-1" in-core model). Deletions accumulate
# as an exact per-point boolean mask plus the ordered list of delete regions
# that produced it. The Potree octree becomes a *derived* on-disk cache: the
# first one is built at session create, and a fresh one is rebuilt only on an
# explicit "bake" (the one deliberately-slow step). Downstream compute ops read
# `positions[~deleted]` straight from the session array instead of re-reading
# the source file — see `_read_points_from_source`.
#
# Why store regions (not just the mask) for bake: the regions are the auditable
# record of what was removed. The survivor LAS is written straight from the
# in-RAM arrays by `_session_to_las` (colours + scalar extra-dims intact, no
# second full copy held in RAM). The in-RAM `deleted` mask and the region replay
# are kept in lock-step (both go through the shared `_region_mask`) so the array
# the compute ops see and the baked octree always agree.

_cloud_sessions: Dict[str, "CloudSession"] = {}
_cloud_session_lock = threading.Lock()


@dataclass
class CloudSession:
    """An imported point cloud held in RAM as the COMPLETE source of truth.

    The full attribute set — positions, colours, intensity, and every scalar
    extra-dimension — lives in these arrays. The source FILE is read exactly
    once (at create); after that every operation (delete/crop/erase, filter,
    ground/tree segment, bake, downstream compute) reads or mutates these arrays
    and never touches the file again. The Potree octree is a derived cache
    rebuilt from the arrays on bake.
    """
    session_id: str
    source_path: str                 # provenance only — never re-read after create
    ascii_format: Optional[str]
    column_plan: Optional[Any]       # ColumnPlan | None (wizard layout, honored once)
    positions: np.ndarray            # (N,3) float64 — full resolution
    colors: Optional[np.ndarray]     # (N,3) uint16 (0-65535 LAS scale) | None
    intensity: Optional[np.ndarray]  # (N,) uint16 | None
    extras: Dict[str, np.ndarray]    # slug -> (N,) float32 scalar extra-dim columns
    extra_dims_meta: List[dict]      # ordered [{slug, label}] for the octree sidecar
    deleted: np.ndarray              # (N,) bool — True == deleted (hidden)
    deleted_history: List[np.ndarray]  # mask snapshots, one per committed delete (undo)
    octree_cache_id: Optional[str]   # currently-built derived octree, or None if stale
    created_at: float


def _get_cloud_session(session_id: str) -> "CloudSession":
    with _cloud_session_lock:
        sess = _cloud_sessions.get(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail=f"Cloud session not found: {session_id}")
    return sess


def _read_las_into_arrays(
    las_path: _Path,
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray], Dict[str, np.ndarray], List[dict]]:
    """Read a LAS file fully into RAM as the session's source-of-truth arrays.

    Returns (positions[N,3] float64, colors[N,3] uint16 | None,
    intensity[N] uint16 | None, extras{slug: (N,) float32}, extra_dims_meta).
    RGB/intensity are kept in LAS uint16 scale so the bake writer can round-trip
    them byte-for-byte; extras are the float32 extra-dimension columns. This is
    the ONE point where a normalised LAS is materialised into the session — used
    by create after `_source_to_las` converts whatever the source format was.
    """
    import laspy
    with laspy.open(str(las_path)) as reader:
        las = reader.read()
    positions = np.stack([np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)], axis=1).astype(np.float64)
    dim_names = set(las.point_format.dimension_names)
    colors = None
    if {"red", "green", "blue"} <= dim_names:
        colors = np.stack([
            np.asarray(las.red, dtype=np.uint16),
            np.asarray(las.green, dtype=np.uint16),
            np.asarray(las.blue, dtype=np.uint16),
        ], axis=1)
    intensity = None
    if "intensity" in dim_names and np.any(np.asarray(las.intensity)):
        intensity = np.asarray(las.intensity, dtype=np.uint16)
    extras: Dict[str, np.ndarray] = {}
    extra_dims_meta: List[dict] = []
    for d in las.point_format.extra_dimensions:
        name = d.name
        extras[name] = np.asarray(las[name], dtype=np.float32)
        extra_dims_meta.append({"slug": name, "label": name})

    # Auto-map LAS native per-pulse multi-return dimensions to the canonical
    # slugs Helios's LAD path reads (see `_MULTI_RETURN_SLUGS`). return_number
    # is carried verbatim as target_index — Helios auto-detects 0- vs 1-based
    # indexing, so no base conversion. Only mapped when the source dim is
    # present and a same-named extra-dim wasn't already captured above.
    #
    # CRUCIALLY, only map a dim that actually carries data. return_number,
    # number_of_returns and gps_time are STANDARD LAS dimensions present in every
    # point-format-3 record, so they exist (all-zero) even on a plain XYZ/E57
    # import that never had per-pulse data. Mapping those zeros would make the LAD
    # path see phantom multi-return columns — flipping it to the full-waveform
    # algorithm and running gapfillMisses() on garbage timestamps. Require a
    # non-degenerate column (some non-zero value, and for indices not all-equal)
    # so only genuinely populated airborne-style LAS triggers multi-return.
    _las_multireturn = (
        ("return_number", "target_index"),
        ("number_of_returns", "target_count"),
        ("gps_time", "timestamp"),
    )
    for src_dim, slug in _las_multireturn:
        if src_dim in dim_names and slug not in extras:
            vals = np.asarray(las[src_dim])
            if vals.size and np.any(vals != vals.flat[0]):  # not constant/all-zero
                extras[slug] = vals.astype(np.float32)
                extra_dims_meta.append({"slug": slug, "label": _MULTI_RETURN_LABELS[slug]})
    return positions, colors, intensity, extras, extra_dims_meta


def _session_to_las(sess: "CloudSession", out_las: _Path,
                    exclude_misses: bool = False) -> int:
    """Write the session's SURVIVING points (positions[~deleted] + all
    attributes) to a LAS, entirely from the in-RAM arrays — no source file read.
    Mirrors `_xyz_to_las`'s header/record layout so PotreeConverter ingests it
    identically. Returns the survivor count.

    `exclude_misses=True` additionally drops sky/miss points (is_miss != 0).
    Misses are real points placed ~20 km away, so leaving them in poisons the
    octree's bounding box (and thus camera framing). The octree is built
    hits-only; misses live in the session for LAD + the on-demand overlay. A bake
    (which round-trips the LAS back into the session) must NOT exclude them, or
    the misses would be lost — only the octree build passes True.
    """
    import laspy
    keep = ~sess.deleted
    if exclude_misses and _MISS_SLUG in sess.extras:
        keep = keep & (sess.extras[_MISS_SLUG] == 0)
    n = int(keep.sum())

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in sess.extra_dims_meta:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))

    pos = sess.positions[keep]
    record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
    record.x = pos[:, 0]
    record.y = pos[:, 1]
    record.z = pos[:, 2]
    if sess.colors is not None:
        c = sess.colors[keep]
        record.red, record.green, record.blue = c[:, 0], c[:, 1], c[:, 2]
    if sess.intensity is not None:
        record.intensity = sess.intensity[keep]
    for ed in sess.extra_dims_meta:
        record[ed["slug"]] = sess.extras[ed["slug"]][keep]

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        writer.write_points(record)
        if n > 0:
            pad = 0.001  # matches header.scales — keeps boundary points in-bbox
            writer.header.mins = (pos.min(axis=0) - pad).tolist()
            writer.header.maxs = (pos.max(axis=0) + pad).tolist()
    return n


def _build_octree_from_las(las_path: _Path, extra_dims_meta: List[dict]) -> tuple[str, _Path, dict]:
    """Run PotreeConverter on a LAS and atomically install it into the octree
    cache keyed by the LAS bytes' hash. Returns (cache_key, cache_dir, meta).
    Shared by create (initial) and bake (post-edit) — both now feed a LAS that
    was produced WITHOUT re-reading the source file at edit time."""
    h = _hashlib.sha1()
    with open(las_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    cache_key = h.hexdigest()
    cache_dir = _octree_cache_root() / cache_key

    if not (cache_dir / "metadata.json").is_file():
        cache_dir.parent.mkdir(parents=True, exist_ok=True)
        staging_dir = cache_dir.parent / (cache_key + ".staging")
        if staging_dir.exists():
            _shutil.rmtree(staging_dir)
        staging_dir.mkdir(parents=True)
        try:
            _run_potree_converter(las_path, staging_dir)
            _write_octree_labels(staging_dir, extra_dims_meta)
            if cache_dir.exists():
                _shutil.rmtree(cache_dir)
            staging_dir.rename(cache_dir)
        except Exception:
            try:
                _shutil.rmtree(staging_dir)
            except (FileNotFoundError, OSError):
                pass
            raise

    meta = _read_octree_metadata(cache_dir)
    return cache_key, cache_dir, meta


class CloudSessionCreateRequest(BaseModel):
    """Create a mutable cloud session from a source file and build its first
    (derived) octree. `column_plan` is the import wizard's explicit layout and
    is honored ONCE here, then carried for the life of the session so edits
    never re-auto-detect columns (the import-wizard option-loss fix)."""
    source_path: str
    ascii_format: Optional[str] = None
    column_plan: Optional[ColumnPlan] = None


class DeleteRegionRequest(BaseModel):
    """Mark points inside `region` as deleted on a cloud session. Instant: sets
    the in-RAM mask; does NOT rebuild the octree. The renderer mirrors the
    deletion on the GPU via its clip-volume stack, so the viewport updates
    immediately."""
    region: CropOctreeRegion


@app.post("/api/cloud/session/create")
async def create_cloud_session(request: CloudSessionCreateRequest):
    """Load a source cloud FULLY into an in-RAM session (the complete source of
    truth — positions + colours + intensity + every scalar extra-dim), build its
    first octree, and return `{session_id, ...octree metadata}`. This is the ONLY
    point the source FILE is read; every later edit/bake/op works on the arrays.

    The source is normalised to a LAS once via `_source_to_las` (handling
    XYZ/PLY/PCD/LAS/LAZ + the wizard column_plan uniformly), that LAS is read
    into the session arrays AND fed to PotreeConverter for the first octree."""
    source_path = _Path(request.source_path).expanduser()
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail=f"Source file not found: {request.source_path}")

    import time
    session_id = uuid.uuid4().hex[:8]

    # Normalise to a LAS in a temp dir, read it fully into RAM, then build the
    # octree from that same LAS. After this the file is never touched again.
    import tempfile
    with tempfile.TemporaryDirectory() as _tmp:
        tmp_dir = _Path(_tmp)
        las_path, las_is_temp, source_extra_dims = _source_to_las(
            source_path, request.ascii_format, tmp_dir, request.column_plan,
        )
        positions, colors, intensity, extras, extra_dims_meta = _read_las_into_arrays(las_path)
        # `_read_las_into_arrays` sets label==slug from the LAS header, which
        # loses the wizard's custom labels. `_source_to_las` returns the proper
        # [{slug, label}] (honoring the column_plan), so overlay those labels.
        _label_by_slug = {ed["slug"]: ed.get("label", ed["slug"]) for ed in (source_extra_dims or [])}
        for ed in extra_dims_meta:
            ed["label"] = _label_by_slug.get(ed["slug"], ed["label"])
        # E57 stashes the scanner origin + miss summary keyed by the temp LAS
        # path; pop it so we can surface them in the response (renderer uses the
        # origin for the scan params and miss-point display relocation).
        scan_meta = _e57_scan_meta.pop(str(las_path.resolve()), None)
        if las_is_temp:
            try:
                las_path.unlink()
            except FileNotFoundError:
                pass

        n = int(len(positions))
        sess = CloudSession(
            session_id=session_id,
            source_path=str(source_path),
            ascii_format=request.ascii_format,
            column_plan=request.column_plan,
            positions=positions,
            colors=colors,
            intensity=intensity,
            extras=extras,
            extra_dims_meta=extra_dims_meta,
            deleted=np.zeros(n, dtype=bool),
            deleted_history=[],
            octree_cache_id=None,
            created_at=time.time(),
        )
        # Build the octree from a HITS-ONLY LAS so far-field misses (~20 km) don't
        # poison its bounding box / camera framing. Misses stay in the session
        # (is_miss + true coords) for LAD and the on-demand miss overlay.
        hits_las = tmp_dir / "octree_hits.las"
        _session_to_las(sess, hits_las, exclude_misses=True)
        cache_key, cache_dir, meta = _build_octree_from_las(hits_las, extra_dims_meta)
        sess.octree_cache_id = cache_key

    with _cloud_session_lock:
        _cloud_sessions[session_id] = sess
    meta = {"cache_id": cache_key, "cache_dir": str(cache_dir), **meta}

    # Surface sky/miss info so the renderer can hide misses by default, colour
    # them distinctly, and relocate them onto the bounding sphere for display.
    # `has_misses` is derived from the actual data (any source that carried an
    # is_miss extra dim), not just E57. The scanner origin (when known, e.g. from
    # E57 pose) lets the renderer place the scan params + the display relocation.
    miss_arr = extras.get(_MISS_SLUG)
    has_misses = bool(miss_arr is not None and np.any(miss_arr != 0))
    miss_info: dict = {"has_misses": has_misses, "miss_slug": _MISS_SLUG}
    if has_misses:
        miss_info["miss_count"] = int(np.count_nonzero(miss_arr != 0))
    if scan_meta and scan_meta.get("origin") is not None:
        miss_info["scan_origin"] = scan_meta["origin"]
    # Full scan-pattern params (origin + angular sweep + grid resolution) when
    # the source carried them (E57, and PCD VIEWPOINT for origin). The renderer
    # uses these to auto-create a Scan with populated ScanParameters, mirroring
    # the Helios-XML import path. Only the recoverable fields are present.
    if scan_meta and scan_meta.get("scan_params"):
        miss_info["scan_params"] = scan_meta["scan_params"]
    # Unplaceable misses: flagged miss cells whose beam direction couldn't be
    # recovered at import (zeroed cartesian, no spherical) and so sit at the
    # scanner origin until Helios recovers them from the row/column grid. Surface
    # the count + a warning so this is never silent — a scan that imported "with
    # misses" but whose misses are all unplaceable would otherwise look fine while
    # the LAD geometry is incomplete until the C++ grid recovery runs.
    if scan_meta and scan_meta.get("unplaceable_miss_count"):
        upc = int(scan_meta["unplaceable_miss_count"])
        miss_info["unplaceable_miss_count"] = upc
        miss_info["warnings"] = [
            f"{upc} sky/miss point(s) were flagged but could not be placed at "
            "import (the scanner zeroed invalid-cell coordinates and the file "
            "carries no scan angles). They are kept and tagged; their beam "
            "directions are recovered from the scan grid during LAD."
        ]

    return {"session_id": session_id, "point_count": n, **miss_info, **meta}


@app.get("/api/cloud/session/{session_id}/misses")
async def get_cloud_misses(session_id: str, origin_x: Optional[float] = None,
                           origin_y: Optional[float] = None,
                           origin_z: Optional[float] = None):
    """Return the session's sky/miss points for display.

    Misses are stored at their true coordinates (typically far-field, ~20 km,
    along the real beam direction). Two display modes, chosen by whether the
    caller supplies a scanner origin:

    - **No origin** (scan has no params yet): return the misses at their TRUE
      stored coordinates, untouched. The data is the source of truth; we don't
      invent positions. Far-field misses will sit far from the tree, but that
      is honest and never shifts.

    - **Origin supplied** (scan params define a scanner): project each miss onto
      a sphere centred on the origin, with radius = the farthest hit's distance
      from that origin plus a small margin, so misses always lie just BEYOND any
      hit point. This keeps them visible against the cloud without depending on
      anything but the stored beam direction and the origin.

    Returns {count, total, origin, radius, positions} where positions is a flat
    [x,y,z, x,y,z, ...] list (empty when none). `count` is how many are drawn;
    `total` includes any miss that couldn't be placed (sitting AT the origin
    with no beam direction yet — awaiting Helios grid recovery).
    """
    sess = _get_cloud_session(session_id)
    with _cloud_session_lock:
        miss_arr = sess.extras.get(_MISS_SLUG)
        if miss_arr is None:
            return {"count": 0, "total": 0, "origin": [0.0, 0.0, 0.0], "radius": 0.0, "positions": []}
        keep = ~sess.deleted
        is_miss = (miss_arr != 0) & keep
        hits = (~(miss_arr != 0)) & keep
        miss_pos = np.ascontiguousarray(sess.positions[is_miss], dtype=np.float64)
        hit_pos = np.ascontiguousarray(sess.positions[hits], dtype=np.float64)

    if miss_pos.shape[0] == 0:
        return {"count": 0, "total": 0, "origin": [0.0, 0.0, 0.0], "radius": 0.0, "positions": []}

    has_origin = None not in (origin_x, origin_y, origin_z)

    # No scanner origin defined: draw misses at their TRUE stored coordinates.
    # Don't relocate — the array is the source of truth for display too.
    if not has_origin:
        return {
            "count": int(miss_pos.shape[0]),
            "total": int(miss_pos.shape[0]),
            "origin": [0.0, 0.0, 0.0],
            "radius": 0.0,
            "positions": miss_pos.astype(np.float32).ravel().tolist(),
        }

    # Origin defined: project each miss onto a sphere centred on the origin, at a
    # radius just beyond the farthest hit so misses always sit outside the cloud.
    origin = np.array([origin_x, origin_y, origin_z], dtype=np.float64)
    # Radius = farthest hit distance FROM THE ORIGIN (not the hit centre — the
    # projection is origin-centred, so the enclosing radius must be too), plus a
    # 5% margin to guarantee misses clear every hit point.
    _MISS_SPHERE_MARGIN = 1.05
    if hit_pos.shape[0] > 0:
        radius = float(np.max(np.linalg.norm(hit_pos - origin, axis=1))) * _MISS_SPHERE_MARGIN
    else:
        radius = 1.0
    if radius <= 0:
        radius = 1.0

    d = miss_pos - origin
    n = np.linalg.norm(d, axis=1)
    # Skip unplaceable misses (sitting AT the scanner origin, no direction yet —
    # those get their direction from the grid in Helios C++). Drawing them would
    # pile a degenerate dot on the scanner. Only relocate misses with a real
    # beam direction.
    drawable = n > 1e-9
    d = d[drawable]
    n = n[drawable]
    relocated = origin + (d / n[:, None]) * radius
    return {
        # `count` is how many misses are DRAWN (placeable). `total` includes the
        # unplaceable ones (sitting at origin, awaiting C++ grid recovery) that
        # are flagged in the data but not shown in the overlay.
        "count": int(relocated.shape[0]),
        "total": int(miss_pos.shape[0]),
        "origin": origin.tolist(),
        "radius": radius,
        "positions": relocated.astype(np.float32).ravel().tolist(),
    }


@app.post("/api/cloud/session/{session_id}/delete_region")
async def delete_cloud_region(session_id: str, request: DeleteRegionRequest):
    """Set the per-point deleted mask for points inside `region`. No rebuild."""
    sess = _get_cloud_session(session_id)
    region_dict = request.region.model_dump()
    _canonical_region(region_dict)  # validate shape (raises 400)

    # `_region_mask` returns the spatial keep-mask (region invert already
    # applied). The points to DELETE are exactly those the region selects —
    # i.e. the True entries of the (un-inverted) selection. We OR them into the
    # session's deleted mask so deletions accumulate.
    with _cloud_session_lock:
        select = _region_mask(sess.positions, region_dict)
        sess.deleted |= select
        # Record the post-delete mask snapshot so undo can pop back to it. We
        # store the boolean mask per applied delete (cheap: 1 bit/point) rather
        # than replaying regions, so undo is exact regardless of edit kind.
        sess.deleted_history.append(sess.deleted.copy())
        sess.octree_cache_id = None  # derived octree is now stale until bake
        deleted_count = int(sess.deleted.sum())
        total = int(len(sess.positions))

    return {
        "session_id": session_id,
        "deleted_count": deleted_count,
        "remaining_count": total - deleted_count,
        "total_count": total,
    }


class ResetCloudEditsRequest(BaseModel):
    """Undo. `edit_count` = how many committed deletes to KEEP; the mask is
    restored to that snapshot in the history and later ones are discarded.
    Omit to clear all deletions (edit_count = 0)."""
    edit_count: Optional[int] = None


@app.post("/api/cloud/session/{session_id}/reset_edits")
async def reset_cloud_edits(session_id: str, request: ResetCloudEditsRequest):
    """Restore the deleted mask to an earlier snapshot (undo)."""
    sess = _get_cloud_session(session_id)
    with _cloud_session_lock:
        k = 0 if request.edit_count is None else max(0, int(request.edit_count))
        k = min(k, len(sess.deleted_history))
        sess.deleted_history = sess.deleted_history[:k]
        sess.deleted = (
            sess.deleted_history[-1].copy() if k > 0
            else np.zeros(len(sess.positions), dtype=bool)
        )
        sess.octree_cache_id = None
        deleted_count = int(sess.deleted.sum())
        total = int(len(sess.positions))
    return {
        "session_id": session_id,
        "deleted_count": deleted_count,
        "remaining_count": total - deleted_count,
        "total_count": total,
    }


@app.post("/api/cloud/session/{session_id}/bake")
async def bake_cloud_session(session_id: str):
    """Permanently apply deletions by rebuilding the octree FROM THE IN-RAM
    ARRAYS — the survivors (positions[~deleted] + colours + intensity + every
    scalar extra-dim) are written to a LAS via `_session_to_las` and fed to
    PotreeConverter. The source file is NOT read. Then the in-RAM arrays are
    compacted to the survivors and the mask cleared. Returns the new octree
    metadata. The deliberately-slow step (the PotreeConverter run).

    No deletions → returns the current octree without rebuilding.
    """
    sess = _get_cloud_session(session_id)
    with _cloud_session_lock:
        has_deletions = bool(sess.deleted.any())
        survivors = int((~sess.deleted).sum())

    # Everything deleted → nothing to bake. Don't feed a 0-point LAS to
    # PotreeConverter (it exits non-zero). Report empty; the renderer raises a
    # delete-confirmation. The mask is left intact (the cloud is still "all
    # deleted" until the user removes it).
    if survivors == 0:
        return {"session_id": session_id, "point_count": 0, "baked": False}

    if not has_deletions:
        cache_dir = _octree_cache_root() / (sess.octree_cache_id or "")
        if sess.octree_cache_id and (cache_dir / "metadata.json").is_file():
            meta = _read_octree_metadata(cache_dir)
            return {
                "session_id": session_id, "point_count": int(len(sess.positions)),
                "baked": False, "cache_id": sess.octree_cache_id,
                "cache_dir": str(cache_dir), **meta,
            }

    import tempfile
    with tempfile.TemporaryDirectory() as _tmp:
        las_path = _Path(_tmp) / "baked.las"
        with _cloud_session_lock:
            # Octree is hits-only (misses stay in the session for LAD/overlay).
            _session_to_las(sess, las_path, exclude_misses=True)
            extra_dims_meta = list(sess.extra_dims_meta)
        cache_key, cache_dir, meta = _build_octree_from_las(las_path, extra_dims_meta)

    # Compact the in-RAM arrays to the survivors and clear the mask + history, so
    # the session's source of truth matches the baked octree and further edits
    # start from the reduced set.
    with _cloud_session_lock:
        keep = ~sess.deleted
        sess.positions = sess.positions[keep]
        if sess.colors is not None:
            sess.colors = sess.colors[keep]
        if sess.intensity is not None:
            sess.intensity = sess.intensity[keep]
        for slug in list(sess.extras.keys()):
            sess.extras[slug] = sess.extras[slug][keep]
        sess.deleted = np.zeros(len(sess.positions), dtype=bool)
        sess.deleted_history = []
        sess.octree_cache_id = cache_key
        remaining = int(len(sess.positions))

    try:
        max_bytes = int(_os.environ.get(
            "PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES", _DEFAULT_OCTREE_CACHE_MAX_BYTES,
        ))
    except ValueError:
        max_bytes = _DEFAULT_OCTREE_CACHE_MAX_BYTES
    _evict_octree_cache(max_bytes, keep=cache_dir)

    return {
        "session_id": session_id,
        "point_count": remaining,
        "baked": True,
        "cache_id": cache_key,
        "cache_dir": str(cache_dir),
        **meta,
    }


def _session_add_extra_column(sess: "CloudSession", slug: str, label: str, values: np.ndarray) -> None:
    """Append (or replace) a per-point scalar extra-dim column on the session
    array. `values` is aligned to the SURVIVING points (positions[~deleted]);
    it's scattered back to a full-length (N,) column with 0 for deleted rows so
    every session array stays the same length. Caller holds the lock."""
    full = np.zeros(len(sess.positions), dtype=np.float32)
    full[~sess.deleted] = values.astype(np.float32)
    sess.extras[slug] = full
    if slug not in {ed["slug"] for ed in sess.extra_dims_meta}:
        sess.extra_dims_meta.append({"slug": slug, "label": label})


def _session_rebuild(sess: "CloudSession") -> tuple[str, _Path, dict]:
    """Rebuild the session's derived octree FROM THE IN-RAM ARRAYS (survivors +
    all attributes), update octree_cache_id, and return (cache_key, dir, meta).
    No source file read. Caller must NOT hold the lock (PotreeConverter is slow);
    this snapshots under the lock then converts outside it."""
    import tempfile
    with tempfile.TemporaryDirectory() as _tmp:
        las_path = _Path(_tmp) / "rebuilt.las"
        with _cloud_session_lock:
            # Octree is hits-only (misses stay in the session for LAD/overlay).
            _session_to_las(sess, las_path, exclude_misses=True)
            extra_dims_meta = list(sess.extra_dims_meta)
        cache_key, cache_dir, meta = _build_octree_from_las(las_path, extra_dims_meta)
    with _cloud_session_lock:
        sess.octree_cache_id = cache_key
    return cache_key, cache_dir, meta


def _session_subset_locked(sess: "CloudSession", keep: np.ndarray) -> "CloudSession":
    """Build a NEW session from the `keep` subset of `sess`'s SURVIVING points
    (positions[~deleted][keep] + aligned attributes) and register it. The CALLER
    MUST HOLD `_cloud_session_lock` — this reads `sess`'s arrays and inserts the
    new session into the registry without taking the lock itself, so it can be
    composed inside a larger locked critical section (e.g. split's commit). The
    octree is NOT built here (caller rebuilds, outside the lock)."""
    import time
    surv = ~sess.deleted
    new_id = uuid.uuid4().hex[:8]
    new_sess = CloudSession(
        session_id=new_id,
        source_path=sess.source_path,  # provenance label only
        ascii_format=sess.ascii_format,
        column_plan=sess.column_plan,
        positions=sess.positions[surv][keep].copy(),
        colors=sess.colors[surv][keep].copy() if sess.colors is not None else None,
        intensity=sess.intensity[surv][keep].copy() if sess.intensity is not None else None,
        extras={k: v[surv][keep].copy() for k, v in sess.extras.items()},
        extra_dims_meta=list(sess.extra_dims_meta),
        deleted=np.zeros(int(keep.sum()), dtype=bool),
        deleted_history=[],
        octree_cache_id=None,
        created_at=time.time(),
    )
    _cloud_sessions[new_id] = new_sess
    return new_sess


def _session_subset(sess: "CloudSession", keep: np.ndarray) -> "CloudSession":
    """Lock-acquiring wrapper around `_session_subset_locked` for callers that do
    NOT already hold the lock (e.g. `extract`)."""
    with _cloud_session_lock:
        return _session_subset_locked(sess, keep)


class SessionSplitRequest(BaseModel):
    """Split a session into the points a filter KEEPS (stay on this session) and
    the points it EXCLUDES (a NEW leftover session). Operates entirely on the
    in-RAM arrays — no source file read. Same predicate shape as the filter."""
    region: Optional[CropOctreeRegion] = None
    scalar_filters: Optional[List[ScalarFilter]] = None


@app.post("/api/cloud/session/{session_id}/split")
async def session_split(session_id: str, request: SessionSplitRequest):
    """Keep the filter-passing points on this session; move the excluded points
    to a NEW leftover session. Rebuilds both octrees from arrays. Returns
    {kept: {...octree}, leftover: {session_id, ...octree}} (leftover null if
    empty). No file read."""
    sess = _get_cloud_session(session_id)
    region_dict = request.region.model_dump() if request.region else None
    if region_dict is not None:
        _canonical_region(region_dict)
    if region_dict is None and not request.scalar_filters:
        raise HTTPException(status_code=400, detail="split requires `region` or `scalar_filters`.")

    # Compute the keep-mask AND commit the leftover deletion under ONE lock, so
    # the survivor snapshot used for the index scatter can't go stale against a
    # concurrent edit on the same session (the leftover subset is built from the
    # same snapshot before the lock is released for the slow rebuilds).
    with _cloud_session_lock:
        surv = ~sess.deleted
        pos = sess.positions[surv]
        keep = _region_mask(pos, region_dict) if region_dict is not None else np.ones(len(pos), dtype=bool)
        for f in (request.scalar_filters or []):
            if f.slug not in sess.extras:
                raise HTTPException(status_code=400, detail=f"Unknown scalar attribute: {f.slug!r}.")
            lo, hi, value_set = _resolve_scalar_filter(f.model_dump())
            keep &= _scalar_filter_mask(sess.extras[f.slug][surv], lo, hi, value_set)

        kept_count = int(keep.sum())
        # Kept side empty → the filter would leave nothing on the parent. Don't
        # commit or rebuild (0-point PotreeConverter would 500); report empty so
        # the renderer raises a delete-confirmation. The session is untouched.
        if kept_count == 0:
            return {
                "session_id": session_id,
                "kept": {"point_count": 0, "cache_id": None, "cache_dir": None},
                "leftover": None,
            }

        leftover_mask = ~keep
        leftover = _session_subset_locked(sess, leftover_mask) if bool(leftover_mask.any()) else None
        # Commit the leftover deletion on the parent using the SAME snapshot.
        # Split is a non-undoable commit (renderer clears its erase undo stack),
        # so reset the undo history to keep both sides in lock-step.
        idx_surv = np.where(surv)[0]
        sess.deleted[idx_surv[leftover_mask]] = True
        sess.deleted_history = []
        sess.octree_cache_id = None

    leftover_meta = None
    if leftover is not None:
        lk, lcd, lmeta = _session_rebuild(leftover)
        leftover_meta = {"session_id": leftover.session_id, "point_count": int(len(leftover.positions)),
                         "cache_id": lk, "cache_dir": str(lcd), **lmeta}
    kk, kcd, kmeta = _session_rebuild(sess)

    return {
        "session_id": session_id,
        "kept": {"point_count": kept_count, "cache_id": kk, "cache_dir": str(kcd), **kmeta},
        "leftover": leftover_meta,
    }


class SessionExtractRequest(BaseModel):
    """Extract the points a spatial+scalar filter SELECTS into a NEW child
    session, leaving the parent UNCHANGED. Operates on the in-RAM arrays — no
    source file read. Used by 'split into clouds' workflows that keep the
    classified parent and spin off per-class child clouds."""
    region: Optional[CropOctreeRegion] = None
    scalar_filters: Optional[List[ScalarFilter]] = None


@app.post("/api/cloud/session/{session_id}/extract")
async def session_extract(session_id: str, request: SessionExtractRequest):
    """Create a NEW child session from the filter-selected points (parent
    untouched). Returns {session_id, ...octree} or null if the selection is
    empty. No source file read."""
    sess = _get_cloud_session(session_id)
    region_dict = request.region.model_dump() if request.region else None
    if region_dict is not None:
        _canonical_region(region_dict)
    if region_dict is None and not request.scalar_filters:
        raise HTTPException(status_code=400, detail="extract requires `region` or `scalar_filters`.")

    with _cloud_session_lock:
        surv = ~sess.deleted
        pos = sess.positions[surv]
        sel = _region_mask(pos, region_dict) if region_dict is not None else np.ones(len(pos), dtype=bool)
        for f in (request.scalar_filters or []):
            if f.slug not in sess.extras:
                raise HTTPException(status_code=400, detail=f"Unknown scalar attribute: {f.slug!r}.")
            lo, hi, value_set = _resolve_scalar_filter(f.model_dump())
            sel &= _scalar_filter_mask(sess.extras[f.slug][surv], lo, hi, value_set)

    if not bool(sel.any()):
        return {"session_id": session_id, "extracted": None}
    child = _session_subset(sess, sel)
    ck, ccd, cmeta = _session_rebuild(child)
    return {
        "session_id": session_id,
        "extracted": {"session_id": child.session_id, "point_count": int(len(child.positions)),
                      "cache_id": ck, "cache_dir": str(ccd), **cmeta},
    }


class SessionGroundSegmentRequest(BaseModel):
    """Run CSF ground segmentation on the session's in-RAM points and append a
    `ground_class` scalar column (1=ground, 2=plant). No source file read."""
    cloth_resolution: float = 0.05
    rigidness: int = 3
    class_threshold: float = 0.02
    iterations: int = 500
    slope_smooth: bool = False


@app.post("/api/cloud/session/{session_id}/segment_ground")
async def session_segment_ground(session_id: str, request: SessionGroundSegmentRequest):
    """CSF on the in-RAM survivors → append `ground_class` → rebuild octree from
    the arrays. No source file read."""
    sess = _get_cloud_session(session_id)
    with _cloud_session_lock:
        pts = sess.positions[~sess.deleted].copy()
    if len(pts) < 10:
        raise HTTPException(status_code=400, detail="Need at least 10 points for ground segmentation.")
    try:
        labels = segment_ground(
            pts,
            cloth_resolution=request.cloth_resolution,
            rigidness=request.rigidness,
            class_threshold=request.class_threshold,
            iterations=request.iterations,
            slope_smooth=request.slope_smooth,
        )
    except ImportError:
        raise HTTPException(status_code=500, detail="CSF (cloth-simulation-filter) not installed.")
    with _cloud_session_lock:
        _session_add_extra_column(sess, GROUND_CLASS_SLUG, GROUND_CLASS_LABEL, labels)
    cache_key, cache_dir, meta = _session_rebuild(sess)
    return {"session_id": session_id, "point_count": int(len(pts)), "cache_id": cache_key, "cache_dir": str(cache_dir), **meta}


class SessionTreeSegmentRequest(TreeSegmentationRequest):
    """Run TreeIso on the session's in-RAM points and append a `tree_instance`
    column. Inherits the TreeIso tuning fields; `points`/`source` are ignored."""
    pass


@app.post("/api/cloud/session/{session_id}/segment_trees")
async def session_segment_trees(session_id: str, request: SessionTreeSegmentRequest):
    """TreeIso on the in-RAM survivors → append `tree_instance` → rebuild octree
    from the arrays. No source file read."""
    sess = _get_cloud_session(session_id)
    with _cloud_session_lock:
        pts = sess.positions[~sess.deleted].copy()
    if len(pts) > _TREEISO_MAX_POINTS:
        raise HTTPException(
            status_code=400,
            detail=f"Tree segmentation is capped at {_TREEISO_MAX_POINTS:,} points; this cloud has {len(pts):,}. Crop or downsample first.",
        )
    seeds = (
        np.asarray(request.seed_points, dtype=np.float64)
        if request.seed_points else None
    )
    labels = segment_trees(pts, _treeiso_params(request), seeds=seeds)
    with _cloud_session_lock:
        _session_add_extra_column(sess, TREE_INSTANCE_SLUG, TREE_INSTANCE_LABEL, np.asarray(labels))
    cache_key, cache_dir, meta = _session_rebuild(sess)
    return {"session_id": session_id, "point_count": int(len(pts)), "cache_id": cache_key, "cache_dir": str(cache_dir), **meta}


class SessionFilterRequest(BaseModel):
    """Apply a spatial + scalar filter to the session by DELETING the points the
    filter excludes (sets the deleted mask). Operates entirely on the in-RAM
    arrays — no source file read. `region` keeps points inside it (invert to
    flip); `scalar_filters` keep points whose attribute is in range/class. A
    point survives iff it passes the region AND every scalar filter."""
    region: Optional[CropOctreeRegion] = None
    scalar_filters: Optional[List[ScalarFilter]] = None
    # Rebuild the octree now (the filter is "applied permanently"). When False,
    # only the mask is set (instant; bake later).
    rebuild: bool = True


@app.post("/api/cloud/session/{session_id}/filter")
async def session_filter(session_id: str, request: SessionFilterRequest):
    """Delete the points a spatial+scalar filter excludes, on the in-RAM arrays."""
    sess = _get_cloud_session(session_id)
    region_dict = request.region.model_dump() if request.region else None
    if region_dict is not None:
        _canonical_region(region_dict)
    if region_dict is None and not request.scalar_filters:
        raise HTTPException(status_code=400, detail="filter requires `region` or `scalar_filters`.")

    with _cloud_session_lock:
        # keep-mask over the SURVIVING points: region (defaults all-True) AND
        # every scalar filter. Computed on survivors so a second filter composes
        # on the current point set, not the original.
        surv = ~sess.deleted
        pos = sess.positions[surv]
        keep = _region_mask(pos, region_dict) if region_dict is not None else np.ones(len(pos), dtype=bool)
        for f in (request.scalar_filters or []):
            slug = f.slug
            if slug not in sess.extras:
                raise HTTPException(status_code=400, detail=f"Unknown scalar attribute: {slug!r}. Available: {sorted(sess.extras)}")
            lo, hi, value_set = _resolve_scalar_filter(f.model_dump())
            keep &= _scalar_filter_mask(sess.extras[slug][surv], lo, hi, value_set)

        kept_count = int(keep.sum())
        total = int(len(sess.positions))
        # Empty result: do NOT commit the deletion or rebuild (PotreeConverter
        # can't ingest 0 points). The renderer raises a delete-confirmation.
        if kept_count == 0:
            return {"session_id": session_id, "point_count": 0, "rebuilt": False,
                    "remaining_count": int(surv.sum()), "total_count": total}

        # Commit: delete the filter-excluded survivors. Filter is presented as a
        # non-undoable commit (the renderer clears its erase undo stack), so we
        # reset the undo history to keep both sides in lock-step — a later
        # erase-undo must not reach back across this filter.
        idx_surv = np.where(surv)[0]
        sess.deleted[idx_surv[~keep]] = True
        sess.deleted_history = []
        sess.octree_cache_id = None
        remaining = int((~sess.deleted).sum())

    if not request.rebuild:
        return {"session_id": session_id, "remaining_count": remaining, "deleted_count": total - remaining, "total_count": total, "rebuilt": False}
    cache_key, cache_dir, meta = _session_rebuild(sess)
    return {"session_id": session_id, "point_count": remaining, "rebuilt": True, "cache_id": cache_key, "cache_dir": str(cache_dir), **meta}


@app.delete("/api/cloud/session/{session_id}")
async def delete_cloud_session(session_id: str):
    """Free a cloud session's in-RAM arrays."""
    with _cloud_session_lock:
        existed = _cloud_sessions.pop(session_id, None) is not None
    return {"session_id": session_id, "deleted": existed}

GROUND_CLASS_SLUG = "ground_class"
GROUND_CLASS_LABEL = "Ground Class"

def _load_cloud_for_segmentation(
    source_path: _Path, ascii_format: Optional[str],
) -> tuple[np.ndarray, dict, List[dict]]:
    """Load a cloud for tree segmentation, format-agnostically. Returns
    (xyz[N,3] float64, scalars, extra_dims) where:
      - `scalars` maps each carried extra-dim slug -> float32 array aligned to xyz
        (RGB/intensity are folded in as ordinary scalars here; the LAS writer
        re-maps r255/g255/b255 to RGB and intensity to the LAS intensity field).
      - `extra_dims` is the [{slug,label}, ...] list for the slug->label sidecar
        (matches the shape `_xyz_column_plan` / `_ply_to_las` produce).

    XYZ-family is read via pandas (honouring the Helios ascii_format); PLY via
    plyfile (carries every numeric vertex property — incl. benchmark `instance`/
    `semantic` labels); PCD via open3d (points/RGB only). Keeping this in one
    place lets segment_trees/apply accept the same formats the importer does.
    """
    ext = source_path.suffix.lower().lstrip(".")

    if ext in _PANDAS_EXTENSIONS:
        names, extra_dims = _xyz_column_plan(source_path, ascii_format)
        if not all(role in names for role in ("x", "y", "z")):
            raise HTTPException(
                status_code=400,
                detail=f"ASCII format must include x/y/z. Got columns: {names}",
            )
        skiprows = 1 if _first_data_row_has_letters(str(source_path)) else 0
        df = pd.read_csv(
            source_path, sep=r"\s+", header=None, names=names,
            usecols=[i for i, c in enumerate(names) if not _is_skip_name(c)],
            comment="#", skiprows=skiprows, engine="c",
        )
        xyz = np.column_stack([
            df["x"].to_numpy(dtype=np.float64),
            df["y"].to_numpy(dtype=np.float64),
            df["z"].to_numpy(dtype=np.float64),
        ])
        scalars: dict = {}
        if all(c in names for c in ("r255", "g255", "b255")):
            for c in ("r255", "g255", "b255"):
                scalars[c] = df[c].to_numpy(dtype=np.float32)
        ir = next((r for r in ("intensity", "reflectance") if r in names), None)
        if ir is not None:
            scalars["intensity"] = df[ir].to_numpy(dtype=np.float32)
        for ed in extra_dims:
            scalars[ed["slug"]] = df[ed["col"]].to_numpy(dtype=np.float32)
        return xyz, scalars, extra_dims

    if ext == "ply":
        from plyfile import PlyData
        try:
            vertex = PlyData.read(str(source_path))["vertex"].data
        except KeyError:
            raise HTTPException(
                status_code=400,
                detail="PLY has no 'vertex' element; cannot import as a point cloud.",
            )
        names = list(vertex.dtype.names or ())
        if not all(c in names for c in ("x", "y", "z")):
            raise HTTPException(
                status_code=400, detail=f"PLY missing x/y/z vertex properties. Got: {names}",
            )
        xyz = np.column_stack([
            vertex["x"].astype(np.float64),
            vertex["y"].astype(np.float64),
            vertex["z"].astype(np.float64),
        ])
        rgb = (("red", "green", "blue") if all(c in names for c in ("red", "green", "blue"))
               else ("r", "g", "b") if all(c in names for c in ("r", "g", "b")) else None)
        intensity_col = next(
            (c for c in ("intensity", "scalar_intensity", "reflectance") if c in names), None)
        reserved = {"x", "y", "z"}
        if rgb:
            reserved.update(rgb)
        if intensity_col:
            reserved.add(intensity_col)
        scalars = {}
        extra_dims = []
        used_slugs: set[str] = set()
        if rgb:
            scalars["r255"] = vertex[rgb[0]].astype(np.float32)
            scalars["g255"] = vertex[rgb[1]].astype(np.float32)
            scalars["b255"] = vertex[rgb[2]].astype(np.float32)
        if intensity_col is not None:
            scalars["intensity"] = vertex[intensity_col].astype(np.float32)
        for col in names:
            if col in reserved or not np.issubdtype(vertex[col].dtype, np.number):
                continue
            slug = _sanitize_extra_dim_name(col)
            base, i = slug, 1
            while slug in used_slugs:
                slug = f"{base[:29]}_{i}"; i += 1
            used_slugs.add(slug)
            extra_dims.append({"col": col, "slug": slug, "label": _humanize_extra_dim_label(col)})
            scalars[slug] = vertex[col].astype(np.float32)
        return xyz, scalars, extra_dims

    if ext == "pcd":
        positions, colors, _ = _load_ply_pcd_arrays(str(source_path))
        xyz = positions.astype(np.float64, copy=False)
        scalars = {}
        if colors is not None:
            # open3d colors are 0-1; store as 0-255 to match the r255 convention.
            scalars["r255"] = (colors[:, 0] * 255.0).astype(np.float32)
            scalars["g255"] = (colors[:, 1] * 255.0).astype(np.float32)
            scalars["b255"] = (colors[:, 2] * 255.0).astype(np.float32)
        return xyz, scalars, []

    raise HTTPException(
        status_code=400,
        detail=(f"segment_trees/apply: unsupported source extension .{ext}. "
                f"Supported: {sorted(_PANDAS_EXTENSIONS | _OPEN3D_EXTENSIONS)}"),
    )


# ==================== Cloud-to-Mesh Distance Comparison ====================

class C2MDistanceRequest(BaseModel):
    """Request for computing cloud-to-mesh distance statistics."""
    # Point cloud data (flat array: x,y,z,x,y,z,...). Optional because
    # octree-backed clouds send `source` instead.
    points: Optional[List[float]] = None
    # Read the cloud from a file on disk (octree-backed clouds).
    source: Optional[PointSource] = None
    # Mesh vertices (flat array: x,y,z,x,y,z,...)
    mesh_vertices: List[float]
    # Mesh triangle indices (flat array: i0,i1,i2,i0,i1,i2,...)
    mesh_indices: List[int]


class C2MDistanceResponse(BaseModel):
    """Response with cloud-to-mesh distance statistics."""
    success: bool
    error: Optional[str] = None
    # Statistics
    mean_distance: Optional[float] = None
    rmse: Optional[float] = None  # Root Mean Square Error
    std_deviation: Optional[float] = None
    min_distance: Optional[float] = None
    max_distance: Optional[float] = None
    median_distance: Optional[float] = None
    percentile_90: Optional[float] = None
    percentile_95: Optional[float] = None
    percentile_99: Optional[float] = None
    # Coverage metrics
    points_within_1mm: Optional[float] = None  # Percentage of points within 1mm
    points_within_5mm: Optional[float] = None  # Percentage of points within 5mm
    points_within_10mm: Optional[float] = None  # Percentage of points within 10mm
    # Raw data for visualization (optional, can be large)
    point_count: Optional[int] = None


@app.post("/api/c2m/distance", response_model=C2MDistanceResponse)
async def compute_c2m_distance(request: C2MDistanceRequest):
    """
    Compute Cloud-to-Mesh (C2M) distance statistics.

    Uses Open3D's RaycastingScene for efficient point-to-mesh distance computation.
    Returns comprehensive statistics about how well the mesh fits the point cloud.
    """
    try:
        import open3d as o3d
        import numpy as np

        # Convert flat arrays to numpy arrays. The source reader already returns
        # (N,3) — only the inline flat array needs reshaping.
        if request.source is not None:
            points, _, _ = _read_points_from_source(request.source)
        else:
            points = np.array(request.points or [], dtype=np.float64).reshape(-1, 3)
        vertices = np.array(request.mesh_vertices, dtype=np.float64).reshape(-1, 3)
        triangles = np.array(request.mesh_indices, dtype=np.int32).reshape(-1, 3)

        if len(points) == 0:
            return C2MDistanceResponse(
                success=False,
                error="No points provided"
            )

        if len(vertices) == 0 or len(triangles) == 0:
            return C2MDistanceResponse(
                success=False,
                error="No mesh data provided"
            )

        # Create Open3D triangle mesh
        mesh = o3d.t.geometry.TriangleMesh()
        mesh.vertex.positions = o3d.core.Tensor(vertices, dtype=o3d.core.float32)
        mesh.triangle.indices = o3d.core.Tensor(triangles, dtype=o3d.core.int32)

        # Create raycasting scene for efficient distance queries
        scene = o3d.t.geometry.RaycastingScene()
        scene.add_triangles(mesh)

        # Compute unsigned distances from each point to the mesh
        query_points = o3d.core.Tensor(points, dtype=o3d.core.float32)
        distances = scene.compute_distance(query_points).numpy()

        # Compute statistics
        mean_dist = float(np.mean(distances))
        rmse = float(np.sqrt(np.mean(distances ** 2)))
        std_dev = float(np.std(distances))
        min_dist = float(np.min(distances))
        max_dist = float(np.max(distances))
        median_dist = float(np.median(distances))
        p90 = float(np.percentile(distances, 90))
        p95 = float(np.percentile(distances, 95))
        p99 = float(np.percentile(distances, 99))

        # Coverage metrics (using adaptive thresholds based on data scale)
        # Use percentages of the bounding box diagonal as thresholds
        bbox_diag = np.linalg.norm(points.max(axis=0) - points.min(axis=0))
        thresh_1mm = bbox_diag * 0.001  # 0.1% of diagonal
        thresh_5mm = bbox_diag * 0.005  # 0.5% of diagonal
        thresh_10mm = bbox_diag * 0.01  # 1% of diagonal

        within_1mm = float(np.sum(distances <= thresh_1mm) / len(distances) * 100)
        within_5mm = float(np.sum(distances <= thresh_5mm) / len(distances) * 100)
        within_10mm = float(np.sum(distances <= thresh_10mm) / len(distances) * 100)

        return C2MDistanceResponse(
            success=True,
            mean_distance=mean_dist,
            rmse=rmse,
            std_deviation=std_dev,
            min_distance=min_dist,
            max_distance=max_dist,
            median_distance=median_dist,
            percentile_90=p90,
            percentile_95=p95,
            percentile_99=p99,
            points_within_1mm=within_1mm,
            points_within_5mm=within_5mm,
            points_within_10mm=within_10mm,
            point_count=len(points)
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return C2MDistanceResponse(
            success=False,
            error=f"C2M distance computation failed: {str(e)}"
        )


# ==================== ICP Registration (Snap to Fit) ====================

class ICPRegistrationRequest(BaseModel):
    """Request for ICP registration to align mesh to point cloud."""
    # Point cloud data (flat array: x,y,z,x,y,z,...) - the TARGET (stays fixed).
    # Optional because octree-backed clouds send `source` instead.
    points: Optional[List[float]] = None
    # Read the target cloud from a file on disk (octree-backed clouds).
    source: Optional[PointSource] = None
    # Mesh vertices (flat array: x,y,z,x,y,z,...) - the SOURCE (to be moved)
    mesh_vertices: List[float]
    # Mesh triangle indices (flat array: i0,i1,i2,i0,i1,i2,...)
    mesh_indices: List[int]
    # Maximum correspondence distance threshold
    max_correspondence_distance: Optional[float] = None
    # Maximum iterations per ICP round
    max_iterations: int = 100
    # RMSE convergence threshold (stop when RMSE improvement < this)
    rmse_threshold: float = 1e-6


class ICPRegistrationResponse(BaseModel):
    """Response with ICP registration transformation."""
    success: bool
    error: Optional[str] = None
    # Translation to apply to the mesh (dx, dy, dz) - includes center alignment + ICP
    translation: Optional[List[float]] = None
    # Full 4x4 transformation matrix (row-major, for advanced usage)
    transformation_matrix: Optional[List[float]] = None
    # Fitness score (0-1, higher is better)
    fitness: Optional[float] = None
    # RMSE after alignment
    rmse: Optional[float] = None
    # Number of ICP iterations performed
    iterations: Optional[int] = None


def run_icp_until_convergence(source_pcd, target_pcd, max_corr_dist, init_transform, max_iterations=100, rmse_threshold=1e-6):
    """
    Run ICP iteratively until RMSE plateaus (convergence).
    Returns the final transformation and metrics.
    """
    import open3d as o3d
    import numpy as np

    current_transform = init_transform.copy()
    prev_rmse = float('inf')
    total_iterations = 0

    # Run ICP in batches until convergence
    batch_size = 20  # iterations per batch
    max_batches = max_iterations // batch_size

    for batch in range(max_batches):
        reg_result = o3d.pipelines.registration.registration_icp(
            source_pcd,
            target_pcd,
            max_corr_dist,
            current_transform,
            o3d.pipelines.registration.TransformationEstimationPointToPlane(),
            o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=batch_size)
        )

        current_transform = reg_result.transformation
        current_rmse = reg_result.inlier_rmse
        total_iterations += batch_size

        # Check for convergence (RMSE plateau)
        rmse_improvement = prev_rmse - current_rmse
        if rmse_improvement < rmse_threshold and rmse_improvement >= 0:
            print(f"ICP converged after {total_iterations} iterations. RMSE: {current_rmse:.6f}")
            break

        prev_rmse = current_rmse

    return reg_result, total_iterations


@app.post("/api/c2m/icp-register", response_model=ICPRegistrationResponse)
async def icp_register_mesh_to_cloud(request: ICPRegistrationRequest):
    """
    Perform ICP (Iterative Closest Point) registration to align a mesh to a point cloud.

    The point cloud is the TARGET (stays fixed), the mesh is the SOURCE (will be transformed).
    Pre-aligns by moving source center to target center, then runs ICP until convergence.
    """
    try:
        import open3d as o3d
        import numpy as np

        # Convert flat arrays to numpy arrays. The source reader already returns
        # (N,3) — only the inline flat array needs reshaping.
        if request.source is not None:
            points, _, _ = _read_points_from_source(request.source)
        else:
            points = np.array(request.points or [], dtype=np.float64).reshape(-1, 3)
        vertices = np.array(request.mesh_vertices, dtype=np.float64).reshape(-1, 3)
        triangles = np.array(request.mesh_indices, dtype=np.int32).reshape(-1, 3)

        if len(points) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No points provided"
            )

        if len(vertices) == 0 or len(triangles) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No mesh data provided"
            )

        # Create point cloud (TARGET - stays fixed)
        target_pcd = o3d.geometry.PointCloud()
        target_pcd.points = o3d.utility.Vector3dVector(points)

        # Create mesh and sample points from it (SOURCE - to be moved)
        mesh = o3d.geometry.TriangleMesh()
        mesh.vertices = o3d.utility.Vector3dVector(vertices)
        mesh.triangles = o3d.utility.Vector3iVector(triangles)

        # Sample points from mesh surface for ICP
        num_samples = min(len(points), 50000)
        source_pcd = mesh.sample_points_uniformly(number_of_points=num_samples)

        # --- STEP 1: Center alignment (move source centroid to target centroid) ---
        target_center = target_pcd.get_center()
        source_center = source_pcd.get_center()
        center_offset = target_center - source_center

        # Apply center alignment to source
        source_pcd.translate(center_offset)

        print(f"Center alignment: moved source by [{center_offset[0]:.4f}, {center_offset[1]:.4f}, {center_offset[2]:.4f}]")

        # Estimate normals for point-to-plane ICP (more robust)
        # Use adaptive radius based on point cloud density
        bbox = target_pcd.get_axis_aligned_bounding_box()
        diagonal = np.linalg.norm(bbox.max_bound - bbox.min_bound)
        normal_radius = diagonal * 0.02  # 2% of diagonal

        target_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))
        source_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))

        # Determine max correspondence distance if not provided
        if request.max_correspondence_distance is None:
            max_corr_dist = diagonal * 0.05  # Start with 5% of diagonal for robustness
        else:
            max_corr_dist = request.max_correspondence_distance

        # --- STEP 2: Run ICP until convergence ---
        init_transform = np.eye(4)
        reg_result, iterations = run_icp_until_convergence(
            source_pcd, target_pcd, max_corr_dist, init_transform,
            max_iterations=request.max_iterations, rmse_threshold=request.rmse_threshold
        )

        # Combine center alignment with ICP transformation using proper matrix composition
        # The sequence is: first translate source to target center (T_center), then apply ICP (T_icp)
        # Combined transform = T_icp @ T_center
        icp_transform = reg_result.transformation

        # Create center alignment matrix
        T_center = np.eye(4)
        T_center[0, 3] = center_offset[0]
        T_center[1, 3] = center_offset[1]
        T_center[2, 3] = center_offset[2]

        # Compose transformations: T_icp @ T_center
        # This correctly handles rotation - ICP transform is applied AFTER center alignment
        combined_transform = icp_transform @ T_center

        # Extract translation for convenience (this is the total translation to apply to original source)
        translation = [float(combined_transform[0, 3]), float(combined_transform[1, 3]), float(combined_transform[2, 3])]
        transform_flat = combined_transform.flatten().tolist()

        print(f"ICP complete - fitness: {reg_result.fitness:.4f}, RMSE: {reg_result.inlier_rmse:.6f}, iterations: {iterations}")

        return ICPRegistrationResponse(
            success=True,
            translation=translation,
            transformation_matrix=transform_flat,
            fitness=float(reg_result.fitness),
            rmse=float(reg_result.inlier_rmse),
            iterations=iterations
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return ICPRegistrationResponse(
            success=False,
            error=f"ICP registration failed: {str(e)}"
        )


class CloudToCloudICPRequest(BaseModel):
    """Request for ICP registration to align one point cloud to another."""
    # Target point cloud (flat array: x,y,z,x,y,z,...) - stays fixed. Optional
    # because an octree-backed target sends `target_source` instead.
    target_points: Optional[List[float]] = None
    # Source point cloud (flat array: x,y,z,x,y,z,...) - will be transformed.
    # Optional because an octree-backed source sends `source_source` instead.
    source_points: Optional[List[float]] = None
    # Read either side from a file on disk (octree-backed clouds). Each side is
    # resolved independently, so a flat cloud and an octree cloud can be mixed.
    target_source: Optional[PointSource] = None
    source_source: Optional[PointSource] = None
    # Maximum correspondence distance threshold
    max_correspondence_distance: Optional[float] = None
    # Maximum iterations per ICP round
    max_iterations: int = 100
    # RMSE convergence threshold
    rmse_threshold: float = 1e-6


@app.post("/api/c2c/icp-register", response_model=ICPRegistrationResponse)
async def icp_register_cloud_to_cloud(request: CloudToCloudICPRequest):
    """
    Perform ICP (Iterative Closest Point) registration to align one point cloud to another.

    The target cloud stays fixed, the source cloud will be transformed.
    Pre-aligns by moving source center to target center, then runs ICP until convergence.
    """
    try:
        import open3d as o3d
        import numpy as np

        # Resolve each side independently — either may be a flat inline array
        # or an octree source descriptor. The source reader returns (N,3);
        # inline flat arrays need reshaping.
        if request.target_source is not None:
            target_points, _, _ = _read_points_from_source(request.target_source)
        else:
            target_points = np.array(request.target_points or [], dtype=np.float64).reshape(-1, 3)
        if request.source_source is not None:
            source_points, _, _ = _read_points_from_source(request.source_source)
        else:
            source_points = np.array(request.source_points or [], dtype=np.float64).reshape(-1, 3)

        if len(target_points) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No target points provided"
            )

        if len(source_points) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No source points provided"
            )

        # Create target point cloud (stays fixed)
        target_pcd = o3d.geometry.PointCloud()
        target_pcd.points = o3d.utility.Vector3dVector(target_points)

        # Create source point cloud (will be transformed)
        source_pcd = o3d.geometry.PointCloud()
        source_pcd.points = o3d.utility.Vector3dVector(source_points)

        # Optionally downsample if clouds are very large (for performance)
        max_points = 100000
        if len(target_points) > max_points:
            target_pcd = target_pcd.uniform_down_sample(every_k_points=max(1, len(target_points) // max_points))
        if len(source_points) > max_points:
            source_pcd = source_pcd.uniform_down_sample(every_k_points=max(1, len(source_points) // max_points))

        # --- STEP 1: Center alignment (move source centroid to target centroid) ---
        target_center = target_pcd.get_center()
        source_center = source_pcd.get_center()
        center_offset = target_center - source_center

        # Apply center alignment to source
        source_pcd.translate(center_offset)

        print(f"Center alignment: moved source by [{center_offset[0]:.4f}, {center_offset[1]:.4f}, {center_offset[2]:.4f}]")

        # Estimate normals for point-to-plane ICP (more robust)
        bbox = target_pcd.get_axis_aligned_bounding_box()
        diagonal = np.linalg.norm(bbox.max_bound - bbox.min_bound)
        normal_radius = diagonal * 0.02

        target_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))
        source_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))

        # Determine max correspondence distance if not provided
        if request.max_correspondence_distance is None:
            max_corr_dist = diagonal * 0.05
        else:
            max_corr_dist = request.max_correspondence_distance

        # --- STEP 2: Run ICP until convergence ---
        init_transform = np.eye(4)
        reg_result, iterations = run_icp_until_convergence(
            source_pcd, target_pcd, max_corr_dist, init_transform,
            max_iterations=request.max_iterations, rmse_threshold=request.rmse_threshold
        )

        # Combine center alignment with ICP transformation using proper matrix composition
        # The sequence is: first translate source to target center (T_center), then apply ICP (T_icp)
        # Combined transform = T_icp @ T_center
        icp_transform = reg_result.transformation

        # Create center alignment matrix
        T_center = np.eye(4)
        T_center[0, 3] = center_offset[0]
        T_center[1, 3] = center_offset[1]
        T_center[2, 3] = center_offset[2]

        # Compose transformations: T_icp @ T_center
        # This correctly handles rotation - ICP transform is applied AFTER center alignment
        combined_transform = icp_transform @ T_center

        # Extract translation for convenience (this is the total translation to apply to original source)
        translation = [float(combined_transform[0, 3]), float(combined_transform[1, 3]), float(combined_transform[2, 3])]
        transform_flat = combined_transform.flatten().tolist()

        print(f"Cloud-to-cloud ICP complete - fitness: {reg_result.fitness:.4f}, RMSE: {reg_result.inlier_rmse:.6f}, iterations: {iterations}")

        return ICPRegistrationResponse(
            success=True,
            translation=translation,
            transformation_matrix=transform_flat,
            fitness=float(reg_result.fitness),
            rmse=float(reg_result.inlier_rmse),
            iterations=iterations
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return ICPRegistrationResponse(
            success=False,
            error=f"Cloud-to-cloud ICP registration failed: {str(e)}"
        )


class MeshToMeshICPRequest(BaseModel):
    """Request for ICP registration to align one mesh to another."""
    # Target mesh (stays fixed)
    target_vertices: List[float]  # flat array: x,y,z,x,y,z,...
    target_indices: List[int]     # triangle indices: i,j,k,i,j,k,...
    # Source mesh (will be transformed)
    source_vertices: List[float]  # flat array: x,y,z,x,y,z,...
    source_indices: List[int]     # triangle indices: i,j,k,i,j,k,...
    # Maximum correspondence distance threshold
    max_correspondence_distance: Optional[float] = None
    # Maximum iterations per ICP round
    max_iterations: int = 100
    # RMSE convergence threshold
    rmse_threshold: float = 1e-6


@app.post("/api/m2m/icp-register", response_model=ICPRegistrationResponse)
async def icp_register_mesh_to_mesh(request: MeshToMeshICPRequest):
    """
    Perform ICP (Iterative Closest Point) registration to align one mesh to another.

    The target mesh stays fixed, the source mesh will be transformed.
    Pre-aligns by moving source center to target center, then runs ICP until convergence.
    """
    try:
        import open3d as o3d
        import numpy as np

        # Convert flat arrays to numpy arrays
        target_verts = np.array(request.target_vertices, dtype=np.float64).reshape(-1, 3)
        target_tris = np.array(request.target_indices, dtype=np.int32).reshape(-1, 3)
        source_verts = np.array(request.source_vertices, dtype=np.float64).reshape(-1, 3)
        source_tris = np.array(request.source_indices, dtype=np.int32).reshape(-1, 3)

        if len(target_verts) == 0 or len(target_tris) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No target mesh data provided"
            )

        if len(source_verts) == 0 or len(source_tris) == 0:
            return ICPRegistrationResponse(
                success=False,
                error="No source mesh data provided"
            )

        # Create target mesh and sample points
        target_mesh = o3d.geometry.TriangleMesh()
        target_mesh.vertices = o3d.utility.Vector3dVector(target_verts)
        target_mesh.triangles = o3d.utility.Vector3iVector(target_tris)

        # Create source mesh and sample points
        source_mesh = o3d.geometry.TriangleMesh()
        source_mesh.vertices = o3d.utility.Vector3dVector(source_verts)
        source_mesh.triangles = o3d.utility.Vector3iVector(source_tris)

        # Sample points from mesh surfaces for ICP
        num_samples = min(50000, max(len(target_verts), len(source_verts)) * 10)
        target_pcd = target_mesh.sample_points_uniformly(number_of_points=num_samples)
        source_pcd = source_mesh.sample_points_uniformly(number_of_points=num_samples)

        # --- STEP 1: Center alignment (move source centroid to target centroid) ---
        target_center = target_pcd.get_center()
        source_center = source_pcd.get_center()
        center_offset = target_center - source_center

        # Apply center alignment to source
        source_pcd.translate(center_offset)

        print(f"Mesh-to-mesh center alignment: moved source by [{center_offset[0]:.4f}, {center_offset[1]:.4f}, {center_offset[2]:.4f}]")

        # Estimate normals for point-to-plane ICP (more robust)
        bbox = target_pcd.get_axis_aligned_bounding_box()
        diagonal = np.linalg.norm(bbox.max_bound - bbox.min_bound)
        normal_radius = diagonal * 0.02

        target_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))
        source_pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=normal_radius, max_nn=30))

        # Determine max correspondence distance if not provided
        if request.max_correspondence_distance is None:
            max_corr_dist = diagonal * 0.05
        else:
            max_corr_dist = request.max_correspondence_distance

        # --- STEP 2: Run ICP until convergence ---
        init_transform = np.eye(4)
        reg_result, iterations = run_icp_until_convergence(
            source_pcd, target_pcd, max_corr_dist, init_transform,
            max_iterations=request.max_iterations, rmse_threshold=request.rmse_threshold
        )

        # Combine center alignment with ICP transformation using proper matrix composition
        # The sequence is: first translate source to target center (T_center), then apply ICP (T_icp)
        # Combined transform = T_icp @ T_center
        icp_transform = reg_result.transformation

        # Create center alignment matrix
        T_center = np.eye(4)
        T_center[0, 3] = center_offset[0]
        T_center[1, 3] = center_offset[1]
        T_center[2, 3] = center_offset[2]

        # Compose transformations: T_icp @ T_center
        # This correctly handles rotation - ICP transform is applied AFTER center alignment
        combined_transform = icp_transform @ T_center

        # Extract translation for convenience (this is the total translation to apply to original source)
        translation = [float(combined_transform[0, 3]), float(combined_transform[1, 3]), float(combined_transform[2, 3])]
        transform_flat = combined_transform.flatten().tolist()

        print(f"Mesh-to-mesh ICP complete - fitness: {reg_result.fitness:.4f}, RMSE: {reg_result.inlier_rmse:.6f}, iterations: {iterations}")

        return ICPRegistrationResponse(
            success=True,
            translation=translation,
            transformation_matrix=transform_flat,
            fitness=float(reg_result.fitness),
            rmse=float(reg_result.inlier_rmse),
            iterations=iterations
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        return ICPRegistrationResponse(
            success=False,
            error=f"Mesh-to-mesh ICP registration failed: {str(e)}"
        )
