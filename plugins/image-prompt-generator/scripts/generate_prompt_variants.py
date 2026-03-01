#!/usr/bin/env python3
"""Generate image prompt variants from a base concept.

Usage:
    python generate_prompt_variants.py --concept "a mountain landscape at sunset"
    python generate_prompt_variants.py --concept "a mountain landscape at sunset" --charter path/to/visual-charter.json
    python generate_prompt_variants.py --concept "a mountain landscape at sunset" --count 8
"""
import argparse
import json
import sys
from pathlib import Path

# Allow imports from _lib/
sys.path.insert(0, str(Path(__file__).parent))
from _lib.paths import get_vault_home


STYLES = [
    {
        'name': 'Cinematic Photography',
        'category': 'photography',
        'template': '{subject}, cinematic photography, {lighting}, shot on 35mm film, shallow depth of field, {mood}, {colors}',
        'default_lighting': 'golden hour lighting',
        'default_mood': 'dramatic atmosphere',
    },
    {
        'name': 'Editorial Portrait',
        'category': 'photography',
        'template': '{subject}, editorial photography, {lighting}, clean composition, {mood}, high fashion aesthetic, {colors}',
        'default_lighting': 'studio lighting with soft shadows',
        'default_mood': 'polished and refined',
    },
    {
        'name': 'Flat Illustration',
        'category': 'illustration',
        'template': '{subject}, flat design illustration, bold shapes, clean lines, {colors}, {mood}, vector style, minimal detail',
        'default_lighting': 'flat lighting',
        'default_mood': 'modern and approachable',
    },
    {
        'name': 'Watercolor Painting',
        'category': 'art',
        'template': '{subject}, watercolor painting, soft edges, organic textures, {colors}, {mood}, {lighting}, paper texture visible',
        'default_lighting': 'diffused natural light',
        'default_mood': 'gentle and ethereal',
    },
    {
        'name': '3D Render',
        'category': 'rendering',
        'template': '{subject}, 3D render, ray-traced, {lighting}, {colors}, {mood}, octane render, high detail, 8K resolution',
        'default_lighting': 'volumetric lighting',
        'default_mood': 'sleek and futuristic',
    },
    {
        'name': 'Minimalist Digital Art',
        'category': 'digital',
        'template': '{subject}, minimalist digital art, geometric shapes, negative space, {colors}, {mood}, {lighting}, clean background',
        'default_lighting': 'soft ambient light',
        'default_mood': 'calm and focused',
    },
    {
        'name': 'Street Photography',
        'category': 'photography',
        'template': '{subject}, street photography, candid feel, {lighting}, {mood}, urban environment, grain, {colors}',
        'default_lighting': 'natural available light',
        'default_mood': 'raw and authentic',
    },
    {
        'name': 'Isometric Illustration',
        'category': 'illustration',
        'template': '{subject}, isometric illustration, 30-degree angle, {colors}, {mood}, detailed scene, pixel-perfect edges, {lighting}',
        'default_lighting': 'even top-down lighting',
        'default_mood': 'playful and detailed',
    },
]


def load_charter(charter_path):
    """Load visual charter from file path or default location."""
    if charter_path:
        path = Path(charter_path)
    else:
        path = get_vault_home() / 'config' / 'visual-charter.json'

    if not path.exists():
        return None

    with open(path) as f:
        return json.load(f)


def apply_charter(variant, charter):
    """Apply brand identity to a prompt variant."""
    if not charter:
        return variant

    colors = charter.get('colors', {})
    style = charter.get('style', {})
    prefs = charter.get('preferences', {})

    color_str = ', '.join(f'{k}: {v}' for k, v in colors.items() if k != 'background')
    variant['colors'] = f'brand palette ({color_str})'
    variant['mood'] = style.get('mood', variant['mood'])

    avoid = prefs.get('avoid', [])
    if avoid:
        variant['negative'] = ', '.join(avoid)

    prefer = prefs.get('prefer', [])
    if prefer:
        variant['prompt'] += ', ' + ', '.join(prefer)

    variant['brand_alignment'] = 'on-brand'
    return variant


def generate_variants(concept, charter=None, count=6):
    """Generate prompt variants for a concept."""
    variants = []
    selected_styles = STYLES[:count]

    for i, style in enumerate(selected_styles):
        lighting = style['default_lighting']
        mood = style['default_mood']
        colors = 'harmonious color palette'

        prompt = style['template'].format(
            subject=concept,
            lighting=lighting,
            mood=mood,
            colors=colors,
        )

        variant = {
            'index': i + 1,
            'style': style['name'],
            'category': style['category'],
            'prompt': prompt,
            'lighting': lighting,
            'mood': mood,
            'colors': colors,
            'brand_alignment': 'no-charter',
        }

        if charter:
            variant = apply_charter(variant, charter)

        variants.append(variant)

    return variants


def main():
    parser = argparse.ArgumentParser(description='Generate image prompt variants from a base concept.')
    parser.add_argument('--concept', required=True, help='Base concept for image generation')
    parser.add_argument('--charter', default=None, help='Path to visual-charter.json (optional)')
    parser.add_argument('--count', type=int, default=6, help='Number of variants to generate (default: 6)')
    args = parser.parse_args()

    charter = load_charter(args.charter)
    count = min(args.count, len(STYLES))
    variants = generate_variants(args.concept, charter=charter, count=count)

    output = {
        'concept': args.concept,
        'charter_loaded': charter is not None,
        'brand_name': charter.get('brand_name', None) if charter else None,
        'count': len(variants),
        'variants': variants,
    }

    json.dump(output, sys.stdout, indent=2)
    print()


if __name__ == '__main__':
    main()
