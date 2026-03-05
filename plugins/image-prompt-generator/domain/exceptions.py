"""Image-prompt-generator exception hierarchy."""


class PluginError(Exception):
    """Base exception for all Roxabi plugin errors."""


class ImagePromptError(PluginError):
    """Base exception for image-prompt-generator plugin."""


class ConfigError(ImagePromptError):
    """Configuration validation error."""
