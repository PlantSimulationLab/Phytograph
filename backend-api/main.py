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
BACKEND_VERSION = "0.3.7"

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
    # (`positions[i*3] + tx`) and `_filtered_xyz_to_las` (`xs + tx`).
    translation: Optional[List[float]] = None
    want_colors: bool = False


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
            # Alpha Shape
            if request.alpha is None:
                # Auto-compute alpha from point spacing
                distances = pcd.compute_nearest_neighbor_distance()
                alpha = np.mean(distances) * 2
            else:
                alpha = request.alpha

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
    `/api/segment/ground/apply`."""
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
    `/api/segment/trees/apply`."""
    try:
        points = _resolve_segmentation_points(
            GroundSegmentationRequest(points=request.points, source=request.source)
        )

        if len(points) < 10:
            return TreeSegmentationResponse(
                success=False, num_points=len(points),
                error="Need at least 10 points to segment trees",
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

class HeliosTriangulationRequest(BaseModel):
    """Request model for Helios triangulation"""
    scans: List[HeliosScanEntry]
    lmax: float = 0.5
    max_aspect_ratio: float = 4.0
    theta_min: float = 30.0   # Zenith angle min (degrees)
    theta_max: float = 130.0  # Zenith angle max (degrees)
    phi_min: float = 0.0      # Azimuth angle min (degrees)
    phi_max: float = 360.0    # Azimuth angle max (degrees)

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


def _generate_helios_xml(tmpdir: str, scans_info: list, grid_center: list,
                         grid_size: list, theta_min: float, theta_max: float,
                         phi_min: float, phi_max: float) -> str:
    """Generate a pyhelios XML config file for scan triangulation."""
    import os

    xml_lines = ['<?xml version="1.0"?>', '<helios>', '']

    for scan in scans_info:
        xml_lines.append('<scan>')
        xml_lines.append(f'    <filename>{scan["filepath"]}</filename>')
        xml_lines.append(f'    <ASCII_format>{scan["ascii_format"]}</ASCII_format>')
        xml_lines.append(f'    <origin>{scan["origin"][0]} {scan["origin"][1]} {scan["origin"][2]}</origin>')
        xml_lines.append(f'    <size>{scan["n_theta"]} {scan["n_phi"]}</size>')
        xml_lines.append(f'    <thetaMin>{theta_min}</thetaMin>')
        xml_lines.append(f'    <thetaMax>{theta_max}</thetaMax>')
        xml_lines.append(f'    <phiMin>{phi_min}</phiMin>')
        xml_lines.append(f'    <phiMax>{phi_max}</phiMax>')
        xml_lines.append('</scan>')
        xml_lines.append('')

    # Grid section is required for triangulation to work
    xml_lines.append('<grid>')
    xml_lines.append(f'    <center>{grid_center[0]} {grid_center[1]} {grid_center[2]}</center>')
    xml_lines.append(f'    <size>{grid_size[0]} {grid_size[1]} {grid_size[2]}</size>')
    xml_lines.append(f'    <Nx>2</Nx>')
    xml_lines.append(f'    <Ny>2</Ny>')
    xml_lines.append(f'    <Nz>2</Nz>')
    xml_lines.append('</grid>')
    xml_lines.append('')
    xml_lines.append('</helios>')

    xml_path = os.path.join(tmpdir, "helios_config.xml")
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
        from pyhelios import LiDARCloud, Context

        tmpdir = tempfile.mkdtemp(prefix="phytograph_helios_")

        scans_info = []
        use_file_paths = any(s.file_path for s in request.scans)

        if use_file_paths:
            # File-path mode: pyhelios reads scan files directly from disk
            origins = []
            for idx, scan_entry in enumerate(request.scans):
                origin = scan_entry.origin
                if len(origin) != 3:
                    raise ValueError(f"Origin must have 3 elements, got {len(origin)}")

                fp = scan_entry.file_path
                if not fp or not os.path.isfile(fp):
                    raise ValueError(f"Scan file not found: {fp}")

                # Auto-detect ASCII format if not specified
                fmt = scan_entry.ascii_format or _detect_ascii_format(fp)

                # Count lines to estimate grid size
                n_points = _count_file_lines(fp)
                theta_span = request.theta_max - request.theta_min
                phi_span = request.phi_max - request.phi_min
                aspect = theta_span / max(phi_span, 1e-10)
                n_phi = max(int(math.sqrt(n_points / max(aspect, 0.01))), 10)
                n_theta = max(int(n_points / n_phi), 10)

                scans_info.append({
                    "filepath": fp,
                    "ascii_format": fmt,
                    "origin": origin,
                    "n_theta": n_theta,
                    "n_phi": n_phi,
                })
                origins.append(origin)

            # Use scan origins centroid + generous grid size (no need to read files)
            origin_arr = np.array(origins)
            grid_center = origin_arr.mean(axis=0).tolist()
            grid_size = [500.0, 500.0, 500.0]
        else:
            # Points mode (fallback): write points to temp files
            all_points = []
            for idx, scan_entry in enumerate(request.scans):
                origin = scan_entry.origin
                if len(origin) != 3:
                    raise ValueError(f"Origin must have 3 elements, got {len(origin)}")

                points = scan_entry.points
                if not points:
                    raise ValueError("Scan entry has no points and no file_path")

                all_points.extend(points)

                pts_path = os.path.join(tmpdir, f"scan_{idx}.txt")
                with open(pts_path, "w") as f:
                    for pt in points:
                        f.write(f"{pt[0]} {pt[1]} {pt[2]}\n")

                n_points = len(points)
                theta_span = request.theta_max - request.theta_min
                phi_span = request.phi_max - request.phi_min
                aspect = theta_span / max(phi_span, 1e-10)
                n_phi = max(int(math.sqrt(n_points / max(aspect, 0.01))), 10)
                n_theta = max(int(n_points / n_phi), 10)

                scans_info.append({
                    "filepath": pts_path,
                    "ascii_format": "x y z",
                    "origin": origin,
                    "n_theta": n_theta,
                    "n_phi": n_phi,
                })

            pts_arr = np.array(all_points)
            bb_min = pts_arr.min(axis=0)
            bb_max = pts_arr.max(axis=0)
            grid_center = ((bb_min + bb_max) / 2).tolist()
            bb_size = np.maximum(bb_max - bb_min, 0.01) * 1.1
            grid_size = bb_size.tolist()

        # Generate XML config
        xml_path = _generate_helios_xml(
            tmpdir, scans_info, grid_center, grid_size,
            request.theta_min, request.theta_max,
            request.phi_min, request.phi_max
        )

        # Load XML and triangulate
        cloud = LiDARCloud()
        cloud.disableMessages()
        cloud.loadXML(xml_path)
        cloud.triangulateHitPoints(request.lmax, request.max_aspect_ratio)
        tri_count = cloud.getTriangleCount()

        if tri_count == 0:
            return {
                "success": True,
                "vertices": [],
                "triangles": [],
                "num_triangles": 0,
                "num_vertices": 0,
                "method_used": "helios",
                "error": "No triangles generated. Try increasing Lmax or adjusting max_aspect_ratio."
            }

        # Extract triangles via Context with vertex deduplication
        with Context() as ctx:
            cloud.addTrianglesToContext(ctx)
            uuids = ctx.getAllUUIDs()

            vertex_map = {}      # (rx, ry, rz) -> index
            unique_vertices = [] # deduplicated vertex list
            triangles_list = []

            for uuid in uuids:
                tri_verts = ctx.getPrimitiveVertices(uuid)
                if len(tri_verts) != 3:
                    continue

                tri_indices = []
                for v in tri_verts:
                    key = (round(v.x, 5), round(v.y, 5), round(v.z, 5))
                    if key not in vertex_map:
                        vertex_map[key] = len(unique_vertices)
                        unique_vertices.append([key[0], key[1], key[2]])
                    tri_indices.append(vertex_map[key])

                triangles_list.append(tri_indices)

        # Calculate surface area from deduplicated data
        verts_arr = np.array(unique_vertices)
        tris_arr = np.array(triangles_list)
        v0 = verts_arr[tris_arr[:, 0]]
        v1 = verts_arr[tris_arr[:, 1]]
        v2 = verts_arr[tris_arr[:, 2]]
        total_area = float(0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1).sum())

        return {
            "success": True,
            "vertices": unique_vertices,
            "triangles": triangles_list,
            "surface_area": total_area,
            "num_triangles": len(triangles_list),
            "num_vertices": len(unique_vertices),
            "method_used": "helios"
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


# ==================== MESH SURFACE SAMPLING ====================

class MeshSampleRequest(BaseModel):
    """Request model for sampling points from a mesh surface"""
    vertices: List[List[float]]  # [[x, y, z], ...] - mesh vertices
    triangles: List[List[int]]  # [[i, j, k], ...] - triangle vertex indices
    vertex_colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] - colors per vertex (0-1 range)

    # Sampling parameters
    num_points: Optional[int] = None  # Target number of points (if not using density)
    density: Optional[float] = None  # Points per square meter (if not using num_points)

    # Options
    seed: Optional[int] = None  # Random seed for reproducibility


