# github-mcp-server

An MCP server that gives Claude (or any MCP client) the ability to read and
write files in your GitHub repositories — so code can be pushed directly
without manual copy/paste.

## Tools

- **read_file** — read a file's contents (`owner`, `repo`, `path`, `ref?`)
- **list_directory** — list files/folders at a path (`owner`, `repo`, `path?`, `ref?`)
- **create_or_update_file** — create or update a file, committing directly to a branch (`owner`, `repo`, `path`, `content`, `message`, `branch?`)
- **delete_file** — delete a file (`owner`, `repo`, `path`, `message`, `branch?`)
- **list_branches** — list branches in a repo (`owner`, `repo`)
- **create_repo** — create a new repo under the authenticated account (`name`, `private?`, `description?`)

## Required configuration

Set **`GITHUB_TOKEN`** as an environment variable on the deployed server.

- Create a GitHub **Personal Access Token** (fine-grained, scoped to only
  the repositories you want this server to touch; grant "Contents:
  Read and write" and "Administration: Read and write" only if you need
  `create_repo`).
- Add it as an env var named `GITHUB_TOKEN` in the Manufact dashboard for
  this server (or pass it via the `env` parameter when deploying/updating
  the server). **Do not commit the token to this repo.**

The server will start without the token set, but every tool call will fail
until it's configured.

## Security notes

- Scope the token as narrowly as possible — ideally to a small set of repos,
  not your whole account.
- This server can write to and delete files in any repo the token can
  access. Treat it as you would any other agent with commit access.
- Rotate the token if you ever suspect it's been exposed.

## Running locally

```bash
export GITHUB_TOKEN=ghp_yourtokenhere
npm install
npm start
```

The server listens on `PORT` (default `8080`). MCP endpoint: `POST /mcp`.
Health check: `GET /health`.
