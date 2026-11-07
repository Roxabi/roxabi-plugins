# Changelog

## 0.17.0

- Use scoped, authenticated reviewed-head authorization for Kit merge-on-green instead of treating the `reviewed` label as authority. Withdrawals fence stop, review-start and protected-push paths; native auto-merge retains its existing protected-auto mode.
- Include the MIT-licensed Kit head-authorization core and its provenance with the plugin distribution. Configure the repository, operator, CI App and bot identities before using the Kit gate; see the [landing safeguards](README.md#existing-review-and-landing-safeguards).
- Run the head-authorization CLI and watcher Bun subprocesses with installed trusted Bun and compiler configuration and automatic `.env` loading disabled, even when the target repository is the working directory.
