"""
@author: Azornes
@title: AzLogs
@version: 1.4.0
@description: Logging Setup - Central logging system

Features:
- Different log levels (DEBUG, INFO, WARN, ERROR)
- Ability to enable/disable logs globally or per module
- Colored logs in console
- Log file rotation
- Configuration via environment variables
"""

import os
import sys
import json
import logging
import datetime
from enum import IntEnum
from logging.handlers import RotatingFileHandler
import traceback


# Log levels
class LogLevel(IntEnum):
    DEBUG = 10
    INFO = 20
    WARN = 30
    ERROR = 40
    NONE = 100


# Level mapping
LEVEL_MAP = {
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.WARN: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
    LogLevel.NONE: logging.CRITICAL + 1,
}

# ANSI colors for different log levels
COLORS = {
    LogLevel.DEBUG: "\033[90m",  # Gray
    LogLevel.INFO: "\033[94m",  # Blue
    LogLevel.WARN: "\033[93m",  # Yellow
    LogLevel.ERROR: "\033[91m",  # Red
    "RESET": "\033[0m",  # Reset
}

# Default configuration
DEFAULT_CONFIG = {
    "global_level": LogLevel.INFO,
    "module_settings": {},
    "use_colors": True,
    "log_to_file": False,
    "log_dir": "logs",
    "max_file_size_mb": 10,
    "backup_count": 5,
    "timestamp_format": "%H:%M:%S",
}


class ColoredFormatter(logging.Formatter):
    """Formatter that adds colors to console logs"""

    def __init__(self, fmt=None, datefmt=None, use_colors=True):
        super().__init__(fmt, datefmt)
        self.use_colors = use_colors

    def format(self, record):
        # Get the formatted message from the record
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + self.formatException(record.exc_info)

        levelname = record.levelname

        # Build the log prefix
        prefix = "[{}] [{}] [{}]".format(
            self.formatTime(record, self.datefmt), record.name, record.levelname
        )

        # Apply color and bold styling to the prefix
        if self.use_colors and hasattr(LogLevel, levelname):
            level_enum = getattr(LogLevel, levelname)
            if level_enum in COLORS:
                # Apply bold (\033[1m) and color, then reset
                prefix = f"\033[1m{COLORS[level_enum]}{prefix}{COLORS['RESET']}"

        return f"{prefix} {message}"


