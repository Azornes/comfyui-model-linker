"""
Model Sources Module

Provides search functionality for finding models from various sources.
"""

from ..log_system.log_funcs import log_debug, log_info, log_warn, log_error, log_exception

from .popular import search_popular_models, get_popular_model_url
from .model_list import search_model_list, search_model_list_multiple
from .huggingface import (
    search_huggingface,
    search_huggingface_for_file,
    get_huggingface_download_url,
)
from .civitai import search_civitai, search_civitai_for_file, get_civitai_download_url

__all__ = [
    "search_popular_models",
    "get_popular_model_url",
    "search_model_list",
    "search_model_list_multiple",
    "search_huggingface",
    "search_huggingface_for_file",
    "get_huggingface_download_url",
    "search_civitai",
    "search_civitai_for_file",
    "get_civitai_download_url",
]
