"""Picker page HTML — assembled from CSS and JS modules."""

from __future__ import annotations

from .html_picker_css import PICKER_CSS
from .html_picker_js import PICKER_JS

PICKER_HTML = f"""<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IDNA \u2014 Picker</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>{PICKER_CSS}</style>
</head>
<body>
<div class="layout" id="app">
  <div class="header">
    <div>
      <a class="back" href="/">\u2190 all sessions</a>
      <div class="project" id="proj-label">IDNA</div>
      <div class="title" id="title">Loading\u2026</div>
      <div class="subtitle" id="subtitle"></div>
    </div>
    <div class="hdr-btns">
      <div class="size-ctrl">
        <button class="size-btn" onclick="resizeCards(-40)">\u2212</button>
        <span class="size-label" id="sizeLabel">220</span>
        <button class="size-btn" onclick="resizeCards(+40)">+</button>
      </div>
      <button class="back-btn" id="back-btn" onclick="goBack()" disabled>\u2190 Back</button>
      <button class="theme-btn" onclick="toggleTheme()">&#9728; / &#9790;</button>
      <div class="menu-wrap" id="menu-wrap">
        <button class="menu-btn" onclick="toggleMenu()" title="Session options">\u22ef</button>
        <div class="menu-dropdown" id="menu-dropdown">
          <div class="menu-confirm" id="menu-confirm">
            <div class="menu-confirm-msg" id="menu-confirm-msg"></div>
            <div class="menu-confirm-btns">
              <button class="menu-confirm-cancel" onclick="closeMenu()">Cancel</button>
              <button class="menu-confirm-ok" id="menu-confirm-ok">Confirm</button>
            </div>
          </div>
          <button class="menu-item" onclick="menuAction('reset')">Reset to round 0</button>
          <button class="menu-item danger" onclick="menuAction('delete')">Delete session</button>
        </div>
      </div>
    </div>
  </div>
  <div class="error-bar" id="error-bar"></div>
  <div id="main-content"></div>
</div>
<script>{PICKER_JS}</script>
</body>
</html>"""
