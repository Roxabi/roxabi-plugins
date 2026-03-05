"""Image-prompt-generator exception hierarchy."""
# TODO(#20): Consolidate into roxabi_sdk.exceptions when Phase 5 SDK extraction lands


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class ImagePromptError(PluginError):
    """Base exception for image-prompt-generator plugin."""


class ConfigError(ImagePromptError):
    """Configuration validation error."""
