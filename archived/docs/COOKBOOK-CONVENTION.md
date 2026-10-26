# Cookbook Convention

The retained plugin catalog has no shared cookbook or playbook runtime capability.

| Material | Current location |
|---|---|
| Skill-specific reference | Adjacent to the skill that consumes it, under `skills/<skill>/references/` |
| Plugin-specific cookbook | Inside that plugin, when the plugin documents and consumes it |
| Historical playbook | [`archived/playbooks/`](../archived/playbooks/) |

Active instructions must link only to maintained plugin source or documentation. Historical
playbooks are evidence and reference material, not current plugin capabilities or runtime inputs.
See the [archive index](../archived/README.md) for their classification.