class AzLogsLogger:
    """Main logger class for AzLogs"""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(AzLogsLogger, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.config = DEFAULT_CONFIG.copy()
        self.enabled = True
        self.loggers = {}

        # Load configuration from environment variables
        self._load_config_from_env()

        self._initialized = True

    def _load_config_from_env(self):
        """Load configuration from environment variables"""

        # Global level
        if "AZLOGS_LOG_LEVEL" in os.environ:
            level_name = os.environ["AZLOGS_LOG_LEVEL"].upper()
            if hasattr(LogLevel, level_name):
                self.config["global_level"] = getattr(LogLevel, level_name)

        # Module settings
        if "AZLOGS_MODULE_LEVELS" in os.environ:
            try:
                module_settings = json.loads(os.environ["AZLOGS_MODULE_LEVELS"])
                for module, level_name in module_settings.items():
                    if hasattr(LogLevel, level_name.upper()):
                        self.config["module_settings"][module] = getattr(
                            LogLevel, level_name.upper()
                        )
            except json.JSONDecodeError:
                pass

        # Other settings
        if "AZLOGS_USE_COLORS" in os.environ:
            self.config["use_colors"] = (
                os.environ["AZLOGS_USE_COLORS"].lower() == "true"
            )

        if "AZLOGS_LOG_TO_FILE" in os.environ:
            self.config["log_to_file"] = (
                os.environ["AZLOGS_LOG_TO_FILE"].lower() == "true"
            )

        if "AZLOGS_LOG_DIR" in os.environ:
            self.config["log_dir"] = os.environ["AZLOGS_LOG_DIR"]

        if "AZLOGS_MAX_FILE_SIZE_MB" in os.environ:
            try:
                self.config["max_file_size_mb"] = int(
                    os.environ["AZLOGS_MAX_FILE_SIZE_MB"]
                )
            except ValueError:
                pass

        if "AZLOGS_BACKUP_COUNT" in os.environ:
            try:
                self.config["backup_count"] = int(os.environ["AZLOGS_BACKUP_COUNT"])
            except ValueError:
                pass

    def configure(self, config):
        """Configure the logger"""
        self.config.update(config)

        # If file logging is enabled, ensure the directory exists
        if self.config.get("log_to_file") and self.config.get("log_dir"):
            try:
                os.makedirs(self.config["log_dir"], exist_ok=True)
            except OSError as e:
                # This is a critical situation, so use print
                print(
                    f"[CRITICAL] Could not create log directory: {self.config['log_dir']}. Error: {e}"
                )
                traceback.print_exc()
                # Disable file logging to avoid further errors
                self.config["log_to_file"] = False

        return self

    def set_enabled(self, enabled):
        """Enable/disable the logger globally"""
        self.enabled = enabled
        return self

    def set_global_level(self, level):
        """Set global logging level"""
        self.config["global_level"] = level
        return self

    def set_module_level(self, module, level):
        """Set logging level for a specific module"""
        self.config["module_settings"][module] = level
        return self

    def is_level_enabled(self, module, level):
        """Check if a given logging level is active for the module"""
        if not self.enabled:
            return False

        # Determine effective logging level, considering module and global settings
        effective_level = self.config["module_settings"].get(
            module, self.config["global_level"]
        )

        # If effective level is NONE, logging is completely disabled
        if effective_level == LogLevel.NONE:
            return False

        # Otherwise check if log level is high enough
        return level >= effective_level

    def _get_logger(self, module):
        """Get or create a logger for the module"""
        if module in self.loggers:
            return self.loggers[module]

        # Create new logger
        logger = logging.getLogger(f"azlogs.{module}")
        logger.setLevel(logging.DEBUG)  # Set lowest level, filtering will be done later
        logger.propagate = False

        # Add console handler
        console_handler = logging.StreamHandler(sys.stdout)
        console_formatter = ColoredFormatter(
            fmt="[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s",
            datefmt=self.config["timestamp_format"],
            use_colors=self.config["use_colors"],
        )
        console_handler.setFormatter(console_formatter)
        logger.addHandler(console_handler)

        # Add file handler if file logging is enabled
        if self.config["log_to_file"]:
            log_file = os.path.join(self.config["log_dir"], f"azlogs_{module}.log")
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=self.config["max_file_size_mb"] * 1024 * 1024,
                backupCount=self.config["backup_count"],
                encoding="utf-8",
            )
            file_formatter = logging.Formatter(
                fmt="[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            file_handler.setFormatter(file_formatter)
            logger.addHandler(file_handler)

        self.loggers[module] = logger
        return logger

    def log(self, module, level, *args, **kwargs):
        """Write log"""
        if not self.is_level_enabled(module, level):
            return

        logger = self._get_logger(module)

        # Convert arguments to string
        message = " ".join(str(arg) for arg in args)

        # Add exception info if provided
        exc_info = kwargs.get("exc_info", None)

        # Map LogLevel to logging level
        log_level = LEVEL_MAP.get(level, logging.INFO)

        # Write log
        logger.log(log_level, message, exc_info=exc_info)

    def debug(self, module, *args, **kwargs):
        """Log at DEBUG level"""
        self.log(module, LogLevel.DEBUG, *args, **kwargs)

    def info(self, module, *args, **kwargs):
        """Log at INFO level"""
        self.log(module, LogLevel.INFO, *args, **kwargs)

    def warn(self, module, *args, **kwargs):
        """Log at WARN level"""
        self.log(module, LogLevel.WARN, *args, **kwargs)

    def error(self, module, *args, **kwargs):
        """Log at ERROR level"""
        self.log(module, LogLevel.ERROR, *args, **kwargs)

    def exception(self, module, *args):
        """Log exception at ERROR level"""
        self.log(module, LogLevel.ERROR, *args, exc_info=True)


# Singleton
logger = AzLogsLogger()


# Helper functions
def debug(module, *args, **kwargs):
    """Log at DEBUG level"""
    logger.log(module, LogLevel.DEBUG, *args, **kwargs)


def info(module, *args, **kwargs):
    """Log at INFO level"""
    logger.log(module, LogLevel.INFO, *args, **kwargs)


def warn(module, *args, **kwargs):
    """Log at WARN level"""
    logger.log(module, LogLevel.WARN, *args, **kwargs)


def error(module, *args, **kwargs):
    """Log at ERROR level"""
    logger.log(module, LogLevel.ERROR, *args, **kwargs)


def exception(module, *args):
    """Log exception at ERROR level"""
    logger.log(module, LogLevel.ERROR, *args, exc_info=True)


# Function to quickly enable/disable debugging
def set_debug(enabled=True):
    """Enable/disable debugging globally"""
    if enabled:
        logger.set_global_level(LogLevel.DEBUG)
    else:
        logger.set_global_level(LogLevel.INFO)
    return logger


# Function to enable/disable file logging
def set_file_logging(enabled=True, log_dir=None):
    """Enable/disable logging to file"""
    logger.config["log_to_file"] = enabled
    if log_dir:
        logger.config["log_dir"] = log_dir
        os.makedirs(log_dir, exist_ok=True)

    # Reset loggers to apply new settings
    logger.loggers = {}
    return logger