class MeshSampleResponse(BaseModel):
    """Response model for mesh sampling results"""
    success: bool
    points: List[List[float]]  # [[x, y, z], ...] - sampled point positions
    colors: Optional[List[List[float]]] = None  # [[r, g, b], ...] - interpolated colors
    num_points: int
    surface_area: float  # Total surface area of the mesh
    error: Optional[str] = None


def sample_mesh_surface(
    vertices: np.ndarray,
    triangles: np.ndarray,
    vertex_colors: Optional[np.ndarray],
    num_points: int,
    rng: np.random.Generator
) -> tuple:
    """
    Sample points uniformly from a triangulated mesh surface.

    Uses area-weighted random sampling with barycentric coordinate interpolation.

    Args:
        vertices: (N, 3) array of vertex positions
        triangles: (M, 3) array of triangle indices
        vertex_colors: Optional (N, 3) array of vertex colors
        num_points: Number of points to sample
        rng: NumPy random generator

    Returns:
        Tuple of (sampled_points, sampled_colors, total_area)
    """
    # Get triangle vertices
    v0 = vertices[triangles[:, 0]]
    v1 = vertices[triangles[:, 1]]
    v2 = vertices[triangles[:, 2]]

    # Calculate triangle areas using cross product
    cross = np.cross(v1 - v0, v2 - v0)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    total_area = np.sum(areas)

    if total_area == 0:
        return np.array([]), None, 0.0

    # Normalize areas to get probability distribution
    probs = areas / total_area

    # Sample triangles based on area
    triangle_indices = rng.choice(len(triangles), size=num_points, p=probs)

    # Generate random barycentric coordinates
    # Using the square root trick for uniform sampling within triangles
    r1 = rng.random(num_points)
    r2 = rng.random(num_points)
    sqrt_r1 = np.sqrt(r1)

    # Barycentric coordinates
    u = 1 - sqrt_r1
    v = sqrt_r1 * (1 - r2)
    w = sqrt_r1 * r2

    # Get the vertices for sampled triangles
    sampled_v0 = vertices[triangles[triangle_indices, 0]]
    sampled_v1 = vertices[triangles[triangle_indices, 1]]
    sampled_v2 = vertices[triangles[triangle_indices, 2]]

    # Interpolate positions using barycentric coordinates
    sampled_points = (
        u[:, np.newaxis] * sampled_v0 +
        v[:, np.newaxis] * sampled_v1 +
        w[:, np.newaxis] * sampled_v2
    )

    # Interpolate colors if provided
    sampled_colors = None
    if vertex_colors is not None:
        c0 = vertex_colors[triangles[triangle_indices, 0]]
        c1 = vertex_colors[triangles[triangle_indices, 1]]
        c2 = vertex_colors[triangles[triangle_indices, 2]]
        sampled_colors = (
            u[:, np.newaxis] * c0 +
            v[:, np.newaxis] * c1 +
            w[:, np.newaxis] * c2
        )
        # Clamp colors to [0, 1]
        sampled_colors = np.clip(sampled_colors, 0, 1)

    return sampled_points, sampled_colors, total_area


