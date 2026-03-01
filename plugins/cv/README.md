# CV

A Claude Code plugin that generates, adapts, and updates professional CVs from structured data. Your CV content lives in a single JSON file, and the plugin handles formatting, tailoring for job postings, and output in Markdown or HTML.

## What it does

- **Generate** a CV from your master data file (`cv_data.json`) in Markdown or HTML format
- **Adapt** your CV for a specific job posting — reorders experience, emphasizes matching skills, adjusts the summary while keeping everything truthful
- **Update** your master data — add new roles, skills, certifications, or edit existing entries

All data is stored locally in `~/.roxabi-vault/cv/`. Nothing leaves your machine.

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install cv
```

### Dependencies

The generation script requires Jinja2:

```bash
pip install jinja2
```

## Usage

### First-time setup

Run the init skill to create the data directory and starter template:

- `cv-init`
- `init cv`
- `setup cv`

This creates `~/.roxabi-vault/cv/` with a template `cv_data.json` you can fill in with your information.

### Generate a CV

- `cv` or `generate cv` — generates from your data using the default format (Markdown)
- `generate cv html` — generates in HTML format

Output goes to `~/.roxabi-vault/cv/generated/`.

### Adapt for a job posting

- `adapt cv for [company/role]` — paste or link a job description, and the plugin tailors your CV
- `tailor cv` — same thing, the plugin will ask for the job details

Adapted CVs go to `~/.roxabi-vault/cv/adapted/` with the company name and date in the filename.

### Update your data

- `update cv` — interactively edit your master CV data
- `add experience to cv` — add a new role
- `update cv skills` — modify skills sections

## How it works

### Data structure

Your CV data lives in a single JSON file with these sections:

- `personal` — name, title, contact info, summary
- `experience` — work history with highlights
- `education` — degrees and institutions
- `skills` — grouped by category (languages, frameworks, tools, etc.)
- `languages` — spoken languages and proficiency
- `certifications` — professional certifications

See `examples/cv_data.example.json` for the full structure.

### Templates

The plugin includes Jinja2 templates for Markdown and HTML output. Templates are generic and professional — no personal branding. You can customize them by editing the files in the `templates/` directory.

### Vault integration

If the Roxabi vault plugin is installed, generated and adapted CVs are automatically indexed for search. This is optional — the CV plugin works independently.

## File layout

```
~/.roxabi-vault/
  cv/
    cv_data.json          # your master CV data
    generated/            # generated CVs
    adapted/              # job-adapted CVs
  config/
    cv.json               # plugin config
```

## License

MIT
