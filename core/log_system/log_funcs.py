"""
@author: Azornes
@title: AzLogs
@version: 1.4.0
@description: Logging Initializator
"""

import os
import traceback

try:
    from .logger import logger, LogLevel, debug, info, warn, error, exception
    from .config import LOG_LEVEL, LOG_MODULE_NAME

    _module_name = (
        LOG_MODULE_NAME
        if LOG_MODULE_NAME is not None
        else os.path.basename(os.path.dirname(os.path.abspath(__file__)))
    )

    logger.set_module_level(_module_name, LogLevel[LOG_LEVEL])

    logger.configure(
        {
            "log_to_file": True,
            "log_dir": os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"),
        }
    )

    _initialized = True
except ImportError:
    _initialized = False


def log_debug(*args, **kwargs):
    if _initialized:
        debug(_module_name, *args, **kwargs)
    else:
        print("[DEBUG]", *args)


def log_info(*args, **kwargs):
    if _initialized:
        info(_module_name, *args, **kwargs)
    else:
        print("[INFO]", *args)


def log_warn(*args, **kwargs):
    if _initialized:
        warn(_module_name, *args, **kwargs)
    else:
        print("[WARN]", *args)


def log_error(*args, **kwargs):
    if _initialized:
        error(_module_name, *args, **kwargs)
    else:
        print("[ERROR]", *args)


def log_exception(*args):
    if _initialized:
        exception(_module_name, *args)
    else:
        print("[ERROR]", *args)
        traceback.print_exc()