@app.post("/api/mesh/sample", response_model=MeshSampleResponse)
async def sample_mesh(request: MeshSampleRequest):
    """
    Sample points uniformly from a mesh surface.

    This tool converts a triangulated mesh into a point cloud by randomly sampling
    points from the mesh surface. Points are distributed uniformly based on triangle
    area, so larger triangles get proportionally more points.

    If the mesh has vertex colors, they are interpolated to the sampled points.

    Request fields (on ``MeshSampleRequest``):

    * ``num_points`` — target number of points to sample (default: auto based on area)
    * ``density`` — points per square meter (alternative to ``num_points``)
    * ``seed`` — random seed for reproducible results

    Returns point positions and optionally colors.
    """
    try:
        vertices = np.array(request.vertices, dtype=np.float64)
        triangles = np.array(request.triangles, dtype=np.int32)

        if len(vertices) < 3:
            return MeshSampleResponse(
                success=False,
                points=[],
                num_points=0,
                surface_area=0.0,
                error="Need at least 3 vertices"
            )

        if len(triangles) < 1:
            return MeshSampleResponse(
                success=False,
                points=[],
                num_points=0,
                surface_area=0.0,
                error="Need at least 1 triangle"
            )

        # Parse vertex colors if provided
        vertex_colors = None
        if request.vertex_colors is not None and len(request.vertex_colors) > 0:
            vertex_colors = np.array(request.vertex_colors, dtype=np.float64)

        # Calculate surface area first (needed for density-based sampling)
        v0 = vertices[triangles[:, 0]]
        v1 = vertices[triangles[:, 1]]
        v2 = vertices[triangles[:, 2]]
        cross = np.cross(v1 - v0, v2 - v0)
        areas = 0.5 * np.linalg.norm(cross, axis=1)
        total_area = np.sum(areas)

        # Determine number of points to sample
        if request.num_points is not None:
            num_points = request.num_points
        elif request.density is not None:
            num_points = int(request.density * total_area)
        else:
            # Default: ~1000 points per square meter, min 100, max 1M
            num_points = max(100, min(1000000, int(1000 * total_area)))

        # Ensure at least some points
        num_points = max(1, num_points)

        # Create random generator
        rng = np.random.default_rng(request.seed)

        # Sample the mesh
        sampled_points, sampled_colors, _ = sample_mesh_surface(
            vertices, triangles, vertex_colors, num_points, rng
        )

        # Convert to lists for JSON response
        points_list = sampled_points.tolist()
        colors_list = sampled_colors.tolist() if sampled_colors is not None else None

        return MeshSampleResponse(
            success=True,
            points=points_list,
            colors=colors_list,
            num_points=len(points_list),
            surface_area=float(total_area)
        )

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Mesh sampling failed: {str(e)}")


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
    Returns (vertices, indices, colors, vertex_count, triangle_count)
    """
    import os

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
    faces = []
    vertex_index = 0

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

        for prim_info in prim_infos:
            try:
                if prim_info.primitive_type.value != 1:
                    continue

                tri_verts = prim_info.vertices
                if len(tri_verts) != 3:
                    continue

                prim_color = prim_info.color
                color_rgb = [prim_color.r, prim_color.g, prim_color.b]

                # Color assignment logic
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

                face_indices = []
                for v in tri_verts:
                    vertices.append([v.x, v.y, v.z])
                    colors.append(color_rgb)
                    face_indices.append(vertex_index)
                    vertex_index += 1

                faces.append(face_indices)
            except:
                continue

    return vertices, faces, colors, len(vertices), len(faces)


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

        # Extract geometry
        vertices, faces, colors, vertex_count, triangle_count = _extract_session_geometry(session)

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

        # Extract geometry
        vertices, faces, colors, vertex_count, triangle_count = _extract_session_geometry(session)

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


def compute_leaf_uvs(vertices: list) -> list:
    """
    Compute UV coordinates for a planar leaf mesh using PCA.

    Each leaf object is nearly-planar, so we project vertices onto the leaf's
    principal plane to get 2D UV coordinates.

    Args:
        vertices: List of [x, y, z] vertex positions

    Returns:
        List of [u, v] coordinates normalized to 0-1 range
    """
    import numpy as np

    verts = np.array(vertices)
    if len(verts) < 3:
        return [[0.5, 0.5]] * len(verts)

    center = verts.mean(axis=0)
    centered = verts - center

    # PCA to find leaf plane
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # Project onto 2D plane (largest variance axes)
    # eigenvalues are sorted ascending, so index 2 is largest, 1 is second
    u_axis = eigenvectors[:, 2]
    v_axis = eigenvectors[:, 1]

    uvs = []
    for vert in centered:
        u = np.dot(vert, u_axis)
        v = np.dot(vert, v_axis)
        uvs.append([u, v])

    # Normalize to 0-1 range
    uvs = np.array(uvs)
    uv_min = uvs.min(axis=0)
    uv_max = uvs.max(axis=0)
    uv_range = uv_max - uv_min
    # Avoid division by zero
    uv_range = np.where(uv_range < 1e-10, 1.0, uv_range)
    normalized_uvs = (uvs - uv_min) / uv_range

    return normalized_uvs.tolist()


@app.post("/api/plant/generate", response_model=PlantGenerationResponse)
async def generate_plant_model(request: PlantGenerationRequest):
    """
    Generate a procedural plant model using pyhelios PlantArchitecture.

    Uses direct primitive extraction from pyhelios Context API to get valid geometry.
    For textured leaves, computes UV coordinates via PCA projection.
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

                    # Compute UVs for textured objects
                    object_uvs = None
                    if is_textured and len(object_vertices) >= 3:
                        object_uvs = compute_leaf_uvs(object_vertices)
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
                    uv_index = 0
                    for prim_info, tri_verts in object_triangles:
                        # Get color (RGBcolor has r, g, b attributes)
                        prim_color = prim_info.color
                        color_rgb = [prim_color.r, prim_color.g, prim_color.b]

                        # Color assignment logic for vertex color rendering
                        # (textures are currently disabled, so we rely on vertex colors)

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

                        # Add vertices, colors, normals, and UVs for this triangle
                        tri_indices = []
                        for v in tri_verts:
                            vertices.append([v.x, v.y, v.z])
                            colors.append(color_rgb)
                            normals.append(normal_xyz)

                            # Add UV if textured
                            if object_uvs and uv_index < len(object_uvs):
                                uvs.append(object_uvs[uv_index])
                            else:
                                uvs.append([0.0, 0.0])  # Default UV for non-textured
                            uv_index += 1

                            tri_indices.append(vertex_index)
                            vertex_index += 1

                        faces.append(tri_indices)

                        # Track which material this triangle uses
                        if is_textured and mat_label in material_groups_dict:
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
# DATA_ROLES populate fields in the response; the others (timestamp,
# target_index, …) are parsed but dropped so pandas knows the column exists
# and won't misalign downstream columns.
_XYZ_DATA_ROLES = {
    'x', 'y', 'z',
    'r', 'g', 'b',
    'r255', 'g255', 'b255',
    'intensity', 'reflectance',
}
_XYZ_KNOWN_ROLES = _XYZ_DATA_ROLES | {
    'timestamp', 'target_index', 'target_count', 'deviation',
}

# Magic bytes on the wire. Renderer aborts if it sees anything else, so the
# format is implicitly versioned by this value.
_POINTCLOUD_BIN_MAGIC = b'PHX1'

# Extensions dispatched to the pandas-based ASCII path. Anything in this set
# may be accompanied by a Helios `ascii_format` hint; PLY/PCD ignore it.
_PANDAS_EXTENSIONS = {'xyz', 'txt', 'csv', 'pts', 'asc'}
_OPEN3D_EXTENSIONS = {'ply', 'pcd'}


class ImportPointCloudByPathRequest(BaseModel):
    """Path-based point-cloud import.

    `ascii_format` is a Helios <ASCII_format> string (e.g.
    'x y z r255 g255 b255 reflectance') and applies only to XYZ-family
    extensions; PLY/PCD ignore it because their column layout is in-file.
    If omitted for an XYZ-family file, columns are sniffed from the first
    non-blank, non-comment row.
    """
    file_path: str
    ascii_format: Optional[str] = None


