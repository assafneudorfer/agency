# Running Agency for a team

[Back to the README](../README.md)

What admins set up, and how members share the apps they build.

## Settings

Everything that isn't an app lives under **Settings**, grouped like most workspace tools: **Account** (My skills, Usage) and **Organization** (Connections, Skills, and for admins Team, Single sign-on, GitHub). On a phone, Settings opens as a list of sections. Old links such as `#/connections` still work.

## Sharing apps

Every app has an owner (whoever created it); admins can do everything with every app. In the builder's **Share** sheet the owner picks what the rest of the team gets (nothing, view, or edit) and adds people as viewers or editors:

- **Viewer**: opens the preview and the published app, and reads the builder (chat, code, data) without changing anything.
- **Editor**: also chats with the agent, edits code and preview data, restores versions and publishes.
- **Owner and admins**: also change live data, sharing and delete the app.

New apps start as view-only for the team; apps created before sharing existed stay editable by everyone. Traefik's sign-in check enforces the same rules on `<app>.<domain>` and `<app>-preview.<domain>`, and passes the role to apps as `X-Agency-App-Role` (`currentUser().appRole`).

## Usage and budgets

The cost of every message the agent writes (tokens at the model's list price) is charged to the member who sent the prompt. Each member has a monthly budget in US dollars, or is unlimited; when it is used up, new prompts are refused until an admin raises it or the month resets on the 1st (a step already running still finishes). Everyone sees their spend under **Settings > Usage** and in the sidebar; admins set budgets under **Settings > Team**. New members get `AGENCY_DEFAULT_BUDGET_USD` (20 by default).

## Single sign-on

Under **Settings**, an admin connects the organization's identity provider over OpenID Connect (Google Workspace, Microsoft Entra ID, Okta, or any other): issuer URL, client ID and secret, and the email domains that may sign in. Register `https://<your-domain>/auth/sso/callback` as the redirect URI. Only people whose verified email is in an allowed domain get in; they join as members on their first sign-in, with the default budget. Password sign-in can stay on for admins only, as a way in if the provider is down. The same session covers previews and published apps.

## GitHub

Under **Settings**, an organization owner enters the organization's name and clicks **Connect GitHub**. Agency sends them to GitHub with a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest); they confirm creating a private app in the organization (permissions: Contents and Administration write, Metadata read), then confirm installing it, and land back in Settings connected. Nothing is copied by hand. The app's private key is stored encrypted, and pushes use installation tokens that expire after an hour; which repositories the app can use is chosen in its installation settings on GitHub. **Disconnect** uninstalls it; an owner can then delete the app on GitHub. GitHub Enterprise Server works with its address. A token (fine-grained, owned by the organization, with Contents and Administration read and write) still works instead, under **Use a token instead**, and is the way to use a personal account.

Once GitHub is connected, every new app gets its own repository in the organization (private, named after the app, with -2, -3, ... when the name is taken) and pushes each version automatically. An admin can turn that off, or make new repositories public, under **Settings**.

In the builder, the **GitHub** button links an app to a new private repository or an existing one and pushes its version history; it can push every new version automatically. Credentials stay in the platform: the app's history is copied out of the sandbox as a git bundle and pushed from the platform container. A branch with commits made outside Agency is not overwritten unless someone chooses **Overwrite**.
