from .avatar import AvatarTemplate
from .logo import LogoTemplate
from .voice import VoiceTemplate
from .color_palette import ColorPaletteTemplate
from .ui_component import UIComponentTemplate
from .icon_set import IconSetTemplate
from .motion_curve import MotionCurveTemplate

TEMPLATES = {
    "avatar": AvatarTemplate,
    "logo": LogoTemplate,
    "voice": VoiceTemplate,
    "color-palette": ColorPaletteTemplate,
    "ui-component": UIComponentTemplate,
    "icon-set": IconSetTemplate,
    "motion-curve": MotionCurveTemplate,
}


def get_template(name: str):
    cls = TEMPLATES.get(name)
    if not cls:
        raise ValueError(f"Unknown template: {name}. Available: {list(TEMPLATES)}")
    return cls()