def _tokenize_ascii_format(fmt: str) -> List[str]:
    return [tok.lower() if tok.lower() in _XYZ_KNOWN_ROLES else 'skip'
            for tok in fmt.split()]


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
    if base in ('r', 'red'):
        return 'r255'
    if base in ('g', 'green'):
        return 'g255'
    if base in ('b', 'blue'):
        return 'b255'
    if base in ('intensity',):
        return 'intensity'
    if base in ('reflectance', 'reflectivity'):
        return 'reflectance'
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
    """Detect a leading text header row.

    Helios scan files don't have one, but plain XYZ exports from other tools
    sometimes do (e.g. 'X Y Z R G B'). We skip such a row so pandas can read
    the rest as floats without falling off the C engine."""
    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            return any(re.search(r'[a-zA-Z]', tok) for tok in line.split())
    return False


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
    return slug[:32]


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
    """
    with open(file_path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or line.startswith('//'):
                continue
            if not any(re.search(r'[a-zA-Z]', tok) for tok in line.split()):
                return None
            parts = line.split(',') if ',' in line else line.split()
            return [p.strip() for p in parts]
    return None


def _xyz_column_plan(source_path: "_Path", ascii_format: Optional[str]):
    """Resolve the column layout for an XYZ-family file, carrying unmapped
    numeric columns as octree extra dimensions.

    Returns (names, extra_dims) where:
      - `names` is the per-column identifier list for pandas `names=` — known
        roles keep their role token (x/y/z/r255/intensity/...), extras get a
        unique 'extra:<slug>' identifier, and truly droppable columns (no
        header name, beyond the recognised layout) stay 'skip'.
      - `extra_dims` is an ordered list of dicts {col, slug, label} for each
        carried extra column, where `col` is the matching entry in `names`.

    Role tokens come from `_tokenize_ascii_format` / `_autodetect_xyz_columns`.
    A column whose role is not reserved (see `_XYZ_RESERVED_ROLES`) is promoted
    to an extra dimension; its display name is taken from the file's header row
    when available, else a positional 'Column N' fallback. Slugs are
    sanitised and de-duplicated so two headers can't collide on disk.
    """
    roles = (_tokenize_ascii_format(ascii_format)
             if ascii_format
             else _autodetect_xyz_columns(str(source_path)))

    header_names = _read_ascii_header_names(str(source_path))

    names: List[str] = []
    extra_dims: List[dict] = []
    used_slugs: set[str] = set()
    for i, role in enumerate(roles):
        if role in _XYZ_RESERVED_ROLES and role != 'skip':
            names.append(role)
            continue
        # 'skip' and any unreserved role (timestamp, deviation, ...) are
        # candidate extra dimensions. Always carry them (user chose "all
        # numeric extras"); name from header when we have one.
        if header_names is not None and i < len(header_names) and header_names[i]:
            label = _humanize_extra_dim_label(header_names[i])
            base = _sanitize_extra_dim_name(header_names[i])
        else:
            label = f"Column {i + 1}"
            base = f"col_{i + 1}"
        slug = base
        n = 2
        while slug in used_slugs:
            suffix = f"_{n}"
            slug = base[:32 - len(suffix)] + suffix
            n += 1
        used_slugs.add(slug)
        col_id = f"extra:{slug}"
        names.append(col_id)
        extra_dims.append({"col": col_id, "slug": slug, "label": label})

    return names, extra_dims


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
    file_path: str, ascii_format: Optional[str]
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Parse an ASCII xyz-family file via pandas and return numpy arrays.

    Returns (positions[N,3] float32, colors[N,3] float32 | None,
    intensity[N] float32 | None). Separated from the response-packing step
    so the crop endpoint can reuse the loader and apply a boolean mask
    before responding.
    """
    columns = (_tokenize_ascii_format(ascii_format)
               if ascii_format
               else _autodetect_xyz_columns(file_path))

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
    file_path: str, ascii_format: Optional[str]
) -> tuple[np.ndarray, Optional[np.ndarray], Optional[np.ndarray]]:
    """Dispatch a path-based point-cloud load to the right backend by
    extension and return the raw numpy arrays. Shared entry point for the
    import and crop endpoints — keeps file-IO, format detection, and the
    PLY/PCD vs ASCII dispatch in one place.

    Raises HTTPException on missing file or unsupported extension.
    """
    import os

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower().lstrip('.')
    if ext in _PANDAS_EXTENSIONS:
        return _load_xyz_arrays(file_path, ascii_format)
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
    """
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
        request.file_path, request.ascii_format
    )
    return _pack_pointcloud_response(positions, colors, intensity)


class CropPointCloudByPathRequest(BaseModel):
    """Path-based AABB crop. Re-reads the cloud from disk (the renderer's
    `sourcePath`) via `_load_pointcloud_arrays`, applies an axis-aligned
    box filter with NumPy boolean indexing, and returns the surviving
    points in the same PHX1 binary format as `import_by_path`.

    Moving this work into the backend keeps multi-GB renderer-side typed
    arrays out of V8's 4 GB old-space — on a ~28 M-point scan with RGB
    and intensity, the renderer's in-JS apply path OOM'd at peak; numpy
    handles the same filter without that constraint.

    `translation` is baked into the loaded positions BEFORE the AABB test
    so `crop_min`/`crop_max` are always in the same world-space frame as
    the renderer's gizmo box. The renderer resets its editState
    translation after apply, matching the existing semantics.
    """
    file_path: str
    ascii_format: Optional[str] = None
    crop_min: List[float]
    crop_max: List[float]
    crop_invert: bool = False
    translation: Optional[List[float]] = None


@app.post("/api/pointcloud/crop_by_path")
async def crop_pointcloud_by_path(request: CropPointCloudByPathRequest):
    """Crop a point cloud via an axis-aligned box, returning the kept
    points in the standard PHX1 binary format.

    Box semantics match the renderer's in-JS implementation: a point at
    `(x + tx, y + ty, z + tz)` (after applying the optional translation)
    is kept when every component lies in `[crop_min, crop_max]`, or the
    complement of that when `crop_invert` is true.

    An empty result is a valid response (HTTP 200 with `point_count = 0`).
    The renderer raises a delete-confirmation in that case rather than
    erroring out.
    """
    if len(request.crop_min) != 3 or len(request.crop_max) != 3:
        raise HTTPException(
            status_code=400,
            detail="crop_min and crop_max must each be 3-element [x, y, z] arrays.",
        )
    if request.translation is not None and len(request.translation) != 3:
        raise HTTPException(
            status_code=400,
            detail="translation, if provided, must be a 3-element [x, y, z] array.",
        )

    positions, colors, intensity = _load_pointcloud_arrays(
        request.file_path, request.ascii_format
    )

    if request.translation is not None:
        offset = np.array(request.translation, dtype=np.float32)
        # Use out= to avoid materialising an intermediate copy on top of
        # `positions` (which can be hundreds of MB on big scans).
        positions = positions + offset

    cmin = np.array(request.crop_min, dtype=np.float32)
    cmax = np.array(request.crop_max, dtype=np.float32)
    # Vectorized AABB test. `all(axis=1)` collapses the per-component
    # inside/outside flags into one bool per point.
    inside = np.all((positions >= cmin) & (positions <= cmax), axis=1)
    if request.crop_invert:
        inside = ~inside

    positions = positions[inside]
    if colors is not None:
        colors = colors[inside]
    if intensity is not None:
        intensity = intensity[inside]

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


def _octree_cache_key(source_path: str, ascii_format: Optional[str]) -> str:
    """Stable cache key for (source file, format). Includes mtime so edits to the
    source XYZ invalidate the cached octree."""
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
    return h.hexdigest()


def _octree_cache_dir(source_path: str, ascii_format: Optional[str]) -> _Path:
    """Path where this (source, format) pair's octree lives. May not exist yet."""
    return _octree_cache_root() / _octree_cache_key(source_path, ascii_format)


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


def _xyz_to_las(source_path: _Path, ascii_format: Optional[str], out_las: _Path) -> tuple[int, List[dict]]:
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

    names, extra_dims = _xyz_column_plan(source_path, ascii_format)

    has_xyz = all(role in names for role in ("x", "y", "z"))
    if not has_xyz:
        raise HTTPException(
            status_code=400,
            detail=f"ASCII format must include x/y/z. Got columns: {names}",
        )

    has_rgb = all(role in names for role in ("r255", "g255", "b255"))
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
            usecols=[i for i, c in enumerate(names) if c != "skip"],
            comment="#",
            skiprows=skiprows,
            chunksize=chunk_rows,
            engine="c",
        )
        for chunk in reader:
            n = len(chunk)
            if n == 0:
                continue
            record = laspy.ScaleAwarePointRecord.zeros(n, header=header)
            record.x = chunk["x"].to_numpy(dtype=np.float64)
            record.y = chunk["y"].to_numpy(dtype=np.float64)
            record.z = chunk["z"].to_numpy(dtype=np.float64)
            if has_rgb:
                # Source RGB is 0-255; LAS RGB is uint16 (16-bit per channel).
                # Multiplying by 256 keeps perceptual brightness and lets the
                # renderer right-shift to recover the 8-bit value.
                record.red = chunk["r255"].to_numpy(dtype=np.uint16) * 256
                record.green = chunk["g255"].to_numpy(dtype=np.uint16) * 256
                record.blue = chunk["b255"].to_numpy(dtype=np.uint16) * 256
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


