# Data Management

Retained plugins use GitHub records and Git for their workflow facts; they do not require a local
vault. `issue-triage` operates on GitHub issues and relations. `omp-build` reconstructs confirmed
workflow checkpoints from GitHub records and Git.

## Privacy and storage rules

1. Do not commit personal, secret, or customer data to this repository. Examples and fixtures use
   fictional data.
2. Treat installed caches and local environment files as rebuildable delivery state, not workflow
   authority.
3. Do not introduce a mandatory shared vault for retained plugins.
4. Active code and instructions must not import, execute, or depend on content below `archived/`.
5. Any future plugin-owned persistent storage must document its purpose, location, retention, and
   sensitivity in that plugin's own documentation.
