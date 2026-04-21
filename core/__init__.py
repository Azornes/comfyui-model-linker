"""
Core modules for Model Linker extension.

Modules:
- linker: Main API for analyzing and resolving missing models
- scanner: Directory scanning for available models
- matcher: Fuzzy matching for finding similar models
- workflow_analyzer: Workflow JSON parsing
- workflow_updater: Workflow modification
- downloader: Model downloading with progress tracking
- sources: Search integrations (HuggingFace, CivitAI, popular models)
"""

from .log_system.log_funcs import log_debug, log_info, log_warn, log_error, log_exception
from .log_system.logger import logger
from .linker import analyze_and_find_matches, apply_resolution
from .scanner import get_model_files
from .matcher import find_matches


__all__ = [
    "analyze_and_find_matches",
    "apply_resolution",
    "get_model_files",
    "find_matches",
    "logger",
    "log_debug",
    "log_info",
    "log_warn",
    "log_error",
    "log_exception",
]