def _source_to_las(source_path: _Path, ascii_format: Optional[str], work_dir: _Path) -> tuple[_Path, bool, List[dict]]:
    """Get a LAS file path for `source_path`, converting from XYZ if needed.

    Returns (las_path, is_temp, extra_dims) — caller deletes the file if
    is_temp. `extra_dims` is the [{slug, label}, ...] list of carried scalar
    attributes (empty for LAS/LAZ sources, which we don't re-derive names for).
    """
    ext = source_path.suffix.lower().lstrip(".")
    if ext in ("las", "laz"):
        return source_path, False, []
    if ext in _PANDAS_EXTENSIONS:
        out = work_dir / (source_path.stem + ".las")
        _, extra_dims = _xyz_to_las(source_path, ascii_format, out)
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


class ConvertToOctreeRequest(BaseModel):
    """Request a Potree 2.0 octree build for a source point cloud.

    `source_path` may be an XYZ-family ASCII file (xyz/txt/csv/pts/asc) or
    a LAS/LAZ file. The result is cached at
    `_octree_cache_dir(source_path, ascii_format)` and re-served on
    subsequent calls without re-running the converter."""
    source_path: str
    ascii_format: Optional[str] = None


@app.post("/api/pointcloud/convert_to_octree")
async def convert_to_octree(request: ConvertToOctreeRequest):
    source_path = _Path(request.source_path).expanduser()
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail=f"Source file not found: {request.source_path}")

    cache_key = _octree_cache_key(str(source_path), request.ascii_format)
    cache_dir = _octree_cache_root() / cache_key

    cached = cache_dir / "metadata.json"
    if cached.is_file():
        meta = _read_octree_metadata(cache_dir)
        return {
            "cache_id": cache_key,
            "cache_dir": str(cache_dir),
            "cached": True,
            **meta,
        }

    # Build into a sibling temp dir, then atomically rename. Prevents a
    # partial directory from satisfying the cache check if the process
    # crashes mid-conversion.
    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = cache_dir.parent / (cache_key + ".staging")
    if staging_dir.exists():
        _shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    try:
        las_path, las_is_temp, extra_dims = _source_to_las(source_path, request.ascii_format, staging_dir)
        try:
            _run_potree_converter(las_path, staging_dir)
        finally:
            if las_is_temp:
                try:
                    las_path.unlink()
                except FileNotFoundError:
                    pass

        # Persist the slug→label sidecar into staging so it travels with the
        # atomic rename and survives subsequent cache hits.
        _write_octree_labels(staging_dir, extra_dims)

        if cache_dir.exists():
            _shutil.rmtree(cache_dir)
        staging_dir.rename(cache_dir)
    except Exception:
        # Best-effort cleanup; let the original exception propagate.
        try:
            _shutil.rmtree(staging_dir)
        except (FileNotFoundError, OSError):
            pass
        raise

    meta = _read_octree_metadata(cache_dir)

    # Trim oldest-accessed cache entries if we're over the cap. Never evicts
    # the entry we just created (it's the freshest by definition, but pass
    # it explicitly so an under-cap-but-near-cap state can't drop it).
    try:
        max_bytes = int(_os.environ.get(
            "PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES",
            _DEFAULT_OCTREE_CACHE_MAX_BYTES,
        ))
    except ValueError:
        max_bytes = _DEFAULT_OCTREE_CACHE_MAX_BYTES
    _evict_octree_cache(max_bytes, keep=cache_dir)

    return {
        "cache_id": cache_key,
        "cache_dir": str(cache_dir),
        "cached": False,
        **meta,
    }


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
    raise HTTPException(
        status_code=400,
        detail=f"region.kind must be 'box' or 'polygon'. Got: {kind!r}",
    )


def _canonical_scalar_filters(filters: Optional[List[dict]]) -> str:
    """Stable, order-independent string form of the scalar filters for cache
    keying. Sorted so [{a},{b}] and [{b},{a}] collide on purpose — filter
    order does not change which points survive. Empty/None → "" so a
    scalar-free crop keeps its prior cache identity."""
    if not filters:
        return ""
    parts = sorted(
        "{}:{:.9g}:{:.9g}".format(f["slug"], float(f["min"]), float(f["max"]))
        for f in filters
    )
    return "scalar|" + ";".join(parts)


def _crop_octree_cache_key(
    source_path: str,
    ascii_format: Optional[str],
    region: Optional[dict],
    scalar_filters: Optional[List[dict]],
    translation: Optional[List[float]],
    invert_all: bool = False,
) -> str:
    """Cache key for a crop_octree result.

    Folds the source-octree cache key (so source-file edits invalidate) with
    a canonical region + scalar filters + invert_all + translation. A second
    crop with identical params returns the same cache_id and reuses the prior
    octree byte-for-byte. A missing region hashes to "" — identical to the
    prior region-only keying for region-only requests. invert_all is folded in
    so the "kept" and "leftover" (segment) calls — identical except for that
    flag — don't collide on one cache dir.
    """
    base = _octree_cache_key(source_path, ascii_format)
    h = _hashlib.sha1()
    h.update(b"crop|")
    h.update(base.encode())
    h.update(b"\x00")
    h.update((_canonical_region(region) if region else "").encode())
    h.update(b"\x00")
    h.update(_canonical_scalar_filters(scalar_filters).encode())
    h.update(b"\x00")
    h.update(b"1" if invert_all else b"0")
    h.update(b"\x00")
    h.update(_canonical_translation(translation).encode())
    return h.hexdigest()


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
    """Box or polygon crop region for crop_octree. See _canonical_region for
    validation rules — the request handler delegates to that helper."""
    kind: str
    # Box fields
    min: Optional[List[float]] = None
    max: Optional[List[float]] = None
    # Polygon fields (screen-space, frozen camera matrices)
    points: Optional[List[List[float]]] = None
    projection: Optional[List[float]] = None
    view: Optional[List[float]] = None
    canvas: Optional[dict] = None
    invert: bool = False


class ScalarFilter(BaseModel):
    """Keep only points whose imported scalar attribute `slug` falls in the
    inclusive range [min, max]. `slug` is the on-disk extra-dimension name
    (matches a key in the octree's `attributeRanges` / the `extra_dims` slugs
    produced by `_xyz_column_plan`)."""
    slug: str
    min: float
    max: float


class CropOctreeRequest(BaseModel):
    """Re-convert a source point cloud into a Potree 2.0 octree after
    applying a crop region and/or scalar-attribute filters (and optional
    translation).

    Behavior contract:
      - Always operates on `source_path` (the immutable XYZ/LAS source),
        never on a previously-cached octree. Crops compose by stacking
        successive backend calls.
      - `region` is optional. When omitted, no spatial crop is applied and
        only `scalar_filters` (if any) constrain the survivors. The filter
        tool sends scalar-only requests this way.
      - `scalar_filters` are AND-combined with each other and with the
        spatial region. The spatial `invert` flips only the spatial mask;
        scalar filters are never inverted.
      - `invert_all` inverts the ENTIRE combined mask (spatial AND scalars)
        as the final step — the true complement of the kept set. The filter
        tool's "Segment" action uses this to produce the leftover (out-of-
        range) cloud: kept + leftover == the original, with nothing lost or
        duplicated, regardless of how many filters are active. (The complement
        of an AND is an OR, which per-filter inversion cannot express — hence a
        single top-level flag.)
      - `translation` is baked into positions BEFORE the region test,
        matching the renderer's gizmo semantics.
      - Cache key folds (source mtime, ascii_format, region, scalar_filters,
        invert_all, translation). Identical requests return the same cache_id
        byte-for-byte.
      - Empty result (no points survive the filter) → HTTP 200 with
        `point_count = 0` and `cached = False`. The renderer raises a
        delete-confirmation rather than 4xx-ing on this.
    """
    source_path: str
    ascii_format: Optional[str] = None
    region: Optional[CropOctreeRegion] = None
    scalar_filters: Optional[List[ScalarFilter]] = None
    invert_all: bool = False
    translation: Optional[List[float]] = None


