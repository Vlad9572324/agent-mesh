# Reporting security concerns

Do not submit vulnerability details through ordinary public issues.
Do not include live credentials, private project content,
database dumps, or raw exploit logs in an issue or pull request.

If this repository's **Security** tab offers **Report a vulnerability**, use that
private form. Its availability depends on the repository's settings; this policy
does not imply that GitHub private vulnerability reporting is enabled.

Otherwise, contact maintainer
[@Vlad9572324](https://github.com/Vlad9572324) through an existing authorized
private channel. The profile identifies the maintainer; it is not a private
message inbox. If you do not already have a private route, arrange one with the
maintainer before sending sensitive details. Do not use a public issue to publish
the finding while arranging contact.

In the agreed private channel, describe the affected version/source commit,
component, prerequisites, potential impact, and a minimal reproduction using
synthetic data. Do not send live service/provider keys or TLS private keys.
If a credential was exposed, coordinate explicit revocation or rotation with
its owner; deleting the report does not undo disclosure.

Agent Mesh is a prerelease trusted-LAN pilot, not an audited or certified
public-Internet service. See the [security and trust boundaries](docs/security.md)
for current protections and limitations. There is no guaranteed response or fix
timeline. For non-sensitive defects and setup problems, see [support](SUPPORT.md).
