#!/usr/bin/env python3
"""
Video content analyzer — VAKOG predicates + narrative structure.

Reads JSON output from web-intel scraper (youtube content_type) and produces
a structured analysis: VAKOG distribution (global + temporal), phase detection,
and technique signals.

Usage:
    uv run python scripts/analyze.py <scraper_output.json>
    cat scraper_output.json | uv run python scripts/analyze.py -

Output: JSON with vakog, phases, techniques, and metadata.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import defaultdict


# ---------------------------------------------------------------------------
# VAKOG predicate dictionaries (FR + EN)
# ---------------------------------------------------------------------------

PREDICATES: dict[str, dict[str, list[str]]] = {
    'V': {
        'fr': [
            'voir', 'vois', 'voit', 'voyez', 'voyons', 'vu',
            'regarde', 'regarder', 'regardez', 'regardons',
            'image', 'images', 'tableau', 'tableaux',
            'clair', 'claire', 'clairement', 'flou', 'floue',
            'lumineux', 'sombre', 'obscur',
            'perspective', 'vision', 'visuel', 'visuelle',
            'brille', 'brillant', 'eclaire', 'eclairage',
            'illustre', 'illustrer', 'montre', 'montrer',
            'apparait', 'apparaitre', 'visible', 'invisible',
            'revele', 'reveler', 'observe', 'observer',
            'apercoi', 'apercevoir',
            'couleur', 'couleurs', 'forme', 'formes',
            'reflet', 'miroir', 'horizon', 'panorama',
            'focus', 'net', 'nette', 'opaque', 'transparent',
            'aveugle', 'yeux', 'regard', 'scene',
            'spectacle', 'carte', 'cartographie',
            'dessine', 'portrait', 'ombre', 'lumiere',
            'projecteur', 'loupe', 'survole',
            'rives', 'voici', 'eclat',
        ],
        'en': [
            'see', 'saw', 'seen', 'seeing',
            'look', 'looking', 'looked',
            'watch', 'watching', 'watched',
            'view', 'viewing', 'viewed',
            'image', 'images', 'picture', 'pictures',
            'clear', 'clearly', 'foggy', 'hazy', 'blurry',
            'bright', 'dark', 'dim', 'glow', 'glowing',
            'perspective', 'vision', 'visual',
            'shine', 'shining', 'illuminate', 'illuminating',
            'illustrate', 'show', 'showing', 'shown',
            'appear', 'appearing', 'visible', 'invisible',
            'reveal', 'revealing', 'observe', 'observing',
            'color', 'colour', 'shape', 'form',
            'reflect', 'reflection', 'mirror', 'horizon',
            'focus', 'focused', 'sharp', 'opaque', 'transparent',
            'blind', 'eyes', 'gaze', 'scene',
            'map', 'portrait', 'shadow', 'light',
            'spotlight', 'overview', 'envision',
        ],
    },
    'A': {
        'fr': [
            'entend', 'entendre', 'entends', 'entendu',
            'ecoute', 'ecouter', 'ecoutez',
            'parle', 'parler', 'parlez', 'parlons',
            'bruit', 'bruits', 'silence', 'silencieux',
            'resonne', 'resonner', 'resonance',
            'harmonie', 'harmonieux', 'dissonance',
            'discours', 'dialogue',
            'annonce', 'annoncer', 'proclame',
            'crie', 'crier', 'hurle', 'hurler',
            'murmure', 'murmurer', 'chuchote',
            'echo', 'rythme', 'melodie', 'tonalite',
            'accord', 'accorder',
            'question', 'questionner',
            'appel', 'appelle', 'appeler',
            'voix', 'vocal', 'sonore',
        ],
        'en': [
            'hear', 'heard', 'hearing',
            'listen', 'listening', 'listened',
            'sound', 'sounds', 'sounding',
            'noise', 'noisy', 'silence', 'silent', 'quietly',
            'resonate', 'resonating', 'resonance',
            'harmony', 'harmonious', 'dissonance',
            'speech', 'dialogue', 'discuss', 'discussion',
            'announce', 'proclaim',
            'shout', 'shouting', 'scream', 'screaming',
            'whisper', 'whispering', 'murmur',
            'echo', 'rhythm', 'melody', 'tone', 'tune',
            'voice', 'vocal',
            'question', 'ask', 'asking', 'call', 'calling',
        ],
    },
    'K': {
        'fr': [
            'sent', 'sentir', 'sensation', 'ressent', 'ressentir',
            'touche', 'toucher',
            'pression', 'lourd', 'lourde', 'leger', 'legere',
            'tendu', 'tension', 'tendre',
            'chaud', 'chaude', 'chaleur', 'froid', 'froide',
            'brule', 'bruler', 'brulant', 'incendie', 'incinere', 'incinerer',
            'frappe', 'frapper', 'choc', 'impact', 'percute',
            'saisir', 'saisi', 'agripper',
            'poussee', 'pousser', 'propulse', 'propulseur', 'propulsion',
            'explose', 'explosion', 'explosif',
            'effondre', 'effondrement',
            'ecrase', 'ecraser', 'ecrasant', 'ecrasante',
            'machoire', 'visceral', 'visceralement',
            'accro', 'accroche', 'accrocher',
            'asphyxie', 'asphyxier', 'etouffe', 'etouffer',
            'referme', 'refermer', 'enferme', 'enfermer', 'verrouille', 'verrouiller',
            'tombe', 'tomber', 'chute',
            'desintegre', 'desintegrer',
            'souffre', 'souffrir', 'souffrance', 'douleur',
            'poids', 'pesant',
            'ancre', 'ancrer', 'enracine',
            'solide', 'fragile', 'brise', 'briser', 'casse', 'casser',
            'dechire', 'dechirer',
            'friction', 'frottement',
            'gratte', 'gratter', 'epluche', 'eplucher',
            'glisse', 'glisser', 'derape',
            'electrochoc', 'saute', 'sauter', 'sautent',
            'greffe', 'greffer', 'infiltre', 'infiltrer',
            'aspire', 'aspirer', 'devore', 'devorer',
            'absorbe', 'absorber',
            'nourri', 'nourrir', 'nourrit', 'affame',
            'piege', 'pieger',
            'etreinte', 'serre', 'serrer',
            'trembler', 'vibrer', 'vibration',
            'chirurgical', 'chirurgicale',
        ],
        'en': [
            'feel', 'feeling', 'felt',
            'touch', 'touching', 'touched',
            'pressure', 'heavy', 'light', 'lightweight',
            'tense', 'tension', 'tight',
            'hot', 'warm', 'heat', 'cold', 'cool', 'chill',
            'burn', 'burning', 'burned', 'incinerate',
            'hit', 'hitting', 'strike', 'striking', 'shock', 'impact',
            'grab', 'grasp', 'grip', 'seize',
            'push', 'pushing', 'thrust', 'propel',
            'explode', 'explosion', 'explosive', 'blast',
            'collapse', 'collapsing',
            'crush', 'crushing', 'overwhelming',
            'jaw', 'visceral', 'gut',
            'hooked', 'addicted', 'addiction',
            'suffocate', 'suffocating', 'choke', 'choking',
            'trap', 'trapped', 'lock', 'locked',
            'fall', 'falling', 'drop', 'crash',
            'disintegrate', 'shatter',
            'suffer', 'suffering', 'pain', 'painful',
            'weight', 'anchor', 'anchored', 'rooted',
            'solid', 'fragile', 'break', 'broken',
            'tear', 'tearing', 'friction',
            'scratch', 'scrape', 'peel',
            'slip', 'slide', 'skid',
            'jolt', 'jump', 'leap',
            'graft', 'infiltrate', 'infiltrating',
            'absorb', 'absorbing', 'devour', 'devouring',
            'feed', 'feeding', 'starve',
            'squeeze', 'tremble', 'vibrate',
            'surgical',
        ],
    },
    'Ad': {
        'fr': [
            'comprend', 'comprendre', 'compris',
            'pense', 'penser', 'pensez',
            'logique', 'logiquement',
            'analyse', 'analyser', 'analytique',
            'processus', 'procedure',
            'structure', 'structurer', 'structurel', 'structurelle',
            'concept', 'conceptuel',
            'theorie', 'theorique',
            'strategie', 'strategique',
            'mecanisme', 'mecanique',
            'systeme', 'systematique',
            'modele', 'modeliser',
            'schema', 'schematise',
            'pattern',
            'calcul', 'calculer',
            'mesure', 'mesurer',
            'evaluer', 'evaluation',
            'ratio', 'proportion',
            'metrique', 'metriques',
            'donnee', 'donnees',
            'chiffre', 'chiffres',
            'statistique', 'statistiques',
            'formule', 'formuler',
            'definit', 'definir', 'definition',
            'classifie', 'classifier', 'categorie',
            'hierarchie', 'hierarchique',
            'decode', 'decoder',
            'diagnostic', 'diagnostiquer',
            'audit', 'auditer',
            'inventaire',
            'axiome',
            'raisonne', 'raisonner', 'raisonnement',
        ],
        'en': [
            'understand', 'understanding', 'understood',
            'think', 'thinking', 'thought',
            'logic', 'logical', 'logically',
            'analyze', 'analysing', 'analysis', 'analytical',
            'process', 'procedure',
            'structure', 'structural', 'structured',
            'concept', 'conceptual',
            'theory', 'theoretical',
            'strategy', 'strategic', 'strategically',
            'mechanism', 'mechanical',
            'system', 'systematic', 'systematically',
            'model', 'modeling',
            'schema', 'pattern',
            'calculate', 'calculation',
            'measure', 'measurement',
            'evaluate', 'evaluation',
            'ratio', 'proportion',
            'metric', 'metrics',
            'data', 'dataset',
            'figure', 'figures', 'number', 'numbers',
            'statistic', 'statistics', 'statistical',
            'formula', 'formulate',
            'define', 'definition',
            'classify', 'category', 'categorize',
            'hierarchy', 'hierarchical',
            'decode', 'decoding',
            'diagnose', 'diagnostic',
            'audit', 'auditing',
            'inventory',
            'axiom',
            'reason', 'reasoning',
        ],
    },
}

SYSTEM_LABELS = {
    'V': 'Visuel / Visual',
    'A': 'Auditif / Auditory',
    'K': 'Kinesthesique / Kinesthetic',
    'Ad': 'Auditif digital / Digital',
}


def _normalize(text: str) -> str:
    """Strip accents and lowercase."""
    nfkd = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in nfkd if not unicodedata.category(c).startswith('M')).lower()


def _detect_language(text: str) -> str:
    """Simple heuristic to detect fr vs en."""
    fr_markers = ['le ', 'la ', 'les ', 'des ', 'est ', 'une ', 'que ', "c'est", "l'", "d'"]
    en_markers = ['the ', ' is ', ' are ', ' was ', ' this ', ' that ', ' with ', "it's"]
    text_lower = text[:2000].lower()
    fr_count = sum(text_lower.count(m) for m in fr_markers)
    en_count = sum(text_lower.count(m) for m in en_markers)
    return 'fr' if fr_count >= en_count else 'en'


def _parse_segments(text_with_ts: str) -> list[tuple[str, str, int]]:
    """Parse timestamped transcript into (timestamp, text, seconds) tuples."""
    segments = []
    pattern = r'\[(\d+:\d+)\]\s*(.*?)(?=\[\d+:\d+\]|\Z)'
    for m in re.finditer(pattern, text_with_ts, re.DOTALL):
        ts = m.group(1)
        text = m.group(2).strip().replace('\n', ' ')
        parts = ts.split(':')
        seconds = int(parts[0]) * 60 + int(parts[1])
        segments.append((ts, text, seconds))
    return segments


def _build_predicate_set(lang: str) -> dict[str, list[str]]:
    """Build normalized predicate lists for the given language."""
    result = {}
    for system, lang_dict in PREDICATES.items():
        preds = lang_dict.get(lang, [])
        # Also include the other language as fallback (loanwords, mixed content)
        other_lang = 'en' if lang == 'fr' else 'fr'
        all_preds = list(preds) + lang_dict.get(other_lang, [])
        result[system] = [_normalize(p) for p in all_preds]
    return result


def _analyze_vakog(
    segments: list[tuple[str, str, int]],
    predicate_set: dict[str, list[str]],
) -> dict:
    """Compute VAKOG distribution (global + temporal blocks)."""
    system_counts: dict[str, int] = defaultdict(int)
    system_examples: dict[str, list[dict]] = defaultdict(list)
    segment_systems: list[tuple[str, str, int, list[str]]] = []

    for ts, text, sec in segments:
        text_norm = _normalize(text)
        found = []
        for system, preds in predicate_set.items():
            for pred in preds:
                if pred in text_norm:
                    system_counts[system] += 1
                    found.append(system)
                    if len(system_examples[system]) < 10:
                        idx = text_norm.find(pred)
                        start = max(0, idx - 40)
                        end = min(len(text), idx + len(pred) + 40)
                        system_examples[system].append({
                            'timestamp': ts,
                            'seconds': sec,
                            'snippet': text[start:end].strip(),
                            'predicate': pred,
                        })
                    break  # one match per system per segment
        segment_systems.append((ts, text, sec, found))

    # Global distribution
    total = sum(system_counts.values()) or 1
    global_dist = {}
    for sys_key in ['V', 'A', 'K', 'Ad']:
        count = system_counts.get(sys_key, 0)
        global_dist[sys_key] = {
            'count': count,
            'percent': round(count / total * 100, 1),
            'label': SYSTEM_LABELS[sys_key],
        }

    # Signature string (e.g. "Ad42-K27-V19-A12")
    sorted_sys = sorted(global_dist.items(), key=lambda x: -x[1]['percent'])
    signature = '-'.join(
        f"{k}{int(v['percent'])}" for k, v in sorted_sys
    )

    # Temporal blocks (4-minute blocks)
    block_size = 240
    duration = segments[-1][2] if segments else 0
    temporal_blocks = []
    blocks: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for ts, text, sec, systems in segment_systems:
        block_start = (sec // block_size) * block_size
        for sys_key in systems:
            blocks[block_start][sys_key] += 1

    for block_start in sorted(blocks.keys()):
        block_total = sum(blocks[block_start].values()) or 1
        block_data = {
            'start_sec': block_start,
            'end_sec': min(block_start + block_size, duration),
            'start_ts': f"{block_start // 60:02d}:{block_start % 60:02d}",
            'end_ts': f"{min(block_start + block_size, duration) // 60:02d}:{min(block_start + block_size, duration) % 60:02d}",
            'distribution': {},
            'dominant': '',
        }
        max_count = 0
        for sys_key in ['V', 'A', 'K', 'Ad']:
            count = blocks[block_start].get(sys_key, 0)
            pct = round(count / block_total * 100, 1)
            block_data['distribution'][sys_key] = {
                'count': count,
                'percent': pct,
            }
            if count > max_count:
                max_count = count
                block_data['dominant'] = sys_key
        temporal_blocks.append(block_data)

    # Detect choreography pattern
    choreography = _detect_choreography(temporal_blocks)

    return {
        'global_distribution': global_dist,
        'signature': signature,
        'temporal_blocks': temporal_blocks,
        'choreography': choreography,
        'examples': {k: v for k, v in system_examples.items()},
        'total_tagged_segments': sum(system_counts.values()),
        'total_segments': len(segments),
    }


def _detect_choreography(blocks: list[dict]) -> dict:
    """Detect the VAKOG choreography pattern (e.g. K->Ad->K)."""
    if not blocks:
        return {'pattern': 'unknown', 'phases': []}

    n = len(blocks)
    phases = []

    # Hook = first ~15% of blocks
    hook_end = max(1, n // 6)
    body_end = max(hook_end + 1, n - n // 6)

    hook_blocks = blocks[:hook_end]
    body_blocks = blocks[hook_end:body_end]
    close_blocks = blocks[body_end:]

    def dominant_of(block_list):
        totals = defaultdict(int)
        for b in block_list:
            for sys_key, data in b['distribution'].items():
                totals[sys_key] += data['count']
        if not totals:
            return '?'
        return max(totals, key=lambda k: totals[k])

    hook_dom = dominant_of(hook_blocks) if hook_blocks else '?'
    body_dom = dominant_of(body_blocks) if body_blocks else '?'
    close_dom = dominant_of(close_blocks) if close_blocks else '?'

    # Detect V spikes in body (blocks where V is dominant or >25%)
    v_spikes = []
    for b in body_blocks:
        v_pct = b['distribution'].get('V', {}).get('percent', 0)
        if v_pct >= 25 or b['dominant'] == 'V':
            v_spikes.append(b['start_ts'])

    pattern_str = f"{hook_dom}->{body_dom}->{close_dom}"

    return {
        'pattern': pattern_str,
        'hook_dominant': hook_dom,
        'body_dominant': body_dom,
        'close_dominant': close_dom,
        'visual_spikes': v_spikes,
        'phases': [
            {'name': 'hook', 'dominant': hook_dom,
             'start': hook_blocks[0]['start_ts'] if hook_blocks else '00:00',
             'end': hook_blocks[-1]['end_ts'] if hook_blocks else '00:00'},
            {'name': 'body', 'dominant': body_dom,
             'start': body_blocks[0]['start_ts'] if body_blocks else '00:00',
             'end': body_blocks[-1]['end_ts'] if body_blocks else '00:00'},
            {'name': 'close', 'dominant': close_dom,
             'start': close_blocks[0]['start_ts'] if close_blocks else '00:00',
             'end': close_blocks[-1]['end_ts'] if close_blocks else '00:00'},
        ],
    }


def _detect_techniques(transcript: str, segments: list[tuple[str, str, int]]) -> list[dict]:
    """Detect content creation techniques from the transcript."""
    transcript_norm = _normalize(transcript)
    techniques = []

    # 1. Metaphor from outside domain (opening)
    opening_text = ' '.join(text for _, text, sec in segments if sec < 60)
    # If the opening talks about something clearly unrelated then pivots
    if segments and len(segments) > 10:
        opening_norm = _normalize(opening_text)
        # Check for domain-external words in first 30s
        external_markers = [
            'navette', 'spatiale', 'fusee', 'ocean', 'montagne', 'guerre',
            'shuttle', 'rocket', 'ocean', 'mountain', 'war', 'battlefield',
            'chess', 'echecs', 'sport', 'cuisine', 'nature', 'animal',
            'biologie', 'physique', 'chimie', 'medecine',
        ]
        for marker in external_markers:
            if _normalize(marker) in opening_norm:
                techniques.append({
                    'id': 'metaphor_external',
                    'name': 'Metaphore hors-domaine / External metaphor',
                    'confidence': 'high',
                    'location': 'opening',
                    'evidence': opening_text[:200],
                })
                break

    # 2. Stat-shock cascade (numbers that escalate)
    numbers = re.findall(r'(\d[\d\s]*(?:millions?|milliards?|billions?|dollars?|\$|%|euros?))', transcript_norm)
    if len(numbers) >= 3:
        techniques.append({
            'id': 'stat_shock_cascade',
            'name': 'Stat-choc en cascade / Stat-shock cascade',
            'confidence': 'high' if len(numbers) >= 5 else 'medium',
            'location': 'throughout',
            'evidence': f"{len(numbers)} numeric claims found",
        })

    # 3. Branded concept (repeated unique phrases)
    # Look for phrases that appear 3+ times and seem coined
    words_3plus = defaultdict(int)
    for _, text, _ in segments:
        # Look for 2-3 word phrases
        text_words = _normalize(text).split()
        for i in range(len(text_words) - 1):
            bigram = f"{text_words[i]} {text_words[i+1]}"
            words_3plus[bigram] += 1
    repeated_phrases = {k: v for k, v in words_3plus.items() if v >= 3 and len(k) > 10}
    if repeated_phrases:
        top = sorted(repeated_phrases.items(), key=lambda x: -x[1])[:5]
        techniques.append({
            'id': 'branded_concept',
            'name': 'Concept proprietaire brande / Branded concept',
            'confidence': 'medium',
            'location': 'throughout',
            'evidence': ', '.join(f'"{k}" ({v}x)' for k, v in top),
        })

    # 4. Audience segmentation ("si vous etes X")
    seg_patterns = [
        r'si vous (?:etes|dirigez|investissez|construisez|travaillez)',
        r'if you (?:are|manage|invest|build|work)',
        r'pour (?:les|un|une) (?:dirigeant|investisseur|developpeur|entrepreneur)',
        r'for (?:managers|investors|developers|entrepreneurs)',
    ]
    seg_count = 0
    for pat in seg_patterns:
        seg_count += len(re.findall(pat, transcript_norm))
    if seg_count >= 2:
        techniques.append({
            'id': 'audience_segmentation',
            'name': 'Segmentation audience / Audience segmentation',
            'confidence': 'high' if seg_count >= 3 else 'medium',
            'location': 'close',
            'evidence': f"{seg_count} audience-targeted segments",
        })

    # 5. Callback to previous content
    callback_patterns = [
        r'(?:ma |mon |une |la )(?:video|analyse|episode) (?:precedente?|sur )',
        r'(?:previous|earlier|last) (?:video|analysis|episode)',
        r"(?:j'ai|j'avais) (?:decrit|explique|montre|demontre) dans",
        r'as i (?:described|explained|showed) in',
    ]
    cb_count = sum(len(re.findall(p, transcript_norm)) for p in callback_patterns)
    if cb_count >= 1:
        techniques.append({
            'id': 'callback_lore',
            'name': 'Callback inter-videos / Cross-video callbacks',
            'confidence': 'high' if cb_count >= 2 else 'medium',
            'location': 'body',
            'evidence': f"{cb_count} references to previous content",
        })

    # 6. Military/body lexical field
    military = [
        'guerre', 'bataille', 'combat', 'front', 'assaut', 'offensive',
        'defensi', 'attaque', 'strateg', 'tactique', 'ennemi', 'adversaire',
        'predateur', 'proie', 'assassin', 'arme', 'munition', 'blindage',
        'war', 'battle', 'combat', 'front', 'assault', 'offensive',
        'defensive', 'attack', 'enemy', 'adversary',
        'predator', 'prey', 'assassin', 'weapon', 'armor',
    ]
    mil_count = sum(1 for m in military if _normalize(m) in transcript_norm)
    if mil_count >= 3:
        techniques.append({
            'id': 'military_lexical_field',
            'name': 'Champ lexical militaire / Military lexical field',
            'confidence': 'high' if mil_count >= 5 else 'medium',
            'location': 'throughout',
            'evidence': f"{mil_count} military/combat terms detected",
        })

    # 7. Integrated CTA (not interrupting)
    cta_patterns = [
        r'(?:formation|patreon|lien|description|abonnez|inscrivez)',
        r'(?:training|course|subscribe|link|description|sign up)',
    ]
    cta_count = sum(len(re.findall(p, transcript_norm)) for p in cta_patterns)
    if cta_count >= 1:
        techniques.append({
            'id': 'integrated_cta',
            'name': 'CTA integre au narratif / Narrative-integrated CTA',
            'confidence': 'medium',
            'location': 'close',
            'evidence': f"{cta_count} CTA signals",
        })

    # 8. Funnel structure (specific -> general -> specific)
    # Heuristic: check if named entities concentrate at start and end
    techniques.append({
        'id': 'funnel_structure',
        'name': 'Structure entonnoir / Funnel structure',
        'confidence': 'low',
        'location': 'throughout',
        'evidence': 'Requires Claude interpretation of narrative arc',
    })

    return techniques


def analyze(scraper_json: dict) -> dict:
    """Main analysis entry point."""
    if not scraper_json.get('success'):
        return {
            'success': False,
            'error': scraper_json.get('error', 'Scraper returned failure'),
        }

    data = scraper_json['data']
    content_type = scraper_json.get('content_type', 'unknown')

    if content_type != 'youtube':
        return {
            'success': False,
            'error': f"Expected youtube content, got '{content_type}'. "
                     'This analyzer is designed for YouTube video transcripts.',
        }

    if not data.get('has_transcript'):
        return {
            'success': False,
            'error': 'No transcript available for this video.',
        }

    text_with_ts = data.get('text', '')
    transcript_text = data.get('transcript_text', '') or text_with_ts
    segments = _parse_segments(text_with_ts)

    if not segments:
        return {
            'success': False,
            'error': 'Could not parse timestamped segments from transcript.',
        }

    # Detect language
    lang = _detect_language(transcript_text)

    # Build predicate set (primary language first, other as fallback)
    predicate_set = _build_predicate_set(lang)

    # Run analyses
    vakog = _analyze_vakog(segments, predicate_set)
    techniques = _detect_techniques(transcript_text, segments)

    # Video metadata
    duration_sec = data.get('duration_seconds', 0)
    if not duration_sec and segments:
        duration_sec = segments[-1][2]

    metadata = {
        'title': data.get('title', 'Unknown'),
        'author': data.get('author', 'Unknown'),
        'duration_seconds': duration_sec,
        'duration_formatted': f"{duration_sec // 60:02d}:{duration_sec % 60:02d}",
        'language': lang,
        'segments_count': len(segments),
        'transcript_length': len(transcript_text),
    }

    return {
        'success': True,
        'metadata': metadata,
        'vakog': vakog,
        'techniques': techniques,
    }


def main():
    """CLI entry point."""
    if len(sys.argv) < 2:
        print('Usage: python analyze.py <scraper_output.json|->',
              file=sys.stderr)
        sys.exit(1)

    source = sys.argv[1]
    if source == '-':
        scraper_json = json.load(sys.stdin)
    else:
        with open(source) as f:
            scraper_json = json.load(f)

    result = analyze(scraper_json)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