def _filtered_xyz_to_las(
    source_path: _Path,
    ascii_format: Optional[str],
    out_las: _Path,
    region: Optional[dict],
    translation: Optional[List[float]],
    scalar_filters: Optional[List[dict]] = None,
    invert_all: bool = False,
) -> tuple[int, List[dict]]:
    """Streaming variant of `_xyz_to_las` that applies a per-chunk filter mask
    before writing each chunk to LAS. Same chunk-size memory bound; total
    points written = sum of survivors across chunks.

    The mask is the AND of:
      - the spatial region (box or polygon), or all-True when `region` is
        None. The region's `invert` flips only this spatial portion.
      - each scalar filter: `min <= attribute <= max`, resolved from the
        source column carrying that extra-dimension slug.

    When `invert_all` is set, the final combined mask is complemented as the
    last step — yielding exactly the points the un-inverted call would drop.
    Used by the filter tool's "Segment" action for the leftover cloud.

    For polygon regions, projects each chunk's (x,y,z) through the frozen
    camera matrices once per chunk; the mask is computed in NumPy so the
    cost is bounded by chunk_rows × num_polygon_vertices.

    Carries unmapped numeric columns as LAS extra dimensions exactly like
    `_xyz_to_las`, so a cropped octree keeps its scalar attributes. Returns
    (total_kept, extra_dims).
    """
    import laspy

    names, extra_dims = _xyz_column_plan(source_path, ascii_format)

    has_xyz = all(role in names for role in ("x", "y", "z"))
    if not has_xyz:
        raise HTTPException(
            status_code=400,
            detail=f"ASCII format must include x/y/z. Got columns: {names}",
        )
    has_rgb = all(role in names for role in ("r255", "g255", "b255"))
    intensity_role = next((r for r in ("intensity", "reflectance") if r in names), None)

    # Resolve scalar filters to source columns up-front so a bad slug fails
    # fast (rather than silently keeping all points). The slug is the
    # extra-dimension name surfaced to the renderer as an octree attribute.
    slug_to_col = {ed["slug"]: ed["col"] for ed in extra_dims}
    resolved_scalar_filters: List[tuple] = []
    for f in (scalar_filters or []):
        col = slug_to_col.get(f["slug"])
        if col is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown scalar attribute: {f['slug']!r}. "
                    f"Available: {sorted(slug_to_col)}"
                ),
            )
        resolved_scalar_filters.append((col, float(f["min"]), float(f["max"])))

    # Precompute region inputs once. region is None → no spatial crop.
    kind = region["kind"] if region else None
    invert = bool(region.get("invert", False)) if region else False
    if kind == "box":
        cmin = np.array(region["min"], dtype=np.float64)
        cmax = np.array(region["max"], dtype=np.float64)
    elif kind == "polygon":
        proj = np.array(region["projection"], dtype=np.float64)
        view = np.array(region["view"], dtype=np.float64)
        canvas = region["canvas"]
        canvas_w = int(canvas["width"])
        canvas_h = int(canvas["height"])
        polygon = np.array(region["points"], dtype=np.float64)
        if polygon.ndim != 2 or polygon.shape[1] != 2 or polygon.shape[0] < 3:
            raise HTTPException(
                status_code=400,
                detail="region.points must be at least 3 [x, y] entries.",
            )
    elif kind is not None:
        raise HTTPException(status_code=400, detail=f"Unknown region.kind: {kind!r}")

    tx, ty, tz = 0.0, 0.0, 0.0
    if translation is not None:
        tx = float(translation[0])
        ty = float(translation[1])
        tz = float(translation[2])

    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))

    skiprows = 1 if _first_data_row_has_letters(str(source_path)) else 0

    chunk_rows = 2_000_000
    total_kept = 0
    # Track the actual extent of the kept points so we can write a header
    # bounding box that PotreeConverter will accept. laspy's auto-computed
    # header bbox can be one quantisation step too tight: at scale=0.001,
    # a point landing exactly on the crop boundary (e.g. z=0.7) round-trips
    # through the LAS reader as z=0.7000000000000001, which then sits one ULP
    # outside the header's stated max. PotreeConverter refuses to ingest
    # files where any point falls outside the declared bbox, so we pad the
    # bbox we write by one full scale step (1 mm) on every axis.
    data_min = np.array([np.inf, np.inf, np.inf], dtype=np.float64)
    data_max = np.array([-np.inf, -np.inf, -np.inf], dtype=np.float64)

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        reader = pd.read_csv(
            source_path,
            sep=r"\s+",
            header=None,
            names=names,
            usecols=[i for i, c in enumerate(names) if c != "skip"],
            comment="#",
            skiprows=skiprows,
            chunksize=chunk_rows,
            engine="c",
        )
        for chunk in reader:
            n = len(chunk)
            if n == 0:
                continue
            xs = chunk["x"].to_numpy(dtype=np.float64) + tx
            ys = chunk["y"].to_numpy(dtype=np.float64) + ty
            zs = chunk["z"].to_numpy(dtype=np.float64) + tz

            if kind == "box":
                mask = (
                    (xs >= cmin[0]) & (xs <= cmax[0]) &
                    (ys >= cmin[1]) & (ys <= cmax[1]) &
                    (zs >= cmin[2]) & (zs <= cmax[2])
                )
            elif kind == "polygon":
                positions = np.stack([xs, ys, zs], axis=1)
                pixels = _project_world_to_pixel(
                    positions, proj, view, canvas_w, canvas_h,
                )
                mask = _points_in_polygon_mask(pixels, polygon)
            else:
                # No spatial region — keep all points spatially, then let the
                # scalar filters below narrow the survivor set.
                mask = np.ones(n, dtype=bool)

            if invert:
                mask = ~mask

            # AND in each scalar filter after the spatial invert, so invert
            # never flips the scalar constraints. Source extra dims are float32
            # on disk (see add_extra_dim below), so filter on float32 values to
            # keep survivors consistent with what gets written.
            for col, lo, hi in resolved_scalar_filters:
                vals = chunk[col].to_numpy(dtype=np.float32)
                mask &= (vals >= lo) & (vals <= hi)

            # Complement the entire combined mask last — the true leftover set.
            if invert_all:
                mask = ~mask

            kept = int(mask.sum())
            if kept == 0:
                continue

            kept_xs = xs[mask]
            kept_ys = ys[mask]
            kept_zs = zs[mask]

            data_min[0] = min(data_min[0], float(kept_xs.min()))
            data_min[1] = min(data_min[1], float(kept_ys.min()))
            data_min[2] = min(data_min[2], float(kept_zs.min()))
            data_max[0] = max(data_max[0], float(kept_xs.max()))
            data_max[1] = max(data_max[1], float(kept_ys.max()))
            data_max[2] = max(data_max[2], float(kept_zs.max()))

            record = laspy.ScaleAwarePointRecord.zeros(kept, header=header)
            record.x = kept_xs
            record.y = kept_ys
            record.z = kept_zs
            if has_rgb:
                r = chunk["r255"].to_numpy(dtype=np.uint16)[mask] * 256
                g = chunk["g255"].to_numpy(dtype=np.uint16)[mask] * 256
                b = chunk["b255"].to_numpy(dtype=np.uint16)[mask] * 256
                record.red = r
                record.green = g
                record.blue = b
            if intensity_role is not None:
                refl = chunk[intensity_role].to_numpy(dtype=np.float32)[mask]
                record.intensity = np.clip(refl * 256.0, 0, 65535).astype(np.uint16)
            for ed in extra_dims:
                record[ed["slug"]] = chunk[ed["col"]].to_numpy(dtype=np.float32)[mask]
            writer.write_points(record)
            total_kept += kept

        # Explicitly set the header bbox before the writer closes. Pad by
        # one scale step on every axis so points sitting exactly on the
        # crop boundary survive PotreeConverter's strict bbox check (see
        # comment above).
        if total_kept > 0:
            pad = 0.001  # matches header.scales above
            writer.header.mins = (data_min - pad).tolist()
            writer.header.maxs = (data_max + pad).tolist()

    return total_kept, [{"slug": ed["slug"], "label": ed["label"]} for ed in extra_dims]


