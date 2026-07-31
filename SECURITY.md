# Security Policy

## Supported versions

There are no released or supported product versions. Repository documentation
and automation on `main` receive security fixes as needed.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, pull
request, commit message, or sample.

Use a private GitHub Security Advisory for this repository when that option is
available. If it is not available, contact the repository owner through a
previously established private channel and request a secure reporting path.
Do not include exploit details or sensitive data until that path is confirmed.

Include:

- The affected file, commit, or future version.
- Reproduction steps using synthetic data.
- Expected and observed behavior.
- Potential impact and known mitigations.

The repository does not currently publish response-time commitments. A
maintainer should acknowledge receipt, coordinate disclosure, and document the
remediation before a supported release is created.

## Sensitive data

- Never commit credentials, access tokens, private keys, customer data, private
  prompts, or sensitive model outputs.
- Use clearly fake values in documentation and tests.
- Remove secrets from history and rotate them immediately if exposure occurs;
  deleting only the latest file is not sufficient.
- Treat prompts, retrieved content, tool output, logs, and generated content as
  untrusted until the product's data boundary and threat model are defined.
