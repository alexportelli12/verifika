# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/alexportelli12/verifika/security/advisories/new). Do not open a public issue. You can expect an initial response within a week.

## Trust model

- `verifika.config.json` is trusted input, like `package.json` scripts: its commands run through your shell with your permissions. Review changes to it with the same care as code. Running Verifika in a repository you do not trust runs that repository's commands.
- Everything else is untrusted: file names, git refs and branch names are never interpolated into shell commands. Git is invoked with argument arrays, and refs that look like options are rejected.
- Check output is written to `.verifika/runs/` on the local disk. It may contain secrets your tools print. Verifika never uploads or transmits it; it is ignored by git automatically and pruned after `defaults.keepRuns` runs.
- Verifika passes its own environment to checks unchanged (plus `VERIFIKA*` variables). It does not read, store or log environment variables.