@app.post("/api/pointcloud/crop_octree")
async def crop_octree(request: CropOctreeRequest):
    """Re-convert a source cloud into a new octree with a crop applied.

    Why a fresh re-conversion rather than masking the streamed LOD nodes:
    Potree 2.0 nodes are poisson-disk-sampled per level, so a render-time
    mask only hides points — it cannot produce a correct full-resolution
    cropped octree. Re-running PotreeConverter on the filtered source XYZ
    is the only correct full-res apply, and the chunked filter keeps peak
    backend memory bounded regardless of source size.
    """
    source_path = _Path(request.source_path).expanduser()
    if not source_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Source file not found: {request.source_path}",
        )

    # Validate region shape up-front (the helper raises on malformed input);
    # also produces the canonical string for cache keying. region is optional
    # — a scalar-only filter request omits it.
    region_dict = request.region.model_dump() if request.region else None
    if region_dict is not None:
        _canonical_region(region_dict)  # raises 400 on bad shape
    scalar_filter_dicts = (
        [f.model_dump() for f in request.scalar_filters]
        if request.scalar_filters else None
    )
    if region_dict is None and not scalar_filter_dicts:
        raise HTTPException(
            status_code=400,
            detail="crop_octree requires at least one of `region` or `scalar_filters`.",
        )
    _canonical_translation(request.translation)  # raises 400 on bad length

    cache_key = _crop_octree_cache_key(
        str(source_path), request.ascii_format, region_dict,
        scalar_filter_dicts, request.translation, request.invert_all,
    )
    cache_dir = _octree_cache_root() / cache_key

    cached = cache_dir / "metadata.json"
    if cached.is_file():
        meta = _read_octree_metadata(cache_dir)
        return {
            "cache_id": cache_key,
            "cache_dir": str(cache_dir),
            "cached": True,
            **meta,
        }

    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = cache_dir.parent / (cache_key + ".staging")
    if staging_dir.exists():
        _shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    try:
        ext = source_path.suffix.lower().lstrip(".")
        if ext in ("las", "laz"):
            # Source is already LAS/LAZ. We still need to apply the mask,
            # which means reading the LAS into NumPy and writing a filtered
            # LAS. Defer support for this branch — the renderer routes
            # LAS/LAZ through the flat path today; M3 only needs XYZ.
            raise HTTPException(
                status_code=400,
                detail="crop_octree currently supports XYZ-family sources only.",
            )
        if ext not in _PANDAS_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported source extension for crop_octree: .{ext}",
            )

        filtered_las = staging_dir / (source_path.stem + ".cropped.las")
        kept, extra_dims = _filtered_xyz_to_las(
            source_path, request.ascii_format, filtered_las,
            region_dict, request.translation, scalar_filter_dicts,
            request.invert_all,
        )

        if kept == 0:
            # Empty crop — drop the staging dir and report 0 points without
            # creating a cache entry (it would be a directory with just an
            # empty LAS file and no metadata.json).
            _shutil.rmtree(staging_dir)
            return {
                "cache_id": None,
                "cache_dir": None,
                "cached": False,
                "version": "2.0",
                "point_count": 0,
                "spacing": 0.0,
                "scale": [1.0, 1.0, 1.0],
                "offset": [0.0, 0.0, 0.0],
                "bounds": {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]},
                "tight_bounds": {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]},
                "attributes": [],
            }

        try:
            _run_potree_converter(filtered_las, staging_dir)
        finally:
            try:
                filtered_las.unlink()
            except FileNotFoundError:
                pass

        # Persist the slug→label sidecar so the cropped octree keeps clean
        # scalar picker labels (mirrors convert_to_octree).
        _write_octree_labels(staging_dir, extra_dims)

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

    try:
        max_bytes = int(_os.environ.get(
            "PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES",
            _DEFAULT_OCTREE_CACHE_MAX_BYTES,
        ))
    except ValueError:
        max_bytes = _DEFAULT_OCTREE_CACHE_MAX_BYTES
    _evict_octree_cache(max_bytes, keep=cache_dir)

    return {
        "cache_id": cache_key,
        "cache_dir": str(cache_dir),
        "cached": False,
        **meta,
    }


class SegmentGroundApplyRequest(BaseModel):
    """Re-convert a source cloud into a new octree carrying a `ground_class`
    scalar attribute (1=ground, 2=plant) computed by CSF.

    Mirrors crop_octree's "derive points → write LAS with extra dims →
    PotreeConverter → new octree ref" flow, but instead of masking points it
    adds one extra dimension. CSF parameters are folded into the cache key so
    re-running with the same params returns the cached octree byte-for-byte.
    """
    source_path: str
    ascii_format: Optional[str] = None
    cloth_resolution: float = 0.05
    rigidness: int = 3
    class_threshold: float = 0.02
    iterations: int = 500
    slope_smooth: bool = False
    # When set (1=ground, 2=plant), keep ONLY points of that class — producing a
    # split sub-cloud octree. None = classify in place (keep all points, add the
    # ground_class attribute). Used by the "Split into ground + plant clouds" UI.
    keep_class: Optional[int] = None


# The on-disk slug / human label for the ground-classification scalar attribute.
GROUND_CLASS_SLUG = "ground_class"
GROUND_CLASS_LABEL = "Ground Class"


def _segment_octree_cache_key(
    source_path: str, ascii_format: Optional[str], csf_params: dict,
    keep_class: Optional[int],
) -> str:
    """Cache key for a segment-apply result. Folds the source-octree key (so
    source edits invalidate) with the canonical CSF parameter set and the
    optional class filter."""
    base = _octree_cache_key(source_path, ascii_format)
    h = _hashlib.sha1()
    h.update(b"segment_ground|")
    h.update(base.encode())
    h.update(b"\x00")
    # Stable ordering of params for a deterministic key.
    for k in sorted(csf_params):
        h.update(f"{k}={csf_params[k]}".encode())
        h.update(b"\x00")
    h.update(f"keep={keep_class}".encode())
    return h.hexdigest()


