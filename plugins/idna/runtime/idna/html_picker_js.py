"""JavaScript for the IDNA picker — assembled from render and actions modules."""

from .html_picker_js_render import PICKER_JS_RENDER
from .html_picker_js_actions import PICKER_JS_ACTIONS

PICKER_JS = PICKER_JS_RENDER + PICKER_JS_ACTIONS
