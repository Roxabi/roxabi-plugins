"""CV exception hierarchy."""
# TODO(#20): Consolidate into roxabi_sdk.exceptions when Phase 5 SDK extraction lands


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class CVError(PluginError):
    """Base exception for CV plugin."""


class ConfigError(CVError):
    """Configuration validation error."""


class TemplateError(CVError):
    """Template rendering error."""


class DataError(CVError):
    """CV data validation error."""