def _segmented_xyz_to_las(
    source_path: _Path,
    ascii_format: Optional[str],
    out_las: _Path,
    csf_params: dict,
    keep_class: Optional[int] = None,
) -> tuple[int, List[dict]]:
    """Load a full XYZ-family cloud, run CSF, and write a LAS carrying every
    source scalar PLUS a `ground_class` extra dimension.

    Unlike `_xyz_to_las` this is NOT chunked: CSF needs the whole cloud in
    memory at once, and the per-point labels must align to the points written.
    Returns (total_points, extra_dims) where extra_dims includes the carried
    source scalars and the appended ground_class entry.
    """
    import laspy

    names, extra_dims = _xyz_column_plan(source_path, ascii_format)

    has_xyz = all(role in names for role in ("x", "y", "z"))
    if not has_xyz:
        raise HTTPException(
            status_code=400,
            detail=f"ASCII format must include x/y/z. Got columns: {names}",
        )
    has_rgb = all(role in names for role in ("r255", "g255", "b255"))
    intensity_role = next((r for r in ("intensity", "reflectance") if r in names), None)

    skiprows = 1 if _first_data_row_has_letters(str(source_path)) else 0
    df = pd.read_csv(
        source_path,
        sep=r"\s+",
        header=None,
        names=names,
        usecols=[i for i, c in enumerate(names) if c != "skip"],
        comment="#",
        skiprows=skiprows,
        engine="c",
    )

    n = len(df)
    if n < 10:
        raise HTTPException(
            status_code=400,
            detail="Need at least 10 points for ground segmentation.",
        )

    xyz = np.column_stack([
        df["x"].to_numpy(dtype=np.float64),
        df["y"].to_numpy(dtype=np.float64),
        df["z"].to_numpy(dtype=np.float64),
    ])

    try:
        labels = segment_ground(xyz, **csf_params)
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="CSF (cloth-simulation-filter) not installed. Run: pip install cloth-simulation-filter",
        )

    # Optional class filter for the split workflow: keep only points of one
    # class. Mask everything (positions, scalars, labels) together so they stay
    # aligned.
    if keep_class is not None:
        mask = labels == keep_class
        if not mask.any():
            raise HTTPException(
                status_code=400,
                detail=f"No points classified as class {keep_class}.",
            )
        df = df[mask].reset_index(drop=True)
        xyz = xyz[mask]
        labels = labels[mask]

    n_out = len(xyz)
    header = laspy.LasHeader(point_format=3, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001], dtype=np.float64)
    header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    for ed in extra_dims:
        header.add_extra_dim(laspy.ExtraBytesParams(name=ed["slug"], type=np.float32))
    # Append the computed ground-classification dimension.
    header.add_extra_dim(laspy.ExtraBytesParams(name=GROUND_CLASS_SLUG, type=np.float32))

    record = laspy.ScaleAwarePointRecord.zeros(n_out, header=header)
    record.x = xyz[:, 0]
    record.y = xyz[:, 1]
    record.z = xyz[:, 2]
    if has_rgb:
        record.red = df["r255"].to_numpy(dtype=np.uint16) * 256
        record.green = df["g255"].to_numpy(dtype=np.uint16) * 256
        record.blue = df["b255"].to_numpy(dtype=np.uint16) * 256
    if intensity_role is not None:
        refl = df[intensity_role].to_numpy(dtype=np.float32)
        record.intensity = np.clip(refl * 256.0, 0, 65535).astype(np.uint16)
    for ed in extra_dims:
        record[ed["slug"]] = df[ed["col"]].to_numpy(dtype=np.float32)
    record[GROUND_CLASS_SLUG] = labels.astype(np.float32)

    with laspy.open(str(out_las), mode="w", header=header) as writer:
        writer.write_points(record)
        # Pad the bbox by one scale step so boundary points survive
        # PotreeConverter's strict bbox check (see _filtered_xyz_to_las).
        pad = 0.001
        writer.header.mins = (xyz.min(axis=0) - pad).tolist()
        writer.header.maxs = (xyz.max(axis=0) + pad).tolist()

    carried = [{"slug": ed["slug"], "label": ed["label"]} for ed in extra_dims]
    carried.append({"slug": GROUND_CLASS_SLUG, "label": GROUND_CLASS_LABEL})
    return n_out, carried


@app.post("/api/segment/ground/apply")
async def segment_ground_apply(request: SegmentGroundApplyRequest):
    """Segment the source cloud and re-convert it to a new octree carrying a
    `ground_class` scalar attribute the renderer can colour by.

    Returns the same octree-ref shape as convert_to_octree / crop_octree
    (cache_id + metadata + attributes), so the renderer swaps the cloud's
    OctreeRef to the returned one.
    """
    source_path = _Path(request.source_path).expanduser()
    if not source_path.is_file():
        raise HTTPException(
            status_code=404, detail=f"Source file not found: {request.source_path}",
        )

    ext = source_path.suffix.lower().lstrip(".")
    if ext not in _PANDAS_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"segment_ground/apply currently supports XYZ-family sources only (got .{ext}).",
        )

    csf_params = {
        "cloth_resolution": request.cloth_resolution,
        "rigidness": request.rigidness,
        "class_threshold": request.class_threshold,
        "iterations": request.iterations,
        "slope_smooth": request.slope_smooth,
    }

    if request.keep_class is not None and request.keep_class not in (
        GROUND_CLASS_GROUND, GROUND_CLASS_PLANT,
    ):
        raise HTTPException(
            status_code=400,
            detail=f"keep_class must be {GROUND_CLASS_GROUND} (ground) or {GROUND_CLASS_PLANT} (plant).",
        )

    cache_key = _segment_octree_cache_key(
        str(source_path), request.ascii_format, csf_params, request.keep_class,
    )
    cache_dir = _octree_cache_root() / cache_key

    cached = cache_dir / "metadata.json"
    if cached.is_file():
        meta = _read_octree_metadata(cache_dir)
        return {"cache_id": cache_key, "cache_dir": str(cache_dir), "cached": True, **meta}

    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = cache_dir.parent / (cache_key + ".staging")
    if staging_dir.exists():
        _shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    try:
        seg_las = staging_dir / (source_path.stem + ".segmented.las")
        # carried = source scalars + the appended ground_class entry.
        _, carried = _segmented_xyz_to_las(
            source_path, request.ascii_format, seg_las, csf_params, request.keep_class,
        )
        try:
            _run_potree_converter(seg_las, staging_dir)
        finally:
            try:
                seg_las.unlink()
            except FileNotFoundError:
                pass

        # Persist labels for ALL carried dims (source scalars + ground_class);
        # _write_octree_labels overwrites the sidecar, so pass the full set.
        _write_octree_labels(staging_dir, carried)

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

    try:
        max_bytes = int(_os.environ.get(
            "PHYTOGRAPH_OCTREE_CACHE_MAX_BYTES",
            _DEFAULT_OCTREE_CACHE_MAX_BYTES,
        ))
    except ValueError:
        max_bytes = _DEFAULT_OCTREE_CACHE_MAX_BYTES
    _evict_octree_cache(max_bytes, keep=cache_dir)

    return {"cache_id": cache_key, "cache_dir": str(cache_dir), "cached": False, **meta}


@app.get("/api/pointcloud/octree_metadata")
async def get_octree_metadata(cache_id: str):
    """Read metadata for a previously-converted octree by cache id.

    The renderer calls this once when constructing an OctreePointCloud
    primitive to learn the bounds / point count / attribute layout. The
    actual hierarchy.bin and octree.bin are streamed by the renderer
    through the Electron main-process `app://octree/<cache_id>/...`
    protocol, not through this server.
    """
    # Disallow path traversal; cache ids are sha1 hex.
    if not all(c in "0123456789abcdef" for c in cache_id) or len(cache_id) != 40:
        raise HTTPException(status_code=400, detail="cache_id must be a sha1 hex string")

    cache_dir = _octree_cache_root() / cache_id
    if not cache_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Octree cache miss: {cache_id}")

    meta = _read_octree_metadata(cache_dir)
    return {
        "cache_id": cache_id,
        "cache_dir": str(cache_dir),
        **meta,
    }


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
