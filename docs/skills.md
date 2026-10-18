# Skills

[Back to the README](../README.md)

Skills teach the agent how your organization builds: a design system, a library you use, a checklist. A skill is a folder with a `SKILL.md` in the [Agent Skills](https://agentskills.io/specification) format (frontmatter `name` and `description`, then instructions) plus optional scripts, references and assets. There are two kinds, both under **Settings**:

- **My skills** (Account): each member's own.
- **Skills** (Organization): added by admins and used by every member's builds. Members can see them but not change them.

Add one by:

- **From GitHub**: a link to a repository, a folder, or a `SKILL.md`, for example `https://github.com/anthropics/skills/tree/main/skills/frontend-design`. A link holding several skills imports all of them; importing again (or **Update**) refreshes it. With GitHub connected under Settings, imports use the organization's token, so private repositories in the organization work too.
- **Upload**: a `SKILL.md`, any Markdown file with that frontmatter, or a `.zip`/`.skill` of one or more skill folders.
- **Write**: paste or type a `SKILL.md` in the browser.

When someone sends the agent a message, the platform copies their enabled skills and the organization's enabled skills into the sandbox (`/root/.agency/skills`, outside the app's code) and starts pi with `--skill` for each; a member's own skill replaces an organization skill with the same name. pi lists them to the model by name and description and loads one when the task calls for it. Typing `/skill:name` in the chat forces one. If the next message comes from a member with a different set, the idle agent restarts with theirs, keeping the conversation.
