# Contributing to AgilFrame

[Русский](CONTRIBUTING.md) · **English**

For setup instructions, see the [project documentation](https://github.com/GillHD/agilframe-core/blob/main/docs/README.md). Use the [issue forms](https://github.com/GillHD/agilframe-nodes/issues/new/choose) for bugs and feature requests. Report potential vulnerabilities privately. [Security policy](SECURITY.en.md)

## Issues

- Open one issue per outcome. Name the component and describe the observed problem or requested result in the title.
- For a bug, include the version or commit SHA, environment, user roles, steps through the supported interface, and expected and actual behavior. For interface bugs, add the theme, viewport width, and a redacted screenshot. For multi-node issues, describe the topology.
- For a proposal, describe the user, their task, the intended result, and the acceptance criteria. For API changes, describe compatibility and any migration needed.
- Remove tokens, keys, personal data, private URLs, and company call content from attachments.

## Code

1. Create a short-lived branch from the latest `main`. Keep each pull request focused on a single change.
2. Reuse existing interfaces, permission checks, and components. Check that REST, WebSocket, and configuration changes work with the current SDK and previously stored data.
3. Add a regression test when existing tests miss the issue. Document changes to user workflows. Keep build artifacts, caches, and personal tool settings in your local environment.
4. Commit under your GitHub account with a verified email address or your GitHub noreply address. Use the commit subject to describe the change. Explain the reason for a technical decision in the commit body or pull request.

See the [README](README.en.md) for this component's verification commands. List the checks you ran. For browser changes, include the test scenario and evidence of the result. Explain any skipped check that affects acceptance.

## AI-assisted changes

If an AI tool wrote or rewrote a substantial part of the change, identify the affected module and the checks you ran in the pull request. Pull request authors must personally review the entire diff, including tests and configuration, for correctness, security, licensing, error handling, and compatibility. Authors remain responsible for their changes and should be able to explain them during review. Follow the project’s human review process for changes with significant consequences.

## Pull requests and review

- Explain why the change is needed, what users will see, and how you verified it. Use `Fixes #123` when the pull request fully resolves the issue. Mark work in progress as a draft.
- Discuss changes to authorization, data schemas, public APIs, or licensing with the maintainer first. Document compatibility, the upgrade and rollback procedures, and any limitations.
- Reviewers check the expected behavior, access boundaries, backward compatibility, and tests. Resolve blocking feedback and pass the relevant CI checks before merging. Obtain human review for changes that require it.
- Submit only material you have the right to contribute. See the [license](LICENSE) and [notices](NOTICE). The maintainer checks the necessary rights before commercially relicensing an external contribution.
